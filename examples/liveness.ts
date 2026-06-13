/**
 * T4 liveness — read-only check against live Tenzro infra.
 *
 * Confirms the origin-side order book and destination-side fill registry are
 * reachable: lists orders in each state and the recorded fills, exercising the
 * exact read RPCs the filler depends on without executing any delivery.
 *
 * Run: npm run liveness
 */

import { RpcClient, Erc7683Client } from "tenzro-sdk";

async function main() {
  const endpoint = process.env.TENZRO_RPC ?? "https://rpc.tenzro.network";
  const rpc = new RpcClient(endpoint, undefined, 30_000);
  const client = new Erc7683Client(rpc);

  const states = ["open", "awaiting_proof", "settled", "refunded"];
  for (const state of states) {
    try {
      const list = await client.listOrders({ state, limit: 10 });
      console.log(`orders[${state}]: count=${list.count}`);
    } catch (e) {
      console.log(`orders[${state}]:`, e instanceof Error ? e.message : e);
    }
  }

  try {
    const fills = await client.listFills();
    console.log("fills:", JSON.stringify(fills));
  } catch (e) {
    console.log("fills:", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
