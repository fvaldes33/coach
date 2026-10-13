#!/usr/bin/env bun
// `coach` — the only way the worker agent touches the food log.
// Every command prints JSON on stdout so the agent can parse it.
import { Database } from "bun:sqlite";
import { scanImage, toJpegIfNeeded } from "./core/barcode.ts";
import { renderDashboard } from "./core/dashboard.ts";
import {
  activitiesFor,
  addActivity,
  addMeasurement,
  editActivity,
  latestWeightKg,
  measurements,
  movementByDay,
  movementOf,
  removeActivity,
} from "./core/activity.ts";
import {
  addEntry,
  addSymptom,
  dailyTotals,
  db,
  editEntry,
  entriesFor,
  findFoods,
  foodByBarcode,
  getGoals,
  removeEntry,
  saveFood,
  setGoal,
  symptomsSince,
  totalsOf,
} from "./core/db.ts";
import { openFoodFacts, upcItemDb, usdaFood, usdaSearch } from "./core/lookup.ts";
import { SECTIONS, addNote, editNote, memoryView, removeNote } from "./core/memory.ts";
import { loadNudges, removeNudge, setNudge } from "./core/nudges.ts";
import { DB_PATH, PROFILE, resolveDay, shiftDay } from "./core/paths.ts";

const HELP = `coach — food log CLI (all output is JSON)

LOGGING
  coach log '<json | json[]>'        add entries. Required: item, kcal, protein, carbs, fat, fiber.
                                      Optional: meal (breakfast|lunch|dinner|snack|drink), brand, qty, unit,
                                      grams, sugar, added_sugar, sat_fat, sodium (mg), eaten_at (ISO, default now),
                                      nutrients: FREE-FORM {"iron_mg": 2.1, "vitamin_c_mg": 45, ...}: any key in
                                        snake_case ending in its unit (_g/_mg/_mcg/_iu). Top-level keys like
                                        "iron_mg" are accepted too.
                                      source (usda|openfoodfacts|label|brand-site|web|library|estimate),
                                      source_ref (url/fdcId), confidence (high|medium|low), tags (csv), notes, photo
  coach edit <id> '<json>'            patch an entry (nutrients merge per key; {"nutrients":{"iron_mg":null}} removes one)
  coach rm <id> [id...]               delete entries
  coach day [today|yesterday|-N|YYYY-MM-DD]   entries + totals + goals
  coach week [day]                    7 daily totals ending on day
  coach dashboard [day]               render the PNG dashboard → { png, summary }

LOOKUPS
  coach scan <image>                  decode barcode(s) from a photo (local, offline)
  coach barcode <digits>              library → Open Food Facts → UPCitemdb (name only)
  coach usda "<query>" [n]            USDA FoodData Central search (per 100 g)
  coach usda-food <fdcId>             one USDA food with household portions (grams)

LIBRARY (foods this person eats repeatedly, per serving)
  coach food find "<query>"
  coach food save '<json>'            name, brand?, barcode?, serving_desc, serving_g?, kcal, protein, carbs, fat,
                                      fiber, sugar?, added_sugar?, sat_fat?, sodium?, nutrients?, source, source_ref?, notes?

MOVEMENT
  coach move '<json | json[]>'        log activities. Required: kind + at least one of duration_min, steps, kcal_burned.
                                      kind: walk|run|strength|cycle|hike|yoga|swim|sport|hiit|other, or "daily" for a
                                      device's whole-day summary (steps / active kcal / exercise min; the latest
                                      "daily" of a day wins and is never added on top of that day's workouts).
                                      Optional: name, started_at (ISO, default now), distance_km, steps, kcal_burned
                                      (ACTIVE kcal), intensity (light|moderate|vigorous), met, source (watch|app|
                                      screenshot|estimate), confidence, notes, photo, details (free-form JSON:
                                      {"exercises":[{"name":"squat","sets":3,"reps":8,"weight_lb":185}], "avg_hr":142, ...}).
                                      Given met + duration_min and no kcal_burned → kcal = (MET-1) × weight_kg × hours.
  coach move edit <id> '<json>'       patch (details merge per key; null removes)
  coach move rm <id> [id...]
  coach measure '<json>'              body measurements, unit in the key: {"weight_lb": 182, "waist_in": 34,
                                      "resting_hr_bpm": 58, "sleep_h": 7.5, "at": ISO?, "notes": ...}
  coach measures [key] [n=30]

GUT
  coach symptom '<json>'              kind (bloating|gas|cramps|reflux|diarrhea|constipation|nausea|other),
                                      severity 0-10, notes, at (ISO, default now)
  coach symptoms [days=14]

GOALS
  coach goals                         show ({key: {value, kind}})
  coach goals set kcal=2200 protein=180 iron_mg=18 sodium=2300:max active_min=30 steps=8000 ...
                                      any core field or free-form nutrient key. Kinds: :min = reach at least
                                      (default), :max = stay under (default for sodium, sugar, sat_fat),
                                      :target = land near it (default for kcal, protein, carbs, fat). "none" clears.
                                      Every goal gets a bar on the dashboard; min-goals also get a 7-day trend.

MEMORY (what you've learned about this person that isn't a log row; shown to you every turn)
  coach memory                        show, numbered per section
  coach memory add <section> "<note>" one short fact per note. Sections: foods, habits, preferences, health, followups (any slug works)
  coach memory edit <section> <n> "<note>"
  coach memory rm <section> <n>

NUDGES (scheduled check-ins the bridge sends; you write the message when one fires)
  coach nudges                        list
  coach nudge set '<json>'            add or update by id: {"id":"lunch","at":"12:30","days":"weekdays","meal":"lunch",
                                      "about":"lunch check-in"}. days: daily|weekdays|weekends|mon,wed,fri.
                                      meal: skipped if that meal is already logged today. paused_until: YYYY-MM-DD
  coach nudge rm <id>

ANALYSIS
  coach sql "<SELECT …>"              read-only query (tables: entries, foods, activities, measurements, symptoms, goals).
                                      Free-form nutrients: json_extract(nutrients, '$.iron_mg')
`;

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const parse = (s: string | undefined, what: string) => {
  if (!s) throw new Error(`missing ${what} JSON`);
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`invalid ${what} JSON: ${s.slice(0, 120)}`);
  }
};

function dayView(day: string) {
  const entries = entriesFor(day);
  const activities = activitiesFor(day);
  return { day, totals: totalsOf(entries), movement: movementOf(activities), goals: getGoals(), entries, activities };
}

async function main(argv: string[]) {
  const [cmd, ...a] = argv;
  switch (cmd) {
    case "log": {
      const body = parse(a[0], "entry");
      const list = Array.isArray(body) ? body : [body];
      const ids = list.map((e) => addEntry(e));
      const { day } = db.prepare(`SELECT day FROM entries WHERE id = ?`).get(ids[0]!) as { day: string };
      const v = dayView(day);
      return out({ ids, day, totals: v.totals, goals: v.goals });
    }
    case "edit": {
      editEntry(Number(a[0]), parse(a[1], "patch"));
      return out({ ok: true, id: Number(a[0]) });
    }
    case "rm": {
      for (const id of a) removeEntry(Number(id));
      return out({ ok: true, removed: a.map(Number) });
    }
    case "day":
      return out(dayView(resolveDay(a[0])));
    case "week": {
      const end = resolveDay(a[0]);
      const from = shiftDay(end, -6);
      const moves = movementByDay(from, end);
      const food = new Map(dailyTotals(from, end).map((d) => [d.day, d]));
      const days = [...new Set([...food.keys(), ...moves.keys()])].sort();
      return out({
        goals: getGoals(),
        days: days.map((d) => ({ day: d, count: food.get(d)?.count ?? 0, totals: food.get(d)?.totals ?? null, movement: moves.get(d) ?? null })),
      });
    }
    case "dashboard":
      return out(renderDashboard(resolveDay(a[0])));
    case "scan": {
      if (!a[0]) throw new Error("usage: coach scan <image>");
      const file = toJpegIfNeeded(a[0]);
      return out({ file, barcodes: await scanImage(file) });
    }
    case "barcode": {
      const code = (a[0] ?? "").replace(/\D/g, "");
      if (!code) throw new Error("usage: coach barcode <digits>");
      const lib = foodByBarcode(code);
      if (lib) return out({ found: "library", food: lib });
      const off = await openFoodFacts(code).catch((e) => ({ error: String(e) }));
      if (off && !("error" in off) && (off.per_serving || off.per_100g)) return out({ found: "openfoodfacts", product: off });
      const upc = await upcItemDb(code);
      return out({
        found: upc && "name" in upc && upc.name ? "name-only" : "none",
        openfoodfacts: off,
        upcitemdb: upc,
        next: "No nutrition panel on file. Search the web for the product's official nutrition facts (brand site first), then `coach food save` it with the barcode so next time is instant.",
      });
    }
    case "usda":
      return out(await usdaSearch(a[0] ?? "", Number(a[1] ?? 6)));
    case "usda-food":
      return out(await usdaFood(a[0] ?? ""));
    case "food": {
      if (a[0] === "find") return out(findFoods(a.slice(1).join(" ")));
      if (a[0] === "save") return out({ key: saveFood(parse(a[1], "food")) });
      throw new Error("usage: coach food find|save");
    }
    case "move": {
      if (a[0] === "edit") {
        editActivity(Number(a[1]), parse(a[2], "activity patch"));
        return out({ ok: true, id: Number(a[1]) });
      }
      if (a[0] === "rm") {
        for (const id of a.slice(1)) removeActivity(Number(id));
        return out({ ok: true, removed: a.slice(1).map(Number) });
      }
      const body = parse(a[0], "activity");
      const list = Array.isArray(body) ? body : [body];
      const results = list.map((x) => addActivity(x));
      const { day } = db.prepare(`SELECT day FROM activities WHERE id = ?`).get(results[0]!.id) as { day: string };
      return out({ results, day, movement: movementOf(activitiesFor(day)), goals: getGoals() });
    }
    case "measure":
      return out({ ids: addMeasurement(parse(a[0], "measurement")), weight_kg: latestWeightKg() });
    case "measures":
      return out(measurements(a[0], Number(a[1] ?? 30)));
    case "symptom":
      return out({ id: addSymptom(parse(a[0], "symptom")) });
    case "symptoms":
      return out(symptomsSince(shiftDay(resolveDay(), -Number(a[0] ?? 14))));
    case "goals": {
      if (a[0] === "set") {
        for (const kv of a.slice(1)) {
          const m = kv.match(/^([a-z0-9_]+)=(none|[\d.]+)(?::(min|max|target))?$/);
          if (!m) throw new Error(`bad goal "${kv}": use key=number[:min|:max|:target] or key=none`);
          setGoal(m[1]!, m[2] === "none" ? null : Number(m[2]), m[3] as "min" | "max" | "target" | undefined);
        }
      }
      return out(getGoals());
    }
    case "memory": {
      const [sub, sec, ...rest] = a;
      if (!sub) return out({ ...memoryView(PROFILE), suggested_sections: SECTIONS });
      if (sub === "add") return out(addNote(PROFILE, sec, rest.join(" ")));
      if (sub === "edit") return out(editNote(PROFILE, sec, Number(rest[0]), rest.slice(1).join(" ")));
      if (sub === "rm") return out(removeNote(PROFILE, sec, Number(rest[0])));
      throw new Error("usage: coach memory [add <section> <note> | edit <section> <n> <note> | rm <section> <n>]");
    }
    case "nudges":
      return out(loadNudges(PROFILE));
    case "nudge": {
      if (a[0] === "set") return out(setNudge(PROFILE, parse(a[1], "nudge")));
      if (a[0] === "rm") return out(removeNudge(PROFILE, a[1] ?? ""));
      throw new Error("usage: coach nudge set '<json>' | coach nudge rm <id>");
    }
    case "sql": {
      const q = a.join(" ");
      if (!/^\s*(select|with|pragma table_info)/i.test(q)) throw new Error("read-only: SELECT/WITH only");
      const ro = new Database(DB_PATH, { readonly: true });
      return out(ro.prepare(q).all());
    }
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 2;
  }
}

// top-level await: bun would otherwise exit while the wasm decoder is loading
try {
  await main(process.argv.slice(2));
} catch (e) {
  console.log(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
  process.exitCode = 1;
}
