// Missed-message reconciliation via the low-level kit's history API
// (@photon-ai/advanced-imessage listRecent — docs: advanced-kits/imessage/messages).
// The live stream drops anything sent while no subscriber was connected and
// Photon does not replay; this sweep runs on every bridge start and pulls
// what landed after the persisted watermark, feeding it through the normal
// pipeline. Stream stays primary for latency; the sweep guarantees delivery.
import { createGrpcClient, type Message as KitMessage } from "@photon-ai/advanced-imessage";
import fs from "node:fs";
import path from "node:path";
import { DATA } from "../core/paths.ts";
import { log } from "./log.ts";

const WATERMARK = path.join(DATA, "watermark.json");
// shared-plan gRPC middleware — same default Spectrum's runtime uses
// (dedicated instances get `${instanceId}.imsg.photon.codes:443` instead)
const IMSG_ADDRESS =
  process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";
const SEEN_CAP = 300;

type Watermark = { since: string; seen: string[] };

function load(): Watermark {
  if (fs.existsSync(WATERMARK))
    return JSON.parse(fs.readFileSync(WATERMARK, "utf8"));
  // first deploy: start NOW — never replay history that predates the watermark
  const fresh: Watermark = { since: new Date().toISOString(), seen: [] };
  fs.writeFileSync(WATERMARK, JSON.stringify(fresh, null, 2));
  return fresh;
}
const wm = load();
const seen = new Set(wm.seen);

function save() {
  wm.seen = [...seen].slice(-SEEN_CAP);
  fs.writeFileSync(WATERMARK, JSON.stringify(wm, null, 2));
}

/** Record a processed inbound message (stream or sweep) and advance the watermark. */
export function markProcessed(id: string, ts: Date | undefined) {
  if (id) seen.add(id);
  const t = ts?.toISOString();
  if (t && t > wm.since) wm.since = t;
  save();
}

export function alreadyProcessed(id: string): boolean {
  return seen.has(id);
}

// Token mint: POST /projects/{id}/imessage/tokens with Basic project creds
// (Spectrum API OpenAPI: spectrum.photon.codes). Shared plan returns
// { type: "shared", token, expiresIn }.
export async function mintSharedToken(): Promise<string> {
  const id = process.env.PROJECT_ID!;
  const secret = process.env.PROJECT_SECRET!;
  const res = await fetch(
    `https://spectrum.photon.codes/projects/${id}/imessage/tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      },
    },
  );
  if (!res.ok) throw new Error(`token mint failed: ${res.status}`);
  // response envelope: { succeed, data: { type, token, expiresIn } } (verified live 2026-08-23)
  const body = (await res.json()) as {
    succeed?: boolean;
    data?: { type?: string; token?: string };
  };
  const data = body.data ?? {};
  if (data.type !== "shared" || !data.token)
    throw new Error(`unexpected token response type=${data.type}`);
  return data.token;
}

/**
 * Pull inbound messages created after the watermark from the given chats
 * (the shared proxy routes per chat guid — cross-chat listRecent cannot
 * route, verified live 2026-08-23) and hand each unseen one to `onMessage`,
 * oldest first. Marks each handled message processed.
 */
export async function sweepMissed(
  chatGuids: string[],
  onMessage: (m: KitMessage) => Promise<boolean>,
): Promise<number> {
  const after = new Date(wm.since);
  const token = await mintSharedToken();
  const client = createGrpcClient({
    address: IMSG_ADDRESS,
    token,
    tls: true,
    retry: true,
  });
  let handled = 0;
  try {
    const missed: KitMessage[] = [];
    for (const chat of chatGuids) {
      try {
        let pageToken: string | undefined;
        do {
          const page = await client.messages.listInChat(chat, {
            after,
            isFromMe: false,
            pageSize: 50,
            ...(pageToken ? { pageToken } : {}),
          });
          for (const m of page.messages) {
            if (!m.guid || seen.has(m.guid)) continue;
            if (m.isFromMe || m.isSystemMessage || m.isServiceMessage)
              continue;
            missed.push(m);
          }
          pageToken = page.nextPageToken || undefined;
        } while (pageToken);
      } catch (e) {
        log(
          `sweep: listInChat(${chat.slice(0, 20)}) failed: ${String(e).slice(0, 120)}`,
        );
      }
    }
    missed.sort(
      (a, b) => a.dateCreated.getTime() - b.dateCreated.getTime(),
    );
    for (const m of missed) {
      try {
        // handler returns false to decline (e.g. message is the live stream's
        // to own) — declined messages stay unmarked so a future sweep can
        // still recover them if the stream never delivers.
        if (await onMessage(m)) {
          handled++;
          markProcessed(m.guid, m.dateCreated);
        }
      } catch (e) {
        log(
          `sweep handler failed for ${m.guid.slice(0, 12)}: ${String(e).slice(0, 140)}`,
        );
      }
    }
  } finally {
    await client.close().catch(() => {});
  }
  return handled;
}
