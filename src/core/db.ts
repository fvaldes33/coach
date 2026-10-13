import { Database } from "bun:sqlite";
import { DB_PATH, localDay, localIso } from "./paths.ts";

// Core nutrient columns shared by entries (as eaten) and foods (per serving).
// sodium is mg; everything else is grams except kcal. Every entry has these.
export const NUTRIENTS = [
  "kcal",
  "protein",
  "carbs",
  "fat",
  "fiber",
  "sugar",
  "added_sugar",
  "sat_fat",
  "sodium",
] as const;
export type Nutrient = (typeof NUTRIENTS)[number];
export type Nutrients = Partial<Record<Nutrient, number | null>>;

export const MACROS = ["kcal", "protein", "carbs", "fat", "fiber"] as const;

// Everything else is free-form: a JSON object on each entry/food whose keys
// carry their unit (iron_mg, vitamin_c_mg, vitamin_d_mcg, omega_3_g, caffeine_mg).
// New nutrients need no migration: log them, set a goal, they show up.
export type Micros = Record<string, number>;
export const MICRO_KEY = /^[a-z][a-z0-9_]*_(g|mg|mcg|iu)$/;
// unit-suffixed spellings of core columns: steer them to the column instead
const CORE_ALIASES: Record<string, Nutrient> = {
  kcal_kcal: "kcal",
  energy_kcal: "kcal",
  calories_kcal: "kcal",
  protein_g: "protein",
  carbs_g: "carbs",
  carbohydrates_g: "carbs",
  fat_g: "fat",
  fiber_g: "fiber",
  sugar_g: "sugar",
  sugars_g: "sugar",
  added_sugar_g: "added_sugar",
  sat_fat_g: "sat_fat",
  saturated_fat_g: "sat_fat",
  sodium_mg: "sodium",
};

export const unitOf = (key: string): string =>
  (NUTRIENTS as readonly string[]).includes(key) ? (key === "kcal" ? "kcal" : key === "sodium" ? "mg" : "g") : (key.match(MICRO_KEY)?.[1] ?? "");

export type Entry = Nutrients & {
  id: number;
  day: string;
  eaten_at: string;
  meal: string | null;
  item: string;
  brand: string | null;
  qty: number | null;
  unit: string | null;
  grams: number | null;
  nutrients: Micros;
  source: string | null;
  source_ref: string | null;
  confidence: string | null;
  tags: string | null;
  notes: string | null;
  photo: string | null;
};

const nutrientCols = NUTRIENTS.map((n) => `${n} REAL`).join(", ");

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  eaten_at TEXT NOT NULL,
  meal TEXT,
  item TEXT NOT NULL,
  brand TEXT,
  qty REAL, unit TEXT, grams REAL,
  ${nutrientCols},
  nutrients TEXT,
  source TEXT, source_ref TEXT, confidence TEXT,
  tags TEXT, notes TEXT, photo TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS entries_day ON entries(day) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS foods (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand TEXT,
  barcode TEXT,
  serving_desc TEXT,
  serving_g REAL,
  ${nutrientCols},
  nutrients TEXT,
  source TEXT, source_ref TEXT, notes TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS foods_barcode ON foods(barcode);

CREATE TABLE IF NOT EXISTS symptoms (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'min'
);
`);

// Additive migrations for DBs created before a column existed.
function ensureColumn(table: string, col: string, decl: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  return true;
}
ensureColumn("entries", "nutrients", "TEXT");
ensureColumn("foods", "nutrients", "TEXT");
// Goals predating `kind` were all "land near this number" — keep that meaning.
if (ensureColumn("goals", "kind", "TEXT NOT NULL DEFAULT 'min'"))
  db.exec(`UPDATE goals SET kind = 'target' WHERE key IN ('kcal', 'protein', 'carbs', 'fat')`);

// Only fiber ships with a default (general 25–38 g/day guidance); the rest
// stay unset until the person states them — the dashboard shows raw totals then.
db.exec(`INSERT OR IGNORE INTO goals(key, value, kind) VALUES ('fiber', 30, 'min')`);

// ---- free-form nutrients: parse, validate, merge ----
const parseMicros = (raw: unknown): Micros => {
  if (!raw) return {};
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Micros) : {};
  } catch {
    return {};
  }
};

/**
 * Pull micros from `input.nutrients` plus any top-level unit-suffixed keys
 * (`"iron_mg": 3.1` works as well as `"nutrients": {"iron_mg": 3.1}`).
 * null values are kept so an edit can delete a key.
 */
function collectMicros(input: Record<string, unknown>): Record<string, number | null> | undefined {
  const found: Record<string, unknown> = { ...parseMicros(input.nutrients) };
  if (input.nutrients && typeof input.nutrients === "object")
    for (const [k, v] of Object.entries(input.nutrients)) if (v === null) found[k] = null;
  for (const [k, v] of Object.entries(input)) if (MICRO_KEY.test(k)) found[k] = v;
  const keys = Object.keys(found);
  if (!keys.length) return undefined;
  const out: Record<string, number | null> = {};
  for (const k of keys) {
    const v = found[k];
    if (CORE_ALIASES[k]) throw new Error(`"${k}" is a core field: use "${CORE_ALIASES[k]}"`);
    if (!MICRO_KEY.test(k)) throw new Error(`nutrient key "${k}" must be snake_case ending in its unit: _g, _mg, _mcg or _iu (e.g. iron_mg)`);
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new Error(`nutrient "${k}" must be a non-negative number`);
    out[k] = v === null ? null : Math.round((v as number) * 1000) / 1000;
  }
  return out;
}

const dropNulls = (m: Record<string, number | null>): Micros =>
  Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null)) as Micros;

const ENTRY_TEXT = [
  "meal",
  "item",
  "brand",
  "unit",
  "source",
  "source_ref",
  "confidence",
  "tags",
  "notes",
  "photo",
] as const;
const ENTRY_NUM = ["qty", "grams", ...NUTRIENTS] as const;
const ENTRY_FIELDS = [...ENTRY_TEXT, ...ENTRY_NUM, "eaten_at", "day"] as const;

type EntryInput = Partial<Omit<Entry, "id" | "nutrients">> & { item: string; nutrients?: Record<string, number | null> } & Record<string, unknown>;

export function addEntry(input: EntryInput): number {
  if (!input.item) throw new Error("entry needs an item");
  for (const m of MACROS)
    if (typeof input[m] !== "number")
      throw new Error(`entry "${input.item}" is missing ${m} (number required)`);
  const micros = collectMicros(input);
  const eatenAt = input.eaten_at ?? localIso();
  const day = input.day ?? localDay(new Date(eatenAt));
  const now = localIso();
  const row: Record<string, unknown> = { ...input, eaten_at: eatenAt, day };
  const cols: string[] = ENTRY_FIELDS.filter((k) => row[k] !== undefined);
  const vals: unknown[] = cols.map((k) => row[k] ?? null);
  if (micros) {
    cols.push("nutrients");
    vals.push(JSON.stringify(dropNulls(micros)));
  }
  const res = db
    .prepare(`INSERT INTO entries (${cols.join(", ")}, created_at, updated_at) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`)
    .run(...(vals as never[]), now as never, now as never);
  return Number(res.lastInsertRowid);
}

/** Patch an entry. `nutrients` merges key-by-key; a null value removes a key. */
export function editEntry(id: number, patch: Record<string, unknown>): void {
  const cols: string[] = ENTRY_FIELDS.filter((k) => patch[k] !== undefined);
  const vals: unknown[] = cols.map((k) => patch[k] ?? null);
  const micros = collectMicros(patch);
  if (micros) {
    const cur = db.prepare(`SELECT nutrients FROM entries WHERE id = ? AND deleted_at IS NULL`).get(id) as { nutrients: string | null } | null;
    if (!cur) throw new Error(`no live entry ${id}`);
    cols.push("nutrients");
    vals.push(JSON.stringify(dropNulls({ ...parseMicros(cur.nutrients), ...micros })));
  }
  if (!cols.length) throw new Error("nothing to edit");
  const res = db
    .prepare(`UPDATE entries SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(...(vals as never[]), localIso() as never, id as never);
  if (!res.changes) throw new Error(`no live entry ${id}`);
}

export function removeEntry(id: number): void {
  const res = db
    .prepare(`UPDATE entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(localIso(), id);
  if (!res.changes) throw new Error(`no live entry ${id}`);
}

const hydrate = <T extends { nutrients?: unknown }>(r: T) => ({ ...r, nutrients: parseMicros(r.nutrients) });

export const entriesFor = (day: string): Entry[] =>
  (db
    .prepare(`SELECT * FROM entries WHERE day = ? AND deleted_at IS NULL ORDER BY eaten_at, id`)
    .all(day) as Entry[]).map(hydrate);

export type Totals = Record<Nutrient, number> & { nutrients: Micros };

export function totalsOf(entries: (Nutrients & { nutrients?: Micros })[]): Totals {
  const t = Object.fromEntries(NUTRIENTS.map((n) => [n, 0])) as unknown as Totals;
  t.nutrients = {};
  for (const e of entries) {
    for (const n of NUTRIENTS) t[n] += e[n] ?? 0;
    for (const [k, v] of Object.entries(e.nutrients ?? {})) t.nutrients[k] = (t.nutrients[k] ?? 0) + v;
  }
  for (const n of NUTRIENTS) t[n] = Math.round(t[n] * 10) / 10;
  for (const k of Object.keys(t.nutrients)) t.nutrients[k] = Math.round(t.nutrients[k]! * 10) / 10;
  return t;
}

/** Look up any nutrient total, core or free-form. Missing micro = 0. */
export const totalOf = (t: Totals, key: string): number =>
  (NUTRIENTS as readonly string[]).includes(key) ? t[key as Nutrient] : (t.nutrients[key] ?? 0);

export function dailyTotals(fromDay: string, toDay: string): { day: string; totals: Totals; count: number }[] {
  const rows = (db
    .prepare(`SELECT * FROM entries WHERE deleted_at IS NULL AND day BETWEEN ? AND ? ORDER BY day`)
    .all(fromDay, toDay) as Entry[]).map(hydrate);
  const byDay = new Map<string, Entry[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  return [...byDay.entries()].map(([day, es]) => ({ day, count: es.length, totals: totalsOf(es) }));
}

// ---- goals: any nutrient key ----
//   min    = reach at least (fiber, iron)          → "✓ hit" once reached
//   max    = stay under (sodium, sugar)            → "left" / "over"
//   target = land near it (calories, macros)       → "to go" / "over"
export type GoalKind = "min" | "max" | "target";
export type Goal = { value: number; kind: GoalKind };
const GOAL_KINDS: readonly string[] = ["min", "max", "target"];
const LIMIT_KEYS = new Set(["sodium", "sat_fat", "sugar", "added_sugar", "cholesterol_mg", "caffeine_mg", "alcohol_g"]);
const TARGET_KEYS = new Set(["kcal", "protein", "carbs", "fat"]);
// movement goals (see activity.ts): active minutes, steps, active kcal burned
export const MOVEMENT_GOAL_KEYS: readonly string[] = ["active_min", "steps", "active_kcal"];

export function getGoals(): Record<string, Goal> {
  const rows = db.prepare(`SELECT key, value, kind FROM goals ORDER BY key`).all() as { key: string; value: number; kind: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, { value: r.value, kind: (GOAL_KINDS.includes(r.kind) ? r.kind : "min") as GoalKind }]));
}

export function setGoal(key: string, value: number | null, kind?: GoalKind): void {
  if (CORE_ALIASES[key]) throw new Error(`"${key}" is a core field: use "${CORE_ALIASES[key]}"`);
  if (!(NUTRIENTS as readonly string[]).includes(key) && !MICRO_KEY.test(key) && !MOVEMENT_GOAL_KEYS.includes(key))
    throw new Error(`goal "${key}": use a core field (${NUTRIENTS.join(", ")}), a unit-suffixed nutrient like iron_mg, or a movement key (${MOVEMENT_GOAL_KEYS.join(", ")})`);
  if (value === null) {
    db.prepare(`DELETE FROM goals WHERE key = ?`).run(key);
    return;
  }
  if (!Number.isFinite(value) || value <= 0) throw new Error(`goal "${key}" needs a positive number`);
  const k = kind ?? (LIMIT_KEYS.has(key) ? "max" : TARGET_KEYS.has(key) ? "target" : "min");
  db.prepare(`INSERT INTO goals(key, value, kind) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, kind = excluded.kind`).run(key, value, k);
}

// ---- personal food library: things this person eats repeatedly, per serving ----
export type Food = Nutrients & {
  key: string;
  name: string;
  brand?: string | null;
  barcode?: string | null;
  serving_desc?: string | null;
  serving_g?: number | null;
  nutrients?: Micros;
  source?: string | null;
  source_ref?: string | null;
  notes?: string | null;
};

export const foodKey = (name: string, brand?: string | null) =>
  `${brand ? `${brand} ` : ""}${name}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const FOOD_FIELDS = ["key", "name", "brand", "barcode", "serving_desc", "serving_g", ...NUTRIENTS, "nutrients", "source", "source_ref", "notes"] as const;

export function saveFood(f: Omit<Food, "key" | "nutrients"> & { key?: string; nutrients?: Record<string, number | null> } & Record<string, unknown>): string {
  if (!f.name) throw new Error("food needs a name");
  const key = f.key ?? (f.barcode ? `upc:${f.barcode}` : foodKey(f.name, f.brand));
  const micros = collectMicros(f);
  let merged: string | null = null;
  if (micros) {
    const cur = db.prepare(`SELECT nutrients FROM foods WHERE key = ?`).get(key) as { nutrients: string | null } | null;
    merged = JSON.stringify(dropNulls({ ...parseMicros(cur?.nutrients), ...micros }));
  }
  const row: Record<string, unknown> = { ...f, key, nutrients: merged };
  db.prepare(
    `INSERT INTO foods (${FOOD_FIELDS.join(", ")}, updated_at) VALUES (${FOOD_FIELDS.map(() => "?").join(", ")}, ?)
     ON CONFLICT(key) DO UPDATE SET ${FOOD_FIELDS.filter((k) => k !== "key").map((k) => `${k} = COALESCE(excluded.${k}, ${k})`).join(", ")}, updated_at = excluded.updated_at`,
  ).run(...(FOOD_FIELDS.map((k) => row[k] ?? null) as never[]), localIso() as never);
  return key;
}

export function findFoods(q: string, limit = 10): Food[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const where = words.map(() => `(lower(name) LIKE ? OR lower(COALESCE(brand,'')) LIKE ? OR key LIKE ?)`).join(" AND ");
  const args = words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`]);
  return (db.prepare(`SELECT * FROM foods WHERE ${where} ORDER BY updated_at DESC LIMIT ${limit}`).all(...args) as Food[]).map(hydrate);
}

export const foodByBarcode = (code: string): Food | null => {
  const r = db.prepare(`SELECT * FROM foods WHERE barcode = ? OR barcode = ? LIMIT 1`).get(code, code.replace(/^0+/, "")) as Food | null;
  return r ? hydrate(r) : null;
};

// ---- gut symptoms, logged alongside food so patterns can be found later ----
export function addSymptom(s: { kind: string; severity?: number | null; notes?: string | null; at?: string }): number {
  const at = s.at ?? localIso();
  const res = db
    .prepare(`INSERT INTO symptoms (day, at, kind, severity, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(localDay(new Date(at)), at, s.kind, s.severity ?? null, s.notes ?? null, localIso());
  return Number(res.lastInsertRowid);
}

export const symptomsSince = (day: string) =>
  db.prepare(`SELECT * FROM symptoms WHERE day >= ? ORDER BY at`).all(day);
