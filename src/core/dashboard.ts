// "Where am I today?" — a phone-shaped PNG built as SVG and rasterised with
// resvg (no browser). Static image, so no hover layer: every value that
// matters is direct-labeled and the meals table doubles as the table view.
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";
import { MACROS, dailyTotals, entriesFor, getGoals, totalOf, totalsOf, unitOf, type Entry, type Goal, type Totals } from "./db.ts";
import { OUT, shiftDay } from "./paths.ts";
import { DAILY, activitiesFor, isMovementKey, movementByDay, movementOf, type Movement } from "./activity.ts";

// Reference palette (dataviz skill), light mode. Slots 1–3 validated all-pairs;
// aqua is < 3:1 on the surface, so every segment is also labeled in text.
const C = {
  plane: "#f9f9f7",
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  border: "rgba(11,11,11,0.10)",
  track: "#cde2fb", // blue 100
  fill: "#2a78d6", // blue 450 / series-1
  dim: "#b7d3f6", // blue 150 — de-emphasised columns
  protein: "#2a78d6",
  carbs: "#eb6834",
  fat: "#1baf7a",
};

const W = 600;
const PAD = 24;
const INNER = W - PAD * 2;
const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
// small amounts (iron 8.4 mg, B12 2.4 mcg) need a decimal to mean anything
const amt = (n: number) => (Math.abs(n) < 20 && n % 1 !== 0 ? n.toFixed(1) : fmt(n));

const LABELS: Record<string, string> = {
  protein: "Protein", carbs: "Carbs", fat: "Fat", fiber: "Fiber", sugar: "Sugar", added_sugar: "Added sugar",
  sat_fat: "Saturated fat", sodium: "Sodium", kcal: "Calories",
  active_min: "Active minutes", steps: "Steps", active_kcal: "Active calories",
};
const MOVE_UNITS: Record<string, string> = { active_min: "min", steps: "", active_kcal: "kcal" };
/** unit for any goal key: nutrient (from db) or movement */
const unitFor = (k: string) => (isMovementKey(k) ? MOVE_UNITS[k]! : unitOf(k));
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
/** "18 mg", "30 min", but "6,800" for unitless steps */
const withUnit = (v: string, unit: string) => (unit ? `${v} ${unit}` : v);
/** iron_mg → "Iron", vitamin_b12_mcg → "Vitamin B12", omega_3_g → "Omega 3" */
export const labelOf = (key: string) =>
  LABELS[key] ??
  key
    .replace(/_(g|mg|mcg|iu)$/, "")
    .split("_")
    .map((w, i) => (w.length === 1 || /^b\d+$/.test(w) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ")
    .replace(/^Vitamin ([a-z0-9]+)/i, (_, v: string) => `Vitamin ${v.toUpperCase()}`);

/** One goal meter row: label, "v / goal unit" + note, track + fill. */
function meterRow(ry: number, label: string, v: number, g: Goal | undefined, unit: string) {
  let body = t(PAD, ry + 14, label, 15, C.ink, `font-weight="600"`);
  const valueText = g ? `${amt(v)} / ${withUnit(amt(g.value), unit)}` : withUnit(amt(v), unit);
  let note = "  no goal";
  if (g?.kind === "max") note = v > g.value ? `  ${amt(v - g.value)} over` : `  ${amt(g.value - v)} left`;
  else if (g?.kind === "target") note = v - g.value >= 1 ? `  +${amt(v - g.value)} over` : v >= g.value ? "  reached" : `  ${amt(g.value - v)} to go`;
  else if (g) note = v >= g.value ? "  reached" : `  ${amt(g.value - v)} to go`;
  body += `<text x="${W - PAD}" y="${ry + 14}" font-size="15" text-anchor="end" ${FONT}><tspan fill="${C.ink}" font-weight="600">${esc(valueText)}</tspan><tspan fill="${C.muted}" font-size="13">${esc(note)}</tspan></text>`;
  body += bar(PAD, ry + 24, INNER, 8, g ? C.track : C.grid, 4);
  if (g) body += bar(PAD, ry + 24, INNER * Math.min(v / g.value, 1), 8, C.fill, 4);
  return body;
}
const t = (x: number, y: number, s: string, size: number, fill: string, extra = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${FONT} ${extra}>${esc(s)}</text>`;

/** Bar with a 4px rounded data-end and a square start. */
function bar(x: number, y: number, w: number, h: number, fill: string, r = 4) {
  if (w <= 0) return "";
  const rr = Math.min(r, w, h / 2);
  return `<path d="M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z" fill="${fill}"/>`;
}
function column(x: number, base: number, w: number, h: number, fill: string, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `<path d="M${x},${base} V${base - h + rr} Q${x},${base - h} ${x + rr},${base - h} H${x + w - rr} Q${x + w},${base - h} ${x + w},${base - h + rr} V${base} Z" fill="${fill}"/>`;
}

function card(y: number, h: number, body: string) {
  return `<rect x="${PAD - 12}" y="${y}" width="${INNER + 24}" height="${h}" rx="14" fill="${C.surface}" stroke="${C.border}"/>${body}`;
}

const MEAL_ORDER = ["breakfast", "lunch", "dinner", "snack", "drink"];

export function renderDashboard(day: string): { png: string; summary: string } {
  const entries = entriesFor(day);
  const tot = totalsOf(entries);
  const goals = getGoals();
  const acts = activitiesFor(day);
  const move = movementOf(acts);
  const parts: string[] = [];
  let y = PAD;

  // ---- header ----
  const [yy, mm, dd] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(yy, mm - 1, dd, 12);
  const title = date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  parts.push(t(PAD, y + 22, title, 22, C.ink, `font-weight="700"`));
  parts.push(t(W - PAD, y + 22, `${entries.length} item${entries.length === 1 ? "" : "s"} logged`, 13, C.muted, `text-anchor="end"`));
  y += 44;

  // ---- hero: calories ----
  {
    const kcalGoal = goals.kcal?.value;
    const h = kcalGoal ? 118 : 96;
    const top = y;
    let body = t(PAD, top + 28, "Calories", 13, C.ink2);
    // shown for context only; the calorie goal isn't adjusted by exercise
    if (move.active_kcal > 0) body += t(W - PAD, top + 28, `${fmt(move.active_kcal)} burned moving`, 13, C.muted, `text-anchor="end"`);
    body += t(PAD, top + 76, fmt(tot.kcal), 52, C.ink, `font-weight="700"`);
    if (kcalGoal) {
      const left = kcalGoal - tot.kcal;
      body += t(W - PAD, top + 76, left >= 0 ? `${fmt(left)} left of ${fmt(kcalGoal)}` : `${fmt(-left)} over ${fmt(kcalGoal)}`, 15, C.ink2, `text-anchor="end"`);
      const frac = Math.min(tot.kcal / kcalGoal, 1);
      body += bar(PAD, top + 92, INNER, 10, C.track, 5);
      body += bar(PAD, top + 92, INNER * frac, 10, C.fill, 5);
    } else {
      body += t(W - PAD, top + 76, "no calorie goal set", 13, C.muted, `text-anchor="end"`);
    }
    parts.push(card(top, h, body));
    y += h + 14;
  }

  // ---- macro meters ----
  {
    const rows = ["protein", "carbs", "fat", "fiber"];
    const rowH = 50;
    const top = y;
    let body = "";
    rows.forEach((k, i) => (body += meterRow(top + 18 + i * rowH, labelOf(k), totalOf(tot, k), goals[k], unitOf(k))));
    const h = 18 + rows.length * rowH;
    parts.push(card(top, h, body));
    y += h + 14;
  }

  // ---- anything else with a goal: iron, vitamin C, sodium… (free-form) ----
  const tracked = Object.keys(goals).filter((k) => !(MACROS as readonly string[]).includes(k) && !isMovementKey(k));
  if (tracked.length) {
    const rowH = 50;
    const top = y;
    let body = t(PAD, top + 28, "Tracking", 13, C.ink2);
    tracked.forEach((k, i) => (body += meterRow(top + 42 + i * rowH, labelOf(k), totalOf(tot, k), goals[k], unitOf(k))));
    const h = 42 + tracked.length * rowH;
    parts.push(card(top, h, body));
    y += h + 14;
  }

  // ---- movement: goal meters, a totals line, then each activity ----
  const moveGoals = Object.keys(goals).filter(isMovementKey);
  if (acts.length || moveGoals.length) {
    const top = y;
    let ry = top + 28;
    let body = t(PAD, ry, "Movement", 13, C.ink2);
    ry += 14;
    for (const k of moveGoals) {
      body += meterRow(ry, labelOf(k), move[k], goals[k], MOVE_UNITS[k]!);
      ry += 50;
    }
    const ungoaled = (["active_min", "steps", "active_kcal"] as const).filter((k) => !goals[k] && move[k] > 0);
    if (ungoaled.length) {
      ry += 18;
      const words: Record<string, string> = { active_min: "min active", steps: "steps", active_kcal: "kcal burned" };
      body += t(PAD, ry, ungoaled.map((k) => `${fmt(move[k])} ${words[k]}`).join("  ·  "), 15, C.ink, `font-weight="600"`);
      ry += 8;
    }
    if (acts.length) {
      ry += 8;
      body += `<line x1="${PAD}" x2="${W - PAD}" y1="${ry}" y2="${ry}" stroke="${C.grid}"/>`;
      // several daily summaries = updated snapshots; only the latest counts, so only it shows
      const lastDaily = acts.filter((x) => x.kind === DAILY).at(-1);
      for (const a of acts.filter((x) => x.kind !== DAILY || x === lastDaily)) {
        ry += 22;
        const name = a.kind === DAILY ? "Daily summary" : (a.name ?? cap(a.kind));
        const left = [name, a.distance_km ? `${amt(a.distance_km)} km` : "", a.kind === DAILY && a.steps ? `${fmt(a.steps)} steps` : ""].filter(Boolean).join(" · ");
        const right = [a.duration_min ? `${fmt(a.duration_min)} min` : "", a.kcal_burned ? `${a.confidence === "low" ? "~" : ""}${fmt(a.kcal_burned)} kcal` : ""].filter(Boolean).join("  ·  ");
        body += t(PAD, ry, left.length > 48 ? left.slice(0, 47) + "…" : left, 13.5, C.ink2);
        body += t(W - PAD, ry, right, 13.5, C.muted, `text-anchor="end"`);
      }
    } else {
      ry += 22;
      body += t(PAD, ry, "Nothing logged yet.", 13.5, C.muted);
    }
    const h = ry - top + 20;
    parts.push(card(top, h, body));
    y += h + 14;
  }

  // ---- where the calories came from (part-to-whole) ----
  {
    const top = y;
    const kp = tot.protein * 4, kc = tot.carbs * 4, kf = tot.fat * 9;
    const sum = kp + kc + kf;
    let body = t(PAD, top + 28, "Calories from", 13, C.ink2);
    if (sum > 0) {
      const segs: [string, number, string][] = [
        ["Protein", kp, C.protein],
        ["Carbs", kc, C.carbs],
        ["Fat", kf, C.fat],
      ];
      let x = PAD;
      const GAP = 2;
      const usable = INNER - GAP * (segs.filter((s) => s[1] > 0).length - 1);
      const live = segs.filter((s) => s[1] > 0);
      live.forEach(([, v, col], i) => {
        const w = (usable * v) / sum;
        const last = i === live.length - 1;
        // rounded ends only on the outer edges of the stack
        if (i === 0 && last) body += `<rect x="${x}" y="${top + 42}" width="${w}" height="18" rx="4" fill="${col}"/>`;
        else if (i === 0) body += `<path d="M${x + w},${top + 42} H${x + 4} Q${x},${top + 42} ${x},${top + 46} V${top + 56} Q${x},${top + 60} ${x + 4},${top + 60} H${x + w} Z" fill="${col}"/>`;
        else if (last) body += bar(x, top + 42, w, 18, col);
        else body += `<rect x="${x}" y="${top + 42}" width="${w}" height="18" fill="${col}"/>`;
        x += w + GAP;
      });
      // legend doubles as the direct labels: swatch + name + share
      let lx = PAD;
      for (const [name, v, col] of segs) {
        const label = `${name} ${Math.round((v / sum) * 100)}%`;
        body += `<rect x="${lx}" y="${top + 74}" width="10" height="10" rx="2" fill="${col}"/>`;
        body += t(lx + 16, top + 84, label, 13, C.ink2);
        lx += 16 + label.length * 7.4 + 18;
      }
    } else {
      body += t(PAD, top + 58, "Nothing logged yet.", 15, C.muted);
    }
    const h = 100;
    parts.push(card(top, h, body));
    y += h + 14;
  }

  // ---- meals table (the table view) ----
  if (entries.length) {
    const top = y;
    const cols = [
      ["kcal", 360],
      ["P", 420],
      ["C", 470],
      ["F", 520],
      ["Fib", W - PAD],
    ] as const;
    let body = t(PAD, top + 28, "Meals", 13, C.ink2);
    for (const [label, x] of cols) body += t(x, top + 28, label, 12, C.muted, `text-anchor="end"`);
    let ry = top + 40;
    const groups = new Map<string, Entry[]>();
    for (const e of entries) {
      const k = (e.meal ?? "other").toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    const ordered = [...groups.entries()].sort(
      ([a], [b]) => (MEAL_ORDER.indexOf(a) + 1 || 99) - (MEAL_ORDER.indexOf(b) + 1 || 99),
    );
    for (const [meal, items] of ordered) {
      const mt = totalsOf(items);
      body += `<line x1="${PAD}" x2="${W - PAD}" y1="${ry}" y2="${ry}" stroke="${C.grid}"/>`;
      ry += 22;
      body += t(PAD, ry, meal[0]!.toUpperCase() + meal.slice(1), 15, C.ink, `font-weight="600"`);
      const vals = [mt.kcal, mt.protein, mt.carbs, mt.fat, mt.fiber];
      cols.forEach(([, x], i) => (body += t(x, ry, fmt(vals[i]!), 14, C.ink, `text-anchor="end" font-weight="600"`)));
      for (const e of items) {
        ry += 19;
        const est = e.confidence === "low" ? " ~" : "";
        const name = `${e.qty != null ? `${e.qty} ` : ""}${e.unit && e.qty != null ? `${e.unit} ` : ""}${e.item}${est}`;
        body += t(PAD + 10, ry, name.length > 44 ? name.slice(0, 43) + "…" : name, 12.5, C.ink2);
        const iv = [e.kcal, e.protein, e.carbs, e.fat, e.fiber];
        cols.forEach(([, x], i) => (body += t(x, ry, fmt(iv[i] ?? 0), 12.5, C.muted, `text-anchor="end"`)));
      }
      ry += 12;
    }
    const lowCount = entries.filter((e) => e.confidence === "low").length;
    if (lowCount) {
      ry += 6;
      body += t(PAD, ry, `~ rough estimate (${lowCount})`, 12, C.muted);
    }
    const h = ry - top + 14;
    parts.push(card(top, h, body));
    y += h + 14;
  }

  // ---- 7-day trends (emphasis: today in blue, prior days light) ----
  // Nutrients someone is trying to raise (e.g. iron) come first; fiber always.
  const trendKeys = [
    ...tracked.filter((k) => goals[k]!.kind === "min").slice(0, 2),
    ...moveGoals.filter((k) => goals[k]!.kind === "min").slice(0, 1),
    "fiber",
  ];
  const week = dailyTotals(shiftDay(day, -6), day);
  const weekMoves: Map<string, Movement> = movementByDay(shiftDay(day, -6), day);
  for (const key of trendKeys) {
    const unit = unitFor(key);
    const top = y;
    const byDay = isMovementKey(key)
      ? new Map([...weekMoves].map(([d, m]) => [d, m[key]]))
      : new Map(week.map((d) => [d.day, totalOf(d.totals, key)]));
    const days = Array.from({ length: 7 }, (_, i) => shiftDay(day, i - 6));
    const vals = days.map((d) => byDay.get(d) ?? 0);
    const goal = goals[key]?.value ?? 0;
    const max = Math.max(goal, ...vals, unit === "g" ? 10 : 1) * 1.15;
    const chartTop = top + 44, base = top + 164, ch = base - chartTop;
    let body = t(PAD, top + 28, `${labelOf(key)} · last 7 days`, 13, C.ink2);
    body += `<line x1="${PAD}" x2="${W - PAD}" y1="${base}" y2="${base}" stroke="${C.axis}"/>`;
    if (goal) {
      const gy = base - (goal / max) * ch;
      body += `<line x1="${PAD}" x2="${W - PAD}" y1="${gy}" y2="${gy}" stroke="${C.grid}"/>`;
      // left edge: today's value label sits above the rightmost column
      body += t(PAD, gy - 5, `goal ${withUnit(amt(goal), unit)}`, 11.5, C.muted);
    }
    const slot = INNER / 7;
    const bw = 24;
    days.forEach((d, i) => {
      const x = PAD + slot * i + (slot - bw) / 2;
      const isToday = d === day;
      body += column(x, base, bw, (vals[i]! / max) * ch, isToday ? C.fill : C.dim);
      const [a, b, c] = d.split("-").map(Number) as [number, number, number];
      const lbl = new Date(a, b - 1, c, 12).toLocaleDateString("en-US", { weekday: "short" });
      body += t(x + bw / 2, base + 18, isToday ? "Today" : lbl, 11.5, isToday ? C.ink : C.muted, `text-anchor="middle"${isToday ? ` font-weight="600"` : ""}`);
      if (isToday) body += t(x + bw / 2, base - (vals[i]! / max) * ch - 6, withUnit(amt(vals[i]!), unit), 12, C.ink, `text-anchor="middle" font-weight="600"`);
    });
    // average only over days that have a log — an unlogged day isn't a 0 day
    const logged = days.filter((d) => byDay.has(d)).map((d) => byDay.get(d)!);
    const avg = logged.length ? logged.reduce((s, v) => s + v, 0) / logged.length : 0;
    body += t(PAD, base + 40, `Average ${withUnit(amt(avg), unit)}/day over ${logged.length} logged day${logged.length === 1 ? "" : "s"}`, 12.5, C.ink2);
    const h = 216;
    parts.push(card(top, h, body));
    y += h + 14;
  }

  const H = y + PAD - 14;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="${C.plane}"/>${parts.join("")}</svg>`;
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: W * 2 },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue", sansSerifFamily: "Helvetica Neue" },
  })
    .render()
    .asPng();
  const file = path.join(OUT, `day-${day}-${Date.now()}.png`);
  fs.writeFileSync(file, png);

  return { png: file, summary: summarize(day, tot, goals, entries.length, move) };
}

export function summarize(day: string, tot: Totals, goals: Record<string, Goal>, count: number, move?: Movement): string {
  const moved = move && (move.active_min || move.steps || move.active_kcal);
  if (!count && !moved) return `Nothing logged for ${day} yet.`;
  const piece = (k: string, label: string, v: number) => {
    const unit = unitFor(k);
    return goals[k] ? `${label} ${amt(v)}/${amt(goals[k]!.value)}${unit}` : `${label} ${amt(v)}${unit}`;
  };
  const tracked = Object.keys(goals).filter((k) => !(MACROS as readonly string[]).includes(k) && !isMovementKey(k));
  const moveLine = moved
    ? (["active_min", "steps", "active_kcal"] as const)
        .filter((k) => move[k] > 0 || goals[k])
        .map((k) => (goals[k] ? `${labelOf(k)} ${fmt(move[k])}/${withUnit(fmt(goals[k]!.value), MOVE_UNITS[k]!)}` : `${withUnit(fmt(move[k]), MOVE_UNITS[k]!)}${k === "steps" ? " steps" : k === "active_kcal" ? " burned" : " active"}`))
        .join(" · ")
    : "";
  return [
    goals.kcal ? `${fmt(tot.kcal)} / ${fmt(goals.kcal.value)} kcal eaten` : `${fmt(tot.kcal)} kcal eaten`,
    [piece("protein", "P", tot.protein), piece("carbs", "C", tot.carbs), piece("fat", "F", tot.fat), piece("fiber", "Fiber", tot.fiber)].join(" · "),
    tracked.length ? tracked.map((k) => piece(k, labelOf(k), totalOf(tot, k))).join(" · ") : "",
    moveLine ? `Moved: ${moveLine}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
