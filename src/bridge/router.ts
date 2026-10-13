// Fast intent routing with TypeSafe (Jev). One request, questions answered in
// parallel. Code owns the policy: only a confident, food-free "how am I doing"
// short-circuits to the deterministic dashboard; everything else goes to the
// worker, carrying the intent as a hint. If Jev is unavailable we fall back to
// a tiny regex so status still works and nothing is ever dropped.
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { log } from "./log.ts";

export type Route =
  | { kind: "status"; day: "today" | "yesterday"; why: string }
  | { kind: "worker"; hint: string };

const client = process.env.TYPESAFE_API_KEY ? new TypeSafeClient() : null;

const questions = {
  intent: choice(
    "What is the sender mainly asking their nutrition coach to do with this batch of iMessages?",
    {
      log_food: "Reports food or drink they ate, are eating, or sends a meal photo, nutrition label, or barcode to be logged",
      status: {
        covers: "Asks where they stand on the food log: totals, macros, calories left, progress, a chart or summary. Nothing new to log",
        examples: ["where am I today?", "where am I at", "how am I doing", "what's left for today", "show me my macros"],
      },
      log_activity: "Reports exercise or movement to log: a workout, walk, run, lift, class, steps, or a fitness app / watch screenshot",
      edit_log: "Corrects, changes, or deletes something already logged (wrong portion, remove an item or workout, it was lunch not dinner)",
      symptom: "Reports gut or digestive symptoms or how they feel (bloating, gas, cramps, reflux, bathroom issues)",
      goals: "Sets or changes calorie or macro targets",
      question: "Asks a nutrition question, for advice, suggestions, or analysis of patterns",
      other: "Anything else, including greetings or thanks",
    },
  ),
  // Speculative: only consumed when intent is status.
  day: choice("If the sender is asking about their totals, which day do they mean?", {
    today: "Today, now, so far, currently, or no day mentioned",
    yesterday: "Yesterday or last night",
    other_day: "A different specific day, a week, or a range of days",
  }),
  new_food: noul("Does any message in the batch mention food or drink the sender ate or is eating that has not been logged yet?"),
};

const STATUS_RE = /^\s*(where am i( at)?( today)?|status|dashboard|how('?m| am) i doing( today)?|macros|totals)\s*\??\s*$/i;

export async function route(texts: string[], mediaCount: number): Promise<Route> {
  if (mediaCount > 0) return { kind: "worker", hint: "media attached: food to log (meal photo, label, barcode) or a fitness screenshot" };
  if (!texts.length) return { kind: "worker", hint: "" };

  if (!client) {
    return texts.length === 1 && STATUS_RE.test(texts[0]!)
      ? { kind: "status", day: "today", why: "regex (no TYPESAFE_API_KEY)" }
      : { kind: "worker", hint: "" };
  }

  try {
    const now = new Date();
    const { answers, usage } = await client.systemOne(
      {
        state: {
          conversation: "iMessage thread between the sender and their personal AI nutrition coach, which logs meals and workouts and tracks calories, macros, fiber, and movement",
          messages: texts,
          local_time: now.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" }),
        },
        questions,
      },
      { timeout: 8_000, retry: { maxRetries: 1 } },
    );
    const { intent, day, new_food } = answers;
    const probs = Object.entries(intent.probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(" ");
    log(`jev: ${probs} day=${day.choice}(${day.confidence.toFixed(2)}) new_food=${new_food.noul.toFixed(2)} tokens=${usage.input_tokens}+${usage.output_tokens}`);

    if (
      intent.choice === "status" &&
      intent.confidence >= 0.7 &&
      new_food.noul < 0.3 &&
      day.choice !== "other_day" &&
      day.confidence >= 0.7
    )
      return { kind: "status", day: day.choice, why: `jev status ${intent.confidence.toFixed(2)}` };

    return {
      kind: "worker",
      hint: `router guess: ${intent.choice} (${intent.confidence.toFixed(2)})${new_food.noul >= 0.5 ? ", mentions food to log" : ""}`,
    };
  } catch (e) {
    log(`jev failed, falling back: ${String(e).slice(0, 140)}`);
    return texts.length === 1 && STATUS_RE.test(texts[0]!)
      ? { kind: "status", day: "today", why: "regex (jev error)" }
      : { kind: "worker", hint: "" };
  }
}
