// Free nutrition data sources the worker calls through the `coach` CLI.
//  - Open Food Facts: barcode → product + nutrition label (no key)
//  - UPCitemdb trial: barcode → product name/brand only (no key, ~100/day) —
//    a name to web-search when OFF has never seen the product
//  - USDA FoodData Central: generic + branded foods (USDA_API_KEY, else DEMO_KEY)
import type { Micros, Nutrients } from "./db.ts";

type Found = Nutrients & { nutrients?: Micros };

const UA = "coach-bridge/0.1 (personal nutrition log; local use)";

const round = (v: unknown, dp = 1): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null;

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json", ...init?.headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

// ---------------- Open Food Facts ----------------
type OffNutriments = Record<string, number | string | undefined>;

// OFF stores minerals/vitamins in grams; convert to the unit in our key.
const OFF_MICROS: [offKey: string, key: string, factor: number][] = [
  ["iron", "iron_mg", 1000],
  ["vitamin-c", "vitamin_c_mg", 1000],
  ["calcium", "calcium_mg", 1000],
  ["potassium", "potassium_mg", 1000],
  ["magnesium", "magnesium_mg", 1000],
  ["zinc", "zinc_mg", 1000],
  ["vitamin-b12", "vitamin_b12_mcg", 1_000_000],
  ["vitamin-d", "vitamin_d_mcg", 1_000_000],
  ["folates", "folate_mcg", 1_000_000],
  ["vitamin-a", "vitamin_a_mcg", 1_000_000],
  ["cholesterol", "cholesterol_mg", 1000],
  ["caffeine", "caffeine_mg", 1000],
];

function offNutrients(n: OffNutriments, suffix: "_100g" | "_serving"): Found | null {
  const g = (k: string) => (typeof n[k + suffix] === "number" ? (n[k + suffix] as number) : null);
  const kcal = g("energy-kcal") ?? (g("energy") !== null ? g("energy")! / 4.184 : null);
  const micros: Micros = {};
  for (const [ok, key, f] of OFF_MICROS) {
    const v = g(ok);
    if (v !== null) micros[key] = round(v * f, 2)!;
  }
  const out: Found = {
    kcal: round(kcal, 0),
    protein: round(g("proteins")),
    carbs: round(g("carbohydrates")),
    fat: round(g("fat")),
    fiber: round(g("fiber")),
    sugar: round(g("sugars")),
    added_sugar: round(g("added-sugars")),
    sat_fat: round(g("saturated-fat")),
    sodium: g("sodium") !== null ? round(g("sodium")! * 1000, 0) : null,
  };
  if (Object.keys(micros).length) out.nutrients = micros;
  return Object.values(out).some((v) => v !== null && v !== undefined) ? out : null;
}

export async function openFoodFacts(barcode: string) {
  const fields = "code,product_name,brands,quantity,serving_size,serving_quantity,nutriments,ingredients_text,allergens_tags,nutrition_data_per";
  const body = (await getJson(
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`,
  )) as { status?: number; product?: Record<string, unknown> };
  if (body.status !== 1 || !body.product) return null;
  const p = body.product;
  const n = (p.nutriments ?? {}) as OffNutriments;
  return {
    source: "openfoodfacts",
    source_ref: `https://world.openfoodfacts.org/product/${barcode}`,
    barcode,
    name: (p.product_name as string) || null,
    brand: (p.brands as string) || null,
    package_quantity: (p.quantity as string) || null,
    serving_desc: (p.serving_size as string) || null,
    serving_g: round(Number(p.serving_quantity) || null),
    per_serving: offNutrients(n, "_serving"),
    per_100g: offNutrients(n, "_100g"),
    ingredients: ((p.ingredients_text as string) || "").slice(0, 600) || null,
    note: "Crowd-sourced data: sanity-check kcal ≈ 4P + 4C + 9F and verify against the package photo or brand site when it looks off.",
  };
}

// ---------------- UPCitemdb (name only) ----------------
export async function upcItemDb(barcode: string) {
  try {
    const body = (await getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`)) as {
      items?: { title?: string; brand?: string; size?: string; description?: string }[];
    };
    const it = body.items?.[0];
    if (!it) return null;
    return { source: "upcitemdb", barcode, name: it.title ?? null, brand: it.brand ?? null, size: it.size ?? null, description: it.description?.slice(0, 300) ?? null };
  } catch (e) {
    return { source: "upcitemdb", barcode, error: String(e) };
  }
}

// ---------------- USDA FoodData Central ----------------
const FDC = "https://api.nal.usda.gov/fdc/v1";
const fdcKey = () => process.env.USDA_API_KEY || "DEMO_KEY";

// FDC nutrient ids. Foundation foods sometimes carry only the Atwater
// energy variants (2047/2048) instead of 1008.
const NUTRIENT_IDS: Record<number, keyof Nutrients> = {
  1008: "kcal",
  2047: "kcal",
  2048: "kcal",
  1003: "protein",
  1005: "carbs",
  1004: "fat",
  1079: "fiber",
  2000: "sugar",
  1063: "sugar",
  1235: "added_sugar",
  1258: "sat_fat",
  1093: "sodium",
};

// Free-form micros (keys carry the unit FDC reports them in).
const MICRO_IDS: Record<number, string> = {
  1089: "iron_mg",
  1162: "vitamin_c_mg",
  1087: "calcium_mg",
  1092: "potassium_mg",
  1090: "magnesium_mg",
  1095: "zinc_mg",
  1178: "vitamin_b12_mcg",
  1114: "vitamin_d_mcg",
  1190: "folate_mcg",
  1177: "folate_mcg", // total folate when DFE is absent
  1106: "vitamin_a_mcg",
  1253: "cholesterol_mg",
  1057: "caffeine_mg",
};

function fdcNutrients(list: { nutrientId?: number; nutrient?: { id?: number }; value?: number; amount?: number }[]): Found {
  const out: Found = {};
  const micros: Micros = {};
  for (const fn of list) {
    const id = fn.nutrientId ?? fn.nutrient?.id;
    const v = fn.value ?? fn.amount;
    if (id === undefined || typeof v !== "number") continue;
    const key = NUTRIENT_IDS[id];
    if (key && out[key] == null) out[key] = round(v, key === "kcal" || key === "sodium" ? 0 : 1);
    const mk = MICRO_IDS[id];
    if (mk && micros[mk] == null) micros[mk] = round(v, 2)!;
  }
  if (Object.keys(micros).length) out.nutrients = micros;
  return out;
}

export async function usdaSearch(query: string, n = 6, types = "Foundation,SR Legacy,Survey (FNDDS),Branded") {
  const url = `${FDC}/foods/search?api_key=${fdcKey()}&query=${encodeURIComponent(query)}&pageSize=${n}&dataType=${encodeURIComponent(types)}`;
  const body = (await getJson(url)) as { foods?: Record<string, unknown>[] };
  return (body.foods ?? []).map((f) => ({
    fdcId: f.fdcId,
    description: f.description,
    dataType: f.dataType,
    brand: f.brandName ?? f.brandOwner ?? null,
    serving: f.servingSize ? `${f.servingSize} ${f.servingSizeUnit ?? ""}`.trim() : null,
    household_serving: f.householdServingFullText ?? null,
    // Search results are per 100 g for every data type (Branded included).
    per_100g: fdcNutrients((f.foodNutrients ?? []) as never),
  }));
}

export async function usdaFood(fdcId: string | number) {
  const f = (await getJson(`${FDC}/food/${fdcId}?api_key=${fdcKey()}`)) as Record<string, unknown>;
  const portions = ((f.foodPortions ?? []) as Record<string, unknown>[]).map((p) => ({
    desc: [p.amount, (p.measureUnit as { name?: string })?.name !== "undetermined" ? (p.measureUnit as { name?: string })?.name : null, p.modifier, p.portionDescription]
      .filter(Boolean)
      .join(" "),
    grams: p.gramWeight,
  }));
  return {
    fdcId,
    description: f.description,
    dataType: f.dataType,
    brand: f.brandName ?? f.brandOwner ?? null,
    serving: f.servingSize ? `${f.servingSize} ${f.servingSizeUnit ?? ""}`.trim() : null,
    household_serving: f.householdServingFullText ?? null,
    per_100g: fdcNutrients((f.foodNutrients ?? []) as never),
    label_per_serving: f.labelNutrients ?? null,
    portions,
    source_ref: `https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients`,
  };
}
