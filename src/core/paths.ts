import fs from "node:fs";
import path from "node:path";

export const REPO = path.resolve(import.meta.dir, "..", "..");
export const DATA = path.join(REPO, "data");
export const WORKSPACE = path.join(REPO, "coach");

// One person = one profile dir: their own food log, dashboards, and photos.
// The bridge passes COACH_PROFILE to the worker (and to `coach`), so a
// worker only ever sees the log of the person it's talking to.
export const isProfileId = (id: string) => /^[a-z][a-z0-9-]{0,31}$/.test(id);
export const profileDir = (id: string) => {
  if (!isProfileId(id)) throw new Error(`bad profile id "${id}"`);
  return path.join(DATA, "profiles", id);
};
export const inboxFor = (id: string) => path.join(profileDir(id), "inbox");

export const PROFILE = process.env.COACH_PROFILE || "me";
export const OUT = path.join(profileDir(PROFILE), "out");
export const DB_PATH = process.env.COACH_DB ?? path.join(profileDir(PROFILE), "coach.db");

for (const d of [DATA, OUT]) fs.mkdirSync(d, { recursive: true });

// Day boundaries are the machine's local timezone — the phone and the Mac
// live in the same one, and "today" should mean what the person texting means by it.
export const localDay = (d = new Date()): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const localIso = (d = new Date()): string => {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
};

/** "today" | "yesterday" | "YYYY-MM-DD" | "-N" (N days ago) → YYYY-MM-DD */
export function resolveDay(arg?: string): string {
  const now = new Date();
  if (!arg || arg === "today") return localDay(now);
  if (arg === "yesterday") return localDay(new Date(now.getTime() - 86_400_000));
  if (/^-\d+$/.test(arg))
    return localDay(new Date(now.getTime() + Number(arg) * 86_400_000));
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  throw new Error(`bad day "${arg}" — use today, yesterday, -N, or YYYY-MM-DD`);
}

export const shiftDay = (day: string, delta: number): string => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + delta, 12));
};
