# tenzro-intent-filler

A **reference solver/filler** for Tenzro's ERC-7683 cross-chain intent settler.
It does the three jobs a filler must do — **discover** open orders on the
origin side, **decide** which are worth filling, and **record** the proof of
fill on the destination side — while leaving the one job that needs custody,
**moving value on the destination chain**, to a pluggable executor the operator
wires to their own threshold-signed path across the six EVM bridge adapters
(LayerZero, CCIP, deBridge, LI.FI, Wormhole, CCT-CCIP).

The kit **holds no keys.** It is safe to run anywhere; the `FillExecutor` you
supply owns the signing path.

Order state machine (origin side): `Open → AwaitingProof → Settled / Refunded /
ForceRefundEligible`.

## Install & build

```bash
npm install
npm run build
```

## Use it

```ts
import {
  Erc7683Filler,
  type FillPolicy,
  type FillDecision,
  type FillExecutor,
  type FillExecution,
  type OpenOrder,
} from "tenzro-intent-filler";

// 1. A policy decides whether (and how) to fill.
class MarginPolicy implements FillPolicy {
  evaluate(order: OpenOrder): FillDecision {
    // inspect order.envelope (amounts, dest chain, deadline) and your margins
    return { fill: true, proofRoute: "layerzero", reason: "margin ok" };
  }
}

// 2. An executor moves value on the destination chain and returns the proof.
//    Wire this to the node's threshold signer + bridge adapters.
class ThresholdExecutor implements FillExecutor {
  async execute(order: OpenOrder, d: FillDecision): Promise<FillExecution> {
    // ... bridge-adapter call signed by your DKLS23 threshold signer ...
    return {
      fillTxHash: "0x…",
      filler: "0x…",
      recipient: "0x…",
      outputs: [],
      filledAtMs: Date.now(),
    };
  }
}

const filler = new Erc7683Filler({
  endpoint: "https://rpc.tenzro.network",
  policy: new MarginPolicy(),
  executor: new ThresholdExecutor(),
});

// Run on your own cadence:
const outcomes = await filler.sweepOnce();
```

### Safety defaults

- The default policy is `DenyAllPolicy` — a filler with no configured policy
  fills nothing.
- A policy that approves a fill but supplies no `proofRoute`, or runs with no
  `FillExecutor`, yields an `error` outcome rather than a silent no-op.
- `sweepOnce()` never throws on a single-order failure; each order's result is
  reported independently so one bad order can't stall the sweep.

## Demo

```bash
npm run demo
```

Runs a dry-run sweep against the live order book: an allow-list policy plus an
executor that *simulates* delivery (no value moves, no keys touched), so you can
watch the discover → decide → (simulated) fill loop end-to-end.

## Liveness (read-only, against live infra)

```bash
npm run liveness
```

Lists orders in each state (`open`, `awaiting_proof`, `settled`, `refunded`) and
the recorded fills — the exact read RPCs the filler depends on.

## Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `TENZRO_RPC` | `https://rpc.tenzro.network` | Tenzro JSON-RPC endpoint |

## Notes

- Destination execution is intentionally out of scope for the kit — it is the
  operator's threshold-signed path. The kit's contract with the node is purely
  the origin read RPCs (`tenzro_list7683Orders` / `tenzro_get7683Order`) and the
  destination write RPC (`tenzro_recordFill7683`, idempotency-guarded per
  `(order_id, origin_chain_id)`).
