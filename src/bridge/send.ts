// Fallback reliable send via the low-level kit: sendText with a stable
// clientMessageId (idempotent at the kit layer) + client-level retry.
// Used when Spectrum's space.send errors — its at-least-once semantics mean
// the original MAY have delivered, so a fallback can duplicate; after a
// confirmed lost reply (2026-08-24, "I don't see the playbook") twice beats
// never.
import { createGrpcClient } from "@photon-ai/advanced-imessage";
import { createHash } from "node:crypto";
import { log } from "./log.ts";
import { mintSharedToken } from "./reconcile.ts";

const IMSG_ADDRESS =
  process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";

export async function fallbackSendText(
  chatGuid: string,
  body: string,
): Promise<boolean> {
  try {
    const token = await mintSharedToken();
    const client = createGrpcClient({
      address: IMSG_ADDRESS,
      token,
      tls: true,
      retry: true,
    });
    try {
      const clientMessageId = createHash("sha256")
        .update(`${chatGuid}|${body}`)
        .digest("hex")
        .slice(0, 32);
      await client.messages.sendText(chatGuid, body, { clientMessageId });
      log(`fallback send ok -> ${chatGuid.slice(0, 20)}`);
      return true;
    } finally {
      await client.close().catch(() => {});
    }
  } catch (e) {
    log(`fallback send failed: ${String(e).slice(0, 140)}`);
    return false;
  }
}
