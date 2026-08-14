/**
 * T4 — ERC-7683 solver/filler kit.
 *
 * A reference filler for Tenzro's ERC-7683 cross-chain intent settler. It
 * scans the origin-side order book (`tenzro_list7683Orders` / `get7683Order`),
 * applies a pluggable fill policy, dispatches destination delivery through a
 * pluggable `FillExecutor` (the operator's threshold-signed path across the
 * six EVM bridge adapters — LayerZero, CCIP, deBridge, LI.FI, Wormhole,
 * CCT-CCIP), and commits the proof of fill back to the node via
 * `tenzro_recordFill7683`.
 *
 * The kit holds **no keys**: destination execution is delegated to the
 * `FillExecutor` the operator supplies (e.g. one wired to the node's DKLS23
 * threshold signer). Order discovery, policy evaluation, and fill recording
 * are the kit's job; how value actually moves on the destination chain is the
 * executor's. This keeps the kit safe to run anywhere while letting the
 * operator keep custody of the signing path.
 *
 * Order state machine (origin side): Open → AwaitingProof → Settled /
 * Refunded / ForceRefundEligible.
 */

import { RpcClient, Erc7683Client, type Erc7683Output } from "tenzro-sdk";

/** A persisted Tenzro7683Order as projected by the node, plus its id. */
export interface OpenOrder {
  /** 32-byte order id (hex). */
  orderId: string;
  /** Raw node JSON envelope (`tenzro_7683_order_to_json` projection). */
  envelope: Record<string, unknown>;
}

/** One of the bridge proof routes the node accepts on `recordFill`. */
export type ProofRoute = "layerzero" | "wormhole" | "debridge" | "hyperlane";

/** What the policy decides to do with a candidate order. */
export interface FillDecision {
  /** Whether to fill this order. */
  fill: boolean;
  /** Proof route to record the fill under (required when `fill`). */
  proofRoute?: ProofRoute;
  /** Human-readable reason (for logs / audit). */
  reason: string;
}

/** A pluggable policy deciding whether an order is worth filling. */
export interface FillPolicy {
  evaluate(order: OpenOrder): FillDecision | Promise<FillDecision>;
}

/**
 * The result of executing destination delivery for an order. The executor is
 * responsible for moving value on the destination chain; it returns the proof
 * the kit records back to the node.
 */
export interface FillExecution {
  /** Destination-chain fill transaction hash. */
  fillTxHash: string;
  /** 32-byte filler address (hex). */
  filler: string;
  /** 32-byte recipient address actually paid (hex). */
  recipient: string;
  /** Outputs delivered on the destination chain. */
  outputs: Erc7683Output[];
  /** Unix ms when the fill landed. */
  filledAtMs: number;
}

/**
 * Executes destination delivery for an order. The operator supplies this —
 * it owns the threshold-signing path and the bridge-adapter calls. The kit
 * never sees private key material.
 */
export interface FillExecutor {
  execute(order: OpenOrder, decision: FillDecision): Promise<FillExecution>;
}

/**
 * Default policy: decline everything with a clear reason. Operators subclass
 * or replace this with real margin/route logic. Shipping a deny-by-default
 * policy keeps a misconfigured filler from blindly committing fills.
 */
export class DenyAllPolicy implements FillPolicy {
  evaluate(_order: OpenOrder): FillDecision {
    return { fill: false, reason: "DenyAllPolicy: no fill policy configured" };
  }
}

export interface FillerConfig {
  /** Tenzro JSON-RPC endpoint. */
  endpoint?: string;
  /** Per-request RPC timeout in ms. */
  timeoutMs?: number;
  /** Fill policy (default: deny all). */
  policy?: FillPolicy;
  /** Destination executor (required to actually fill). */
  executor?: FillExecutor;
  /** Max orders to scan per poll (default 50). */
  scanLimit?: number;
}

/** Outcome of processing a single order during a sweep. */
export interface FillOutcome {
  orderId: string;
  action: "filled" | "skipped" | "error";
  reason: string;
  fillTxHash?: string;
}

/**
 * The reference filler. Construct with an endpoint + policy + executor, then
 * call `sweepOnce()` on your own cadence (or `discoverFillable()` to inspect
 * the order book read-only).
 */
export class Erc7683Filler {
  private readonly client: Erc7683Client;
  private readonly policy: FillPolicy;
  private readonly executor?: FillExecutor;
  private readonly scanLimit: number;

  constructor(cfg: FillerConfig = {}) {
    const rpc = new RpcClient(
      cfg.endpoint ?? "https://rpc.tenzro.xyz",
      undefined,
      cfg.timeoutMs ?? 30_000,
    );
    this.client = new Erc7683Client(rpc);
    this.policy = cfg.policy ?? new DenyAllPolicy();
    this.executor = cfg.executor;
    this.scanLimit = cfg.scanLimit ?? 50;
  }

  /** The underlying SDK client, for read-only access to fills/orders. */
  rpcClient(): Erc7683Client {
    return this.client;
  }

  /**
   * Read-only: list fillable orders (state `open`) and project each into an
   * `OpenOrder` with its id extracted from the node envelope.
   */
  async discoverFillable(): Promise<OpenOrder[]> {
    const list = await this.client.listOrders({
      state: "open",
      limit: this.scanLimit,
    });
    return list.orders.map((raw) => this.toOpenOrder(raw));
  }

  /**
   * One sweep: discover open orders, evaluate each against the policy, and for
   * those approved, execute destination delivery and record the fill. Returns
   * a per-order outcome list. Never throws on a single-order failure — it is
   * recorded as an `error` outcome and the sweep continues.
   */
  async sweepOnce(): Promise<FillOutcome[]> {
    const orders = await this.discoverFillable();
    const outcomes: FillOutcome[] = [];
    for (const order of orders) {
      outcomes.push(await this.processOrder(order));
    }
    return outcomes;
  }

  private async processOrder(order: OpenOrder): Promise<FillOutcome> {
    let decision: FillDecision;
    try {
      decision = await this.policy.evaluate(order);
    } catch (e) {
      return {
        orderId: order.orderId,
        action: "error",
        reason: `policy error: ${msg(e)}`,
      };
    }

    if (!decision.fill) {
      return { orderId: order.orderId, action: "skipped", reason: decision.reason };
    }
    if (!decision.proofRoute) {
      return {
        orderId: order.orderId,
        action: "error",
        reason: "policy approved fill but supplied no proofRoute",
      };
    }
    if (!this.executor) {
      return {
        orderId: order.orderId,
        action: "error",
        reason: "policy approved fill but no FillExecutor configured",
      };
    }

    try {
      const exec = await this.executor.execute(order, decision);
      const originChainId = this.originChainId(order);
      const originSettler = this.originSettler(order);
      await this.client.recordFill({
        orderId: order.orderId,
        originChainId,
        originSettler,
        filler: exec.filler,
        recipient: exec.recipient,
        fillTxHash: exec.fillTxHash,
        filledAtMs: exec.filledAtMs,
        proofRoute: decision.proofRoute,
        outputs: exec.outputs,
      });
      return {
        orderId: order.orderId,
        action: "filled",
        reason: decision.reason,
        fillTxHash: exec.fillTxHash,
      };
    } catch (e) {
      return {
        orderId: order.orderId,
        action: "error",
        reason: `fill/record error: ${msg(e)}`,
      };
    }
  }

  private toOpenOrder(raw: unknown): OpenOrder {
    const env = (raw ?? {}) as Record<string, unknown>;
    const orderId = String(
      env.order_id ?? env.orderId ?? env.id ?? "",
    );
    return { orderId, envelope: env };
  }

  private originChainId(order: OpenOrder): number {
    const v = order.envelope.origin_chain_id ?? order.envelope.originChainId;
    return Number(v ?? 0);
  }

  private originSettler(order: OpenOrder): string {
    return String(
      order.envelope.origin_settler ?? order.envelope.originSettler ?? "",
    );
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
