import { log } from "./log.ts";

// One FIFO per lane (a lane = one person). Jobs in a lane run one at a time,
// because two concurrent resumes of the same session would fork the thread.
// Different people's lanes run in parallel: their sessions and logs are separate.
const lanes = new Map<string, (() => Promise<unknown>)[]>();

export const enqueueJob = (lane: string, j: () => Promise<unknown>) => {
  const q = lanes.get(lane);
  if (q) {
    q.push(j);
    return;
  }
  lanes.set(lane, [j]);
  void drain(lane);
};

async function drain(lane: string) {
  const q = lanes.get(lane)!;
  while (q.length) {
    try {
      await q[0]!();
    } catch (e) {
      log(`job error [${lane}]: ${String(e).slice(0, 300)}`);
    }
    q.shift();
  }
  lanes.delete(lane);
}
