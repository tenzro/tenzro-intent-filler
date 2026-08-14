/**
 * T4 demo — a reference filler with a simple margin policy and a dry-run
 * executor.
 *
 * This wires a policy that approves orders whose destination is a chain the
 * filler supports, and an executor that *simulates* destination delivery
 * (no real bridge call, no signing) so the loop can be exercised end-to-end
 * without custody. Swap `DryRunExecutor` for one wired to the node's threshold
 * signer + bridge adapters to go live.
 *
 * Run: npm run demo
 */

import {
  Erc7683Filler,
  type FillPolicy,
  type FillDecision,
  type FillExecutor,
  type FillExecution,
  type OpenOrder,
} from "../src/index.js";

/** Approve fills to a small allow-list of destination chains. */
class AllowedChainsPolicy implements FillPolicy {
  constructor(private readonly allowed: Set<number>) {}
  evaluate(order: OpenOrder): FillDecision {
    const dest = Number(
      order.envelope.dest_chain_id ?? order.envelope.destChainId ?? 0,
    );
    if (this.allowed.has(dest)) {
      return { fill: true, proofRoute: "layerzero", reason: `dest ${dest} allowed` };
    }
    return { fill: false, reason: `dest ${dest} not in allow-list` };
  }
}

/** Simulate destination delivery — no real value moves, no keys touched. */
class DryRunExecutor implements FillExecutor {
  async execute(order: OpenOrder, _d: FillDecision): Promise<FillExecution> {
    return {
      fillTxHash: "0x" + "00".repeat(32),
      filler: "0x" + "11".repeat(32),
      recipient: "0x" + "22".repeat(32),
      outputs: [],
      filledAtMs: Date.now(),
    };
  }
}

async function main() {
  const endpoint = process.env.TENZRO_RPC ?? "https://rpc.tenzro.xyz";
  const filler = new Erc7683Filler({
    endpoint,
    policy: new AllowedChainsPolicy(new Set([1, 8453, 0x10ed21])),
    executor: new DryRunExecutor(),
  });

  const open = await filler.discoverFillable();
  console.log(`open orders: ${open.length}`);
  for (const o of open) {
    console.log(`  ${o.orderId}`);
  }

  console.log("\nDRY-RUN sweep (executor simulates delivery, no value moves):");
  const outcomes = await filler.sweepOnce();
  if (outcomes.length === 0) {
    console.log("  no open orders to process");
  }
  for (const r of outcomes) {
    console.log(
      `  ${r.action.padEnd(8)} ${r.orderId || "(no id)"}  ${r.reason}` +
        (r.fillTxHash ? `  tx=${r.fillTxHash}` : ""),
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
