// Replies Photon refused (e.g. "Daily send limit exceeded"), kept per person
// and retried with exponential backoff until sending works again. Persisted so
// a restart doesn't lose them. The bridge decides how to catch up (one reply →
// resend it; several → the coach writes one catch-up text).
import fs from "node:fs";
import path from "node:path";
import { DATA, localIso } from "../core/paths.ts";

const FILE = path.join(DATA, "outbox.json");
const BASE_MS = 60_000;
const CAP_MS = 15 * 60_000;
/** older than this, a catch-up is more confusing than useful */
const MAX_AGE_MS = 12 * 3600_000;

export type Undelivered = { at: string; text: string; files: string[] };
export type Pending = {
  chatGuid: string;
  replies: Undelivered[];
  attempts: number;
  nextAt: number;
  /** catch-up text already written for the first `covers` replies */
  draft?: { text: string; files: string[]; covers: number };
};

let box: Record<string, Pending> = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
})();

const persist = () => {
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(box, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
};

export const pendingFor = (id: string): Pending | undefined => box[id];

export function queue(id: string, chatGuid: string, text: string, files: string[]) {
  const p = (box[id] ??= { chatGuid, replies: [], attempts: 0, nextAt: Date.now() + BASE_MS });
  p.replies.push({ at: localIso(), text, files });
  persist();
}

/** A send just worked for this person: try the backlog now. */
export function sendingWorks(id: string) {
  const p = box[id];
  if (p && p.nextAt > Date.now()) {
    p.nextAt = Date.now();
    persist();
  }
}

export function backoff(id: string) {
  const p = box[id];
  if (!p) return;
  p.attempts++;
  p.nextAt = Date.now() + Math.min(BASE_MS * 2 ** p.attempts, CAP_MS);
  persist();
}

export function setDraft(id: string, draft: Pending["draft"]) {
  if (box[id]) {
    box[id].draft = draft;
    persist();
  }
}

/** Drop the first `n` replies (delivered or folded into a later reply). */
export function settle(id: string, n: number) {
  const p = box[id];
  if (!p) return;
  p.replies.splice(0, n);
  if (!p.replies.length) delete box[id];
  else {
    p.draft = undefined;
    p.attempts = 0;
  }
  persist();
}

/** People whose backlog is due for a retry; expired backlogs are dropped. */
export function due(): [string, Pending][] {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of Object.entries(box)) {
    const newest = Date.parse(p.replies.at(-1)?.at ?? "");
    if (!Number.isFinite(newest) || now - newest > MAX_AGE_MS) {
      delete box[id];
      changed = true;
    }
  }
  if (changed) persist();
  return Object.entries(box).filter(([, p]) => p.nextAt <= now);
}
