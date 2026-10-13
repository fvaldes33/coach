// coach-bridge daemon: iMessage (Spectrum/Photon) → nutrition coach.
// Debounce bursts into one turn, 👀 ack,
// one FIFO worker (Claude Code or Codex) resuming a single long session,
// missed-message sweep on boot, exit-for-relaunch on stream failure.
// Added here: Jev intent routing and a deterministic dashboard fast path.
import fs from "node:fs";
import path from "node:path";
import { Spectrum, attachment, text, type Message, type Space } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { isImage, scanImage, toJpegIfNeeded } from "./core/barcode.ts";
import { memoryPath, memoryText } from "./core/memory.ts";
import type { Nudge } from "./core/nudges.ts";
import { REPO, inboxFor, localIso, profileDir } from "./core/paths.ts";
import { coachCli } from "./bridge/coachcli.ts";
import { downloadWithRetry } from "./bridge/download.ts";
import { enqueueJob } from "./bridge/jobs.ts";
import { isGroupSpace, makeAllowlist, type Operator } from "./bridge/allowlist.ts";
import { log } from "./bridge/log.ts";
import { startNudger } from "./bridge/nudger.ts";
import * as outbox from "./bridge/outbox.ts";
import { alreadyProcessed, markProcessed, sweepMissed } from "./bridge/reconcile.ts";
import { route } from "./bridge/router.ts";
import { fallbackSendText } from "./bridge/send.ts";
import { clearSession, getSession, setSession } from "./bridge/sessions.ts";
import { WORKER_NAME, runWorker, type WorkerRun } from "./bridge/worker.ts";

const CONFIG = path.join(REPO, "config.json");
if (!fs.existsSync(CONFIG)) {
  console.error("config.json missing: copy config.example.json and set your iMessage handle");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8")) as { operators?: Operator[] };
const DEBOUNCE_MS = Number(process.env.COACH_DEBOUNCE_MS ?? 5000);

const findOperator = makeAllowlist(cfg.operators ?? []);
for (const o of cfg.operators ?? []) fs.mkdirSync(path.join(profileDir(o.id), "out"), { recursive: true });

// ---- per-space debounce batches: a photo + "this was lunch" is one turn ----
type Batch = { texts: string[]; files: string[]; timer: ReturnType<typeof setTimeout> | null; space: Space; op: Operator };
const batches = new Map<string, Batch>();
let fileSeq = 0;

function ensureBatch(spaceId: string, space: Space, op: Operator, ack?: () => void): Batch {
  if (!batches.has(spaceId)) {
    batches.set(spaceId, { texts: [], files: [], timer: null, space, op });
    // delivery receipt: no 👀 within ~10s means the send never reached us
    ack?.();
  }
  return batches.get(spaceId)!;
}

function saveMedia(op: Operator, name: string, bytes: Uint8Array): string {
  const inbox = inboxFor(op.id);
  fs.mkdirSync(inbox, { recursive: true });
  const dest = path.join(inbox, `${Date.now()}-${fileSeq++}-${name.replace(/[^\w.-]+/g, "_")}`);
  fs.writeFileSync(dest, Buffer.from(bytes));
  return toJpegIfNeeded(dest);
}

async function bufferContent(
  spaceId: string,
  space: Space,
  op: Operator,
  ack: (() => void) | undefined,
  c: Message["content"],
  deferFlush = false,
): Promise<boolean> {
  if (c.type === "attachment" || c.type === "voice") {
    const bytes = await downloadWithRetry(() => c.read(), c.name ?? "file");
    const file = saveMedia(op, c.name ?? "file", bytes);
    log(`buffered attachment ${path.basename(file)}`);
    ensureBatch(spaceId, space, op, ack).files.push(file);
    if (!deferFlush) scheduleFlush(spaceId);
    return true;
  }
  if (c.type === "text") {
    log(`buffered text: ${c.text.slice(0, 80)}`);
    ensureBatch(spaceId, space, op, ack).texts.push(c.text.trim());
    if (!deferFlush) scheduleFlush(spaceId);
    return true;
  }
  return false;
}

function scheduleFlush(spaceId: string) {
  const b = batches.get(spaceId)!;
  if (b.timer) clearTimeout(b.timer); // burst continues → reset window
  b.timer = setTimeout(() => void flush(spaceId), DEBOUNCE_MS);
}

/** REPLY: may span lines up to the first FILE: line. */
function parseWorkerOutput(out: string): { reply: string; files: string[] } {
  const files = [...out.matchAll(/^FILE:\s*(.+)$/gm)].map((m) => m[1]!.trim());
  const at = out.search(/^REPLY:/m);
  let reply: string;
  if (at >= 0) {
    reply = out.slice(at).replace(/^REPLY:\s*/, "");
    const fileAt = reply.search(/^FILE:/m);
    if (fileAt >= 0) reply = reply.slice(0, fileAt);
  } else {
    reply = out.split("\n").filter((l) => !/^FILE:/.test(l)).slice(-6).join("\n");
  }
  // iMessage renders markdown emphasis literally
  reply = reply.replace(/\*\*(.+?)\*\*/g, "$1").trim();
  return { reply: reply || "Done.", files };
}

const dmGuid = (op: Operator) => `any;-;${op.handle}`;

/**
 * Send a reply (+ files). Returns false if it didn't go out; with `queue`, a
 * refused reply goes to the outbox and is retried with backoff (catchUp).
 */
async function deliver(space: Space, spaceId: string, op: Operator, reply: string, files: string[], queue = true): Promise<boolean> {
  // Photon is at-least-once: a send can deliver and still reject. Past this
  // point errors are logged, never retried through Spectrum (duplicates);
  // the kit fallback carries an idempotency key.
  try {
    await space.send(text(reply));
  } catch (e) {
    log(`delivery error (may still have arrived): ${String(e).slice(0, 160)} — kit fallback`);
    if (!(await fallbackSendText(spaceId, reply))) {
      if (queue) {
        outbox.queue(op.id, dmGuid(op), reply, files);
        log(`reply queued for retry [${op.id}] (${outbox.pendingFor(op.id)?.replies.length} waiting)`);
      }
      return false;
    }
  }
  outbox.sendingWorks(op.id);
  // Only this person's own files (dashboards, their photos) are ever sent.
  // realpath resolves symlinks, so a link inside the profile can't escape it.
  const root = fs.realpathSync(profileDir(op.id)) + path.sep;
  for (const f of files) {
    let real: string;
    try {
      real = fs.realpathSync(f);
    } catch {
      log(`FILE missing, skipped: ${f}`);
      continue;
    }
    if (!real.startsWith(root)) {
      log(`FILE outside ${op.id}'s profile, skipped: ${f}`);
      continue;
    }
    try {
      await space.send(attachment(real));
      log(`sent file ${path.basename(f)}`);
    } catch (e) {
      log(`file send error: ${String(e).slice(0, 160)}`);
    }
  }
  return true;
}

async function flush(spaceId: string) {
  const b = batches.get(spaceId);
  if (!b || (!b.texts.length && !b.files.length)) return;
  batches.delete(spaceId);
  const { texts, files, space, op } = b;
  log(`flush [${op.id}]: ${texts.length} text(s), ${files.length} file(s)`);

  if (texts.length === 1 && !files.length && /^help$/i.test(texts[0]!)) {
    enqueueJob(op.id, () =>
      deliver(space, spaceId, op, [
        "Text me what you ate, like a person: \"3 scrambled eggs, 2 Kodiak waffles, some berries\".",
        "📸 Photos of meals, nutrition labels, or barcodes work too.",
        "📊 \"where am I today?\" gets you a chart.",
        "🫃 Tell me when your gut acts up and I'll track it against what you ate.",
        "🏃 Workouts and walks too: \"45 min push day\", \"walked 3 miles\", or a screenshot from your watch.",
        "✏️ Corrections are fine: \"that was 2 eggs not 3\".",
        "⏰ Check-ins: \"nudge me at 12:30 on weekdays if I haven't logged lunch\".",
        "\"reset\" starts a fresh session (your log is kept).",
      ].join("\n"), []),
    );
    return;
  }
  if (texts.length === 1 && !files.length && /^reset$/i.test(texts[0]!)) {
    clearSession(`${WORKER_NAME}:${op.id}`);
    enqueueJob(op.id, () => deliver(space, spaceId, op, "Fresh session. Your food log is untouched.", []));
    return;
  }

  // Decode barcodes up front (local, ~100ms) so the worker starts with digits.
  const images = files.filter(isImage);
  const barcodes: string[] = [];
  for (const f of images) {
    try {
      for (const bc of await scanImage(f)) barcodes.push(`${path.basename(f)}: ${bc.format} ${bc.text}`);
    } catch (e) {
      log(`scan failed ${path.basename(f)}: ${String(e).slice(0, 100)}`);
    }
  }

  const r = await route(texts, files.length);
  log(`route: ${r.kind === "status" ? `status ${r.day} (${r.why})` : `worker — ${r.hint || "no hint"}`}`);

  if (r.kind === "status") {
    // Queued behind any in-flight log so the numbers include it.
    enqueueJob(op.id, async () => {
      try {
        const { png, summary } = (await coachCli(op.id, ["dashboard", r.day])) as { png: string; summary: string };
        await deliver(space, spaceId, op, summary, [png]);
      } catch (e) {
        log(`dashboard failed [${op.id}]: ${String(e).slice(0, 200)}`);
        await deliver(space, spaceId, op, "⚠️ couldn't render the dashboard. It's logged; try again in a sec.", []);
      }
    });
    return;
  }

  enqueueJob(op.id, async () => {
    try {
      // typing indicator for the whole worker run; cleared even on throw
      await space.responding(async () => {
        const backlog = outbox.pendingFor(op.id)?.replies ?? [];
        const out = await runTurn(op, [
          `New iMessage batch from ${op.name}. Treat it as ONE turn. Follow AGENTS.md.`,
          texts.length ? `Messages (in order):\n${texts.map((t, i) => `${i + 1}. """${t}"""`).join("\n")}` : `No text, media only.`,
          files.length ? `Media received (open and look at each image): ${files.join(", ")}` : ``,
          barcodes.length ? `Barcodes decoded from the photos: ${barcodes.join("; ")}` : images.length ? `No barcode found in the photos.` : ``,
          r.hint ? `Fast router's read (a hint, may be wrong): ${r.hint}` : ``,
          backlog.length ? undeliveredNote(op, backlog) : ``,
        ], images);
        if (await deliver(space, spaceId, op, out.reply, out.files)) outbox.settle(op.id, backlog.length);
      });
    } catch (e) {
      // Pre-reply failure: never leave them in silence.
      log(`job failed [${op.id}]: ${String(e).slice(0, 200)}`);
      await space
        .send(text("⚠️ that one errored on my side. It's logged. Resend it, or text 'reset' for a clean session."))
        .catch(() => {});
    }
  });
}

/** One worker turn on this person's long session. `lines` is the turn-specific part of the prompt. */
async function runTurn(op: Operator, lines: string[], images: string[] = []) {
  const memory = memoryText(op.id);
  const prompt = [
    lines[0],
    `You are coaching ${op.name} (profile "${op.id}"). \`coach\` is already scoped to their log.${op.notes ? ` About them: ${op.notes}` : ""}`,
    op.style === "non-technical"
      ? `${op.name} is not technical: plain, warm, everyday language. Never mention databases, sources like USDA/fdcId, sessions, files, or tools.`
      : ``,
    memory
      ? `Your saved notes on ${op.name} (\`coach memory\`; keep them current):\n${memory}`
      : `Your saved notes on ${op.name} are empty so far. Save what you learn with \`coach memory add\`.`,
    `Local time now: ${localIso()} (${new Date().toLocaleDateString("en-US", { weekday: "long" })}).`,
    ...lines.slice(1),
    `End with REPLY: (and optional FILE: lines) per the output contract.`,
  ]
    .filter(Boolean)
    .join("\n");

  const key = `${WORKER_NAME}:${op.id}`;
  const prior = getSession(key);
  let run: WorkerRun;
  try {
    run = await runWorker(op.id, prompt, prior, images);
  } catch (e) {
    if (!prior) throw e;
    log(`resume ${prior.slice(0, 8)}… failed, starting fresh`);
    clearSession(key);
    run = await runWorker(op.id, prompt, undefined, images);
  }
  if (run.sessionId) setSession(key, run.sessionId);
  const out = parseWorkerOutput(run.text);
  log(`job done [${op.id}] ${WORKER_NAME} session=${run.sessionId?.slice(0, 8) ?? "?"} cost=$${run.costUsd ?? "?"} reply: ${out.reply.slice(0, 80).replace(/\n/g, " ⏎ ")}`);
  return out;
}

/** A scheduled nudge: the coach writes it (or answers SKIP); no typing indicator, no error text. */
function fireNudge(op: Operator, n: Nudge) {
  enqueueJob(op.id, async () => {
    try {
      const chatGuid = dmGuid(op);
      const space = await im.space.get(chatGuid);
      if (!space || isGroupSpace(space as { id?: string; type?: unknown })) throw new Error("no DM space");
      const out = await runTurn(op, [
        `Scheduled nudge "${n.id}" (${n.about}), set for ${n.at}. ${op.name} has NOT messaged; you are reaching out first. Follow AGENTS.md "Nudges".`,
        n.meal ? `No ${n.meal} is logged yet today.` : ``,
      ]);
      if (/^SKIP\b/i.test(out.reply)) {
        log(`nudge ${op.id}:${n.id}: coach chose to skip`);
        return;
      }
      await deliver(space, space.id || chatGuid, op, out.reply, out.files, false);
    } catch (e) {
      log(`nudge ${op.id}:${n.id} failed: ${String(e).slice(0, 200)}`);
    }
  });
}

const undeliveredNote = (op: Operator, backlog: outbox.Undelivered[]) =>
  `Sending was down (the iMessage provider refused it), so ${op.name} never got your last ${backlog.length === 1 ? "reply" : `${backlog.length} replies`}:\n${backlog
    .map((b) => `[${b.at}] """${b.text}"""`)
    .join("\n")}\nFold anything they still need from those into this reply (keep it short; don't repeat stale totals).`;

/**
 * Retry a person's undelivered replies. One reply is resent as-is with a note;
 * several become one catch-up text the coach writes once and reuses across
 * retries. Runs on their lane, so it never overlaps a live turn.
 */
function catchUp(op: Operator) {
  enqueueJob(op.id, async () => {
    const p = outbox.pendingFor(op.id);
    if (!p || p.nextAt > Date.now()) return;
    try {
      const space = await im.space.get(p.chatGuid);
      if (!space) throw new Error("no DM space");
      const n = p.replies.length;
      let draft = p.draft?.covers === n ? p.draft : undefined;
      if (!draft) {
        if (n === 1) {
          const only = p.replies[0]!;
          draft = { text: `(my texts were down, sending this now)\n${only.text}`, files: only.files, covers: 1 };
        } else {
          const out = await runTurn(op, [
            `Catch-up turn, not a new message from ${op.name}. Follow AGENTS.md.`,
            undeliveredNote(op, p.replies),
            `Write ONE short catch-up text: say briefly that your texts were down and everything they sent is logged, then give where they stand now (check \`coach day\`) and anything from those replies they still need, like an open question.`,
          ]);
          draft = { text: out.reply, files: out.files, covers: n };
        }
        outbox.setDraft(op.id, draft);
      }
      if (await deliver(space, space.id || p.chatGuid, op, draft.text, draft.files, false)) {
        log(`catch-up delivered [${op.id}] (${n} repl${n === 1 ? "y" : "ies"})`);
        outbox.settle(op.id, n);
      } else {
        outbox.backoff(op.id);
        const next = outbox.pendingFor(op.id);
        log(`catch-up still blocked [${op.id}], retry in ${Math.round(((next?.nextAt ?? 0) - Date.now()) / 60_000)} min`);
      }
    } catch (e) {
      outbox.backoff(op.id);
      log(`catch-up failed [${op.id}]: ${String(e).slice(0, 160)}`);
    }
  });
}

// ---- main loop ----
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);
const streamStart = new Date();
log(`coach bridge up (worker=${WORKER_NAME}, jev=${process.env.TYPESAFE_API_KEY ? "on" : "off"})`);

// One-time: an existing session seeds its notes from everything it learned so
// far. Runs on the person's lane like any turn; nothing is sent to them.
for (const op of cfg.operators ?? []) {
  if (fs.existsSync(memoryPath(op.id)) || !getSession(`${WORKER_NAME}:${op.id}`)) continue;
  enqueueJob(op.id, async () => {
    try {
      await runTurn(op, [
        `Maintenance turn, not a message from ${op.name}; nothing you write is sent. Your notes file is new. Go back over this whole conversation and save everything durable you've learned about ${op.name} with \`coach memory add\`, per AGENTS.md "Memory". Include their usual foods and portions, how they cook, corrections they've made, habits, coaching preferences, health context, and open follow-ups. Check \`coach food find ""\` and \`coach goals\` so you don't duplicate what's already stored there. Then reply REPLY: done.`,
      ]);
      log(`memory backfill [${op.id}]: ${memoryText(op.id).split("\n").filter((l) => l.startsWith("- ")).length} notes`);
    } catch (e) {
      log(`memory backfill [${op.id}] failed: ${String(e).slice(0, 160)}`);
    }
  });
}

const operators = new Map((cfg.operators ?? []).map((o) => [o.id, o]));
const catchingUp = new Set<string>();
setInterval(() => {
  for (const [id] of outbox.due()) {
    const op = operators.get(id);
    if (!op || catchingUp.has(id)) continue;
    catchingUp.add(id);
    catchUp(op);
    enqueueJob(id, async () => void catchingUp.delete(id));
  }
}, 20_000);

const lastInbound = new Map<string, number>();
startNudger({ operators: cfg.operators ?? [], lastInbound, fire: fireNudge });

// Reconcile: replay anything that landed while no subscriber was connected.
// Newer than streamStart belongs to the live stream (overlap guard).
void (async () => {
  try {
    const chats = (cfg.operators ?? []).map((o) => `any;-;${o.handle}`);
    const n = await sweepMissed(chats, async (m) => {
      if (m.dateCreated >= streamStart) return false;
      const senderAddr = m.sender?.address ?? "";
      const chatGuid = m.chatGuids[0];
      const op = findOperator(senderAddr);
      if (!op || !chatGuid || isGroupSpace(undefined, chatGuid)) {
        log(`sweep: dropped ${m.guid.slice(0, 12)}… (${!op ? "not allowlisted" : "group or no chat"})`);
        return true;
      }
      const space = await im.space.get(chatGuid);
      if (!space || isGroupSpace(space as { id?: string; type?: unknown })) {
        log(`sweep: no DM space for ${m.guid.slice(0, 12)}…`);
        return true;
      }
      const spaceId = space.id || senderAddr;
      log(`sweep: replaying ${m.guid.slice(0, 12)}… from ${op.name}`);
      const t = m.content.text?.trim();
      if (t) {
        // The time matters for logging: tell the worker when it was really sent.
        ensureBatch(spaceId, space, op).texts.push(`[sent ${localIso(m.dateCreated)}, delivered late] ${t}`);
        scheduleFlush(spaceId);
      }
      for (const att of m.content.attachments) {
        try {
          const a = await im.getAttachment(att.guid);
          if (!a) throw new Error("getAttachment returned undefined");
          const bytes = await downloadWithRetry(() => a.read(), att.fileName);
          ensureBatch(spaceId, space, op).files.push(saveMedia(op, att.fileName, bytes));
          scheduleFlush(spaceId);
        } catch (e) {
          log(`sweep: attachment ${att.guid.slice(0, 12)}… unrecoverable: ${String(e).slice(0, 120)}`);
          await space.send(text("📥 I was offline when a photo arrived and couldn't recover it. Please resend it.")).catch(() => {});
        }
      }
      return true;
    });
    if (n) log(`sweep complete: ${n} missed message(s) replayed`);
  } catch (e) {
    log(`sweep failed: ${String(e).slice(0, 160)}`);
  }
})();

// Durability: if the stream ends or throws, exit non-zero so launchd relaunches.
try {
  for await (const [space, message] of app.messages) {
    if (message.direction === "outbound") continue;
    if (message.id && alreadyProcessed(message.id)) continue;
    markProcessed(message.id ?? "", message.timestamp);

    // Allowlist gate: exact handle, 1:1 chat. Nothing past here (no 👀, no
    // download, no Jev call, no worker) happens for anyone else.
    const sender = message.sender?.id ?? "";
    const op = findOperator(sender);
    if (!op) {
      log(`dropped: not allowlisted sender="${sender.slice(0, 4)}***" type=${message.content?.type}`);
      continue;
    }
    if (isGroupSpace(space as { id?: string; type?: unknown })) {
      log(`dropped: group chat message from ${op.name}`);
      continue;
    }

    lastInbound.set(op.id, Date.now());
    const spaceId = space.id || sender;
    const c = message.content;
    const ack = () => void message.react("👀").catch((e) => log(`ack react failed: ${String(e).slice(0, 120)}`));

    if (c.type === "reaction") continue;

    // iMessage media (and media+text) arrive wrapped as "group"
    if (c.type === "group") {
      ensureBatch(spaceId, space, op, ack);
      // bounded parallel downloads; flush deferred so one send = one turn
      const CONCURRENCY = 3;
      for (let i = 0; i < c.items.length; i += CONCURRENCY) {
        const chunk = c.items.slice(i, i + CONCURRENCY);
        await Promise.all(
          chunk.map((item) =>
            bufferContent(spaceId, space, op, ack, item.content, true)
              .then((ok) => ok || log(`group item unhandled type=${item.content.type}`))
              .catch((e) => log(`group item failed: ${String(e).slice(0, 140)}`)),
          ),
        );
      }
      scheduleFlush(spaceId);
      continue;
    }

    try {
      if (await bufferContent(spaceId, space, op, ack, c)) continue;
    } catch (e) {
      log(`content receive failed: ${String(e).slice(0, 140)}`);
      continue;
    }
    log(`unhandled content type=${(c as { type: string }).type}`);
  }
} catch (e) {
  log(`message stream error: ${String(e).slice(0, 200)} — exiting for relaunch`);
  process.exit(1);
}
log("message stream ended — exiting for relaunch");
process.exit(1);
