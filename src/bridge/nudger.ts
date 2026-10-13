// Fires each person's scheduled nudges (data/profiles/<id>/nudges.json).
// Code decides *whether* a nudge is due and still relevant; the coach writes
// the message (and can still answer SKIP). A nudge fires at most once a day,
// even across restarts, and only within a grace window after its time, so a
// daemon that was down at 12:30 doesn't send "lunch?" at 4pm.
import fs from "node:fs";
import path from "node:path";
import { daySet, loadNudges, type Nudge } from "../core/nudges.ts";
import { DATA, localDay } from "../core/paths.ts";
import type { Operator } from "./allowlist.ts";
import { coachCli } from "./coachcli.ts";
import { log } from "./log.ts";

const FIRED = path.join(DATA, "nudges-fired.json");
const TICK_MS = 30_000;
const GRACE_MIN = 20;
/** they texted recently: they're engaged, a nudge would be noise */
const QUIET_AFTER_INBOUND_MIN = 45;
/** they logged something recently: same */
const QUIET_AFTER_LOG_MIN = 90;

type Fired = Record<string, string>; // "<profile>:<nudge>" → day last fired
const readFired = (): Fired => {
  try {
    return JSON.parse(fs.readFileSync(FIRED, "utf8"));
  } catch {
    return {};
  }
};
const writeFired = (f: Fired) => {
  fs.writeFileSync(`${FIRED}.tmp`, JSON.stringify(f, null, 2));
  fs.renameSync(`${FIRED}.tmp`, FIRED);
};

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
const parseAt = (at: string) => {
  const [h, m] = at.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

type DayView = { entries: { meal: string | null; item: string; created_at?: string; eaten_at?: string }[] };

/** Why this nudge shouldn't go out right now, or null if it should. */
async function skipReason(op: Operator, n: Nudge, lastInbound: number | undefined, now: Date): Promise<string | null> {
  if (lastInbound && now.getTime() - lastInbound < QUIET_AFTER_INBOUND_MIN * 60_000) return "texted recently";
  const day = (await coachCli(op.id, ["day", "today"])) as DayView;
  if (n.meal && day.entries.some((e) => e.meal === n.meal)) return `${n.meal} already logged`;
  const recent = day.entries.some((e) => {
    const t = Date.parse(e.created_at ?? e.eaten_at ?? "");
    return Number.isFinite(t) && now.getTime() - t < QUIET_AFTER_LOG_MIN * 60_000;
  });
  return recent ? "logged something recently" : null;
}

export function startNudger(opts: {
  operators: Operator[];
  lastInbound: Map<string, number>;
  fire: (op: Operator, n: Nudge) => void;
}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const today = localDay(now);
      const mins = minutesOfDay(now);
      const fired = readFired();
      for (const op of opts.operators) {
        for (const n of loadNudges(op.id)) {
          const key = `${op.id}:${n.id}`;
          if (fired[key] === today) continue;
          if (n.paused_until && today <= n.paused_until) continue;
          let days: Set<number>;
          try {
            days = daySet(n.days);
          } catch {
            continue;
          }
          if (!days.has(now.getDay())) continue;
          const at = parseAt(n.at);
          if (mins < at || mins >= at + GRACE_MIN) continue;
          // Mark first: one decision per nudge per day, whatever happens next.
          fired[key] = today;
          writeFired(fired);
          const why = await skipReason(op, n, opts.lastInbound.get(op.id), now).catch((e) => `check failed: ${String(e).slice(0, 80)}`);
          if (why) {
            log(`nudge ${key} skipped: ${why}`);
            continue;
          }
          log(`nudge ${key} firing`);
          opts.fire(op, n);
        }
      }
    } catch (e) {
      log(`nudger tick failed: ${String(e).slice(0, 160)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(() => void tick(), TICK_MS);
}
