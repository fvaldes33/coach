// Scheduled check-ins ("nudge me at 12:30 if I haven't logged lunch").
// Stored per profile in nudges.json so the coach can set them from a text
// (`coach nudge add …`); the bridge daemon reads them every tick and decides
// whether one is due (src/bridge/nudger.ts).
import fs from "node:fs";
import path from "node:path";
import { profileDir } from "./paths.ts";

export type Nudge = {
  /** slug, unique per person: "lunch", "weigh-in" */
  id: string;
  /** local 24h time, "12:30" */
  at: string;
  /** "daily" | "weekdays" | "weekends" | "mon,wed,fri" */
  days: string;
  /** skip when an entry with this meal is already logged today */
  meal?: string;
  /** what the nudge is for, in plain words; the coach writes the message from it */
  about: string;
  /** "YYYY-MM-DD": paused until this day (inclusive) */
  paused_until?: string;
};

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const AT = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MEALS = new Set(["breakfast", "lunch", "dinner", "snack", "drink"]);

export const nudgesPath = (id: string) => path.join(profileDir(id), "nudges.json");

export function loadNudges(id: string): Nudge[] {
  try {
    const v = JSON.parse(fs.readFileSync(nudgesPath(id), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(id: string, list: Nudge[]) {
  const p = nudgesPath(id);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(list, null, 2) + "\n");
  fs.renameSync(`${p}.tmp`, p);
}

/** "daily" etc. → set of weekday numbers (0 = Sunday). */
export function daySet(days: string): Set<number> {
  const d = days.trim().toLowerCase();
  if (d === "daily") return new Set([0, 1, 2, 3, 4, 5, 6]);
  if (d === "weekdays") return new Set([1, 2, 3, 4, 5]);
  if (d === "weekends") return new Set([0, 6]);
  const out = new Set<number>();
  for (const part of d.split(/[\s,]+/).filter(Boolean)) {
    const i = DAY_NAMES.indexOf(part.slice(0, 3));
    if (i < 0) throw new Error(`bad day "${part}": use daily, weekdays, weekends, or mon,tue,…`);
    out.add(i);
  }
  if (!out.size) throw new Error("days is empty");
  return out;
}

function normalize(n: Record<string, unknown>, prev?: Nudge): Nudge {
  const merged = { ...prev, ...n } as Record<string, unknown>;
  const id = String(merged.id ?? "").trim().toLowerCase();
  if (!ID.test(id)) throw new Error(`nudge id must be a lowercase slug ("lunch", "weigh-in")`);
  const m = String(merged.at ?? "").trim().match(AT);
  if (!m) throw new Error(`nudge "at" must be 24h local time like "12:30"`);
  const days = String(merged.days ?? "daily").trim().toLowerCase();
  daySet(days);
  const about = String(merged.about ?? "").trim();
  if (!about) throw new Error(`nudge needs "about": what it's for, e.g. "lunch check-in if nothing logged"`);
  const out: Nudge = { id, at: `${m[1]!.padStart(2, "0")}:${m[2]}`, days, about };
  if (merged.meal != null && merged.meal !== "") {
    const meal = String(merged.meal).toLowerCase();
    if (!MEALS.has(meal)) throw new Error(`meal must be one of ${[...MEALS].join(", ")}`);
    out.meal = meal;
  }
  if (merged.paused_until != null && merged.paused_until !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.paused_until))) throw new Error(`paused_until must be YYYY-MM-DD`);
    out.paused_until = String(merged.paused_until);
  }
  return out;
}

/** Add, or replace the nudge with the same id (fields merge). */
export function setNudge(id: string, input: Record<string, unknown>): Nudge[] {
  const list = loadNudges(id);
  const key = String(input.id ?? "").trim().toLowerCase();
  const i = list.findIndex((n) => n.id === key);
  const next = normalize(input, i >= 0 ? list[i] : undefined);
  if (i >= 0) list[i] = next;
  else list.push(next);
  list.sort((a, b) => a.at.localeCompare(b.at));
  save(id, list);
  return list;
}

export function removeNudge(id: string, nudgeId: string): Nudge[] {
  const list = loadNudges(id);
  const next = list.filter((n) => n.id !== nudgeId);
  if (next.length === list.length) throw new Error(`no nudge "${nudgeId}"`);
  save(id, next);
  return next;
}
