import { log } from "./log.ts";

// Download with a bounded retry: reads are idempotent GETs, so one retry is
// safe (unlike sends, which have no dedup key at the Spectrum layer).
export async function downloadWithRetry(
  read: () => Promise<Uint8Array>,
  what: string,
  timeoutMs = 120_000,
  attempts = 2,
): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("download timeout")), timeoutMs)),
      ]);
    } catch (e) {
      lastErr = e;
      log(`download ${what} attempt ${i}/${attempts} failed: ${String(e).slice(0, 120)}`);
    }
  }
  throw lastErr;
}
