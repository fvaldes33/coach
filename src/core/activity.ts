// Movement: workouts, walks, daily watch summaries, plus body measurements
// (weight is what turns a MET value into calories). Same philosophy as
// nutrients: a few fixed columns every activity has, everything else in a
// free-form `details` JSON (sets×reps, pace, elevation, avg HR, route…).
import { MOVEMENT_GOAL_KEYS, db } from "./db.ts";
import { localDay, localIso } from "./paths.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  duration_min REAL,
  distance_km REAL,
  steps INTEGER,
  kcal_burned REAL,
  intensity TEXT,
  met REAL,
  details TEXT,
  source TEXT, confidence TEXT, notes TEXT, photo TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS activities_day ON activities(day) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  at TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS measurements_key ON measurements(key, at);
`);

/**
 * kind "daily" = a device's whole-day summary (Apple Watch rings, phone step
 * count). It already contains any workouts that day, so day totals take the
 * larger of the summary and the sum of workouts instead of adding them.
 */
export const DAILY = "daily";

export type Activity = {
  id: number;
  day: string;
  started_at: string;
  kind: string;
  name: string | null;
  duration_min: number | null;
  distance_km: number | null;
  steps: number | null;
  kcal_burned: number | null;
  intensity: string | null;
  met: number | null;
  details: Record<string, unknown>;
  source: string | null;
  confidence: string | null;
  notes: string | null;
  photo: string | null;
};

const FIELDS = ["day", "started_at", "kind", "name", "duration_min", "distance_km", "steps", "kcal_burned", "intensity", "met", "source", "confidence", "notes", "photo"] as const;
const NUM = new Set(["duration_min", "distance_km", "steps", "kcal_burned", "met"]);
const INTENSITIES = new Set(["light", "moderate", "vigorous"]);

const parseDetails = (raw: unknown): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const hydrate = (r: Activity) => ({ ...r, details: parseDetails(r.details) });

function validate(a: Record<string, unknown>) {
  for (const k of NUM)
    if (a[k] !== undefined && a[k] !== null && (typeof a[k] !== "number" || !Number.isFinite(a[k]) || (a[k] as number) < 0))
      throw new Error(`activity ${k} must be a non-negative number`);
  if (a.intensity != null && !INTENSITIES.has(String(a.intensity))) throw new Error(`intensity must be light, moderate or vigorous`);
  if (a.details !== undefined && a.details !== null && (typeof a.details !== "object" || Array.isArray(a.details)))
    throw new Error(`details must be a JSON object`);
}

// ---- body measurements (weight, waist, resting HR…), unit in the key ----
export const MEASURE_KEY = /^[a-z][a-z0-9_]*_(kg|lb|cm|in|bpm|h|pct|mmhg)$/;

export function addMeasurement(m: Record<string, unknown>): number[] {
  const at = typeof m.at === "string" ? m.at : localIso();
  const notes = typeof m.notes === "string" ? m.notes : null;
  const ids: number[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === "at" || k === "notes") continue;
    if (!MEASURE_KEY.test(k)) throw new Error(`measurement "${k}" must end in its unit: _kg _lb _cm _in _bpm _h _pct _mmhg (e.g. weight_lb)`);
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`measurement "${k}" must be a positive number`);
    const res = db
      .prepare(`INSERT INTO measurements (day, at, key, value, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(localDay(new Date(at)), at, k, v, notes, localIso());
    ids.push(Number(res.lastInsertRowid));
  }
  if (!ids.length) throw new Error(`no measurements given (e.g. {"weight_lb": 182})`);
  return ids;
}

export const measurements = (key?: string, limit = 30) =>
  key
    ? db.prepare(`SELECT * FROM measurements WHERE key = ? ORDER BY at DESC LIMIT ?`).all(key, limit)
    : db.prepare(`SELECT * FROM measurements ORDER BY at DESC LIMIT ?`).all(limit);

/** Most recent body weight in kg, from weight_kg or weight_lb. */
export function latestWeightKg(): number | null {
  const r = db
    .prepare(`SELECT key, value FROM measurements WHERE key IN ('weight_kg', 'weight_lb') ORDER BY at DESC LIMIT 1`)
    .get() as { key: string; value: number } | null;
  if (!r) return null;
  return r.key === "weight_lb" ? r.value * 0.45359237 : r.value;
}

/**
 * Active (net) kcal from a MET value: (MET − 1) × kg × hours. Net, not gross,
 * so it's comparable to a watch's "active calories" and never counts the
 * resting burn that's already part of daily energy needs.
 */
export const metKcal = (met: number, kg: number, minutes: number) => Math.round(Math.max(met - 1, 0) * kg * (minutes / 60));

// ---- activities ----
export function addActivity(input: Record<string, unknown>): { id: number; kcal_estimated: boolean; hint?: string } {
  const kind = String(input.kind ?? "").trim().toLowerCase();
  if (!kind) throw new Error(`activity needs a kind (walk, run, strength, cycle, yoga, swim, hike, sport, daily…)`);
  if (input.duration_min == null && input.steps == null && input.kcal_burned == null)
    throw new Error(`activity needs at least one of duration_min, steps, kcal_burned`);
  validate(input);
  const row: Record<string, unknown> = { ...input, kind };
  row.started_at = typeof input.started_at === "string" ? input.started_at : localIso();
  row.day = typeof input.day === "string" ? input.day : localDay(new Date(row.started_at as string));

  let kcal_estimated = false;
  let hint: string | undefined;
  if (row.kcal_burned == null && typeof row.met === "number" && typeof row.duration_min === "number") {
    const kg = latestWeightKg();
    if (kg) {
      row.kcal_burned = metKcal(row.met, kg, row.duration_min);
      kcal_estimated = true;
      row.confidence ??= "medium";
    } else hint = `no body weight on file, so kcal_burned wasn't estimated. Ask for weight, then \`coach measure '{"weight_lb": N}'\` and \`coach move edit <id>\``;
  }
  const cols: string[] = FIELDS.filter((k) => row[k] !== undefined);
  const vals: unknown[] = cols.map((k) => row[k] ?? null);
  if (input.details) {
    cols.push("details");
    vals.push(JSON.stringify(input.details));
  }
  const now = localIso();
  const res = db
    .prepare(`INSERT INTO activities (${cols.join(", ")}, created_at, updated_at) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`)
    .run(...(vals as never[]), now as never, now as never);
  return { id: Number(res.lastInsertRowid), kcal_estimated, ...(hint ? { hint } : {}) };
}

/** Patch an activity; `details` merges per key (null removes a key). */
export function editActivity(id: number, patch: Record<string, unknown>): void {
  validate(patch);
  const cur = db.prepare(`SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL`).get(id) as Activity | null;
  if (!cur) throw new Error(`no live activity ${id}`);
  const cols: string[] = FIELDS.filter((k) => patch[k] !== undefined);
  const vals: unknown[] = cols.map((k) => (k === "kind" ? String(patch[k]).toLowerCase() : (patch[k] ?? null)));
  if (patch.details && typeof patch.details === "object") {
    const merged = { ...parseDetails(cur.details), ...(patch.details as Record<string, unknown>) };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    cols.push("details");
    vals.push(JSON.stringify(merged));
  }
  if (!cols.length) throw new Error("nothing to edit");
  db.prepare(`UPDATE activities SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...(vals as never[]), localIso() as never, id as never);
}

export function removeActivity(id: number): void {
  const res = db.prepare(`UPDATE activities SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(localIso(), id);
  if (!res.changes) throw new Error(`no live activity ${id}`);
}

export const activitiesFor = (day: string): Activity[] =>
  (db.prepare(`SELECT * FROM activities WHERE day = ? AND deleted_at IS NULL ORDER BY started_at, id`).all(day) as Activity[]).map(hydrate);

export type Movement = { active_min: number; steps: number; active_kcal: number; workouts: number };

/**
 * Day totals. Workouts add up; a "daily" device summary already includes
 * them, so each total is max(summary, sum of workouts), never the sum of both.
 */
export function movementOf(acts: Activity[]): Movement {
  const daily = acts.filter((a) => a.kind === DAILY);
  const workouts = acts.filter((a) => a.kind !== DAILY);
  const sum = (xs: Activity[], k: "duration_min" | "steps" | "kcal_burned") => xs.reduce((s, a) => s + (a[k] ?? 0), 0);
  // several daily summaries in one day = updated snapshots; the latest wins
  const snap = daily.at(-1);
  const pick = (k: "duration_min" | "steps" | "kcal_burned") => Math.max(snap?.[k] ?? 0, sum(workouts, k));
  return {
    active_min: Math.round(pick("duration_min")),
    steps: Math.round(pick("steps")),
    active_kcal: Math.round(pick("kcal_burned")),
    workouts: workouts.length,
  };
}

export function movementByDay(fromDay: string, toDay: string): Map<string, Movement> {
  const rows = (db
    .prepare(`SELECT * FROM activities WHERE deleted_at IS NULL AND day BETWEEN ? AND ? ORDER BY started_at, id`)
    .all(fromDay, toDay) as Activity[]).map(hydrate);
  const byDay = new Map<string, Activity[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  return new Map([...byDay.entries()].map(([d, as]) => [d, movementOf(as)]));
}

export const isMovementKey = (k: string): k is keyof Omit<Movement, "workouts"> => MOVEMENT_GOAL_KEYS.includes(k);
