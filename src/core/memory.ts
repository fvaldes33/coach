// What the coach has learned about a person that isn't a log row: portion
// habits, how they cook, preferences, open follow-ups. Written down the moment
// it's learned (not summarized later), so it survives compaction and would
// survive a session rollover. A plain markdown file per profile: `## section`
// headings with `- note` bullets, readable and hand-editable.
import fs from "node:fs";
import path from "node:path";
import { profileDir } from "./paths.ts";

export const SECTION = /^[a-z][a-z0-9-]{0,31}$/;
/** Suggested sections, in display order; any slug works. */
export const SECTIONS = ["foods", "habits", "preferences", "health", "followups"];
const MAX_NOTE = 400;
const SOFT_LIMIT = 6_000; // chars; past this the coach is told to consolidate

export const memoryPath = (id: string) => path.join(profileDir(id), "memory.md");

type Memory = Map<string, string[]>;

function load(id: string): Memory {
  const mem: Memory = new Map();
  let file = "";
  try {
    file = fs.readFileSync(memoryPath(id), "utf8");
  } catch {
    return mem;
  }
  let cur = "notes";
  for (const line of file.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = h[1]!.toLowerCase();
      if (!mem.has(cur)) mem.set(cur, []);
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (b) mem.set(cur, [...(mem.get(cur) ?? []), b[1]!]);
  }
  return mem;
}

function render(mem: Memory): string {
  const order = [...SECTIONS.filter((s) => mem.has(s)), ...[...mem.keys()].filter((s) => !SECTIONS.includes(s)).sort()];
  const parts = order.filter((s) => mem.get(s)!.length).map((s) => `## ${s}\n${mem.get(s)!.map((n) => `- ${n}`).join("\n")}`);
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

function save(id: string, mem: Memory) {
  const p = memoryPath(id);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, render(mem));
  fs.renameSync(tmp, p);
}

function section(s: string | undefined): string {
  const k = (s ?? "").trim().toLowerCase();
  if (!SECTION.test(k)) throw new Error(`section must be a lowercase slug, e.g. ${SECTIONS.join(", ")}`);
  return k;
}

function note(t: string | undefined): string {
  const n = (t ?? "").replace(/\s+/g, " ").trim();
  if (!n) throw new Error("empty note");
  if (n.length > MAX_NOTE) throw new Error(`note too long (${n.length} > ${MAX_NOTE} chars): keep it to one fact`);
  return n;
}

function slot(mem: Memory, s: string, n: number): number {
  const list = mem.get(s) ?? [];
  if (!Number.isInteger(n) || n < 1 || n > list.length) throw new Error(`no note ${s} #${n} (${s} has ${list.length})`);
  return n - 1;
}

export function memoryView(id: string) {
  const mem = load(id);
  const text = render(mem);
  return {
    sections: Object.fromEntries([...mem].filter(([, v]) => v.length).map(([k, v]) => [k, v.map((t, i) => `${i + 1}. ${t}`)])),
    chars: text.length,
    ...(text.length > SOFT_LIMIT ? { hint: "memory is getting long: merge duplicates and drop stale notes (coach memory edit/rm)" } : {}),
  };
}

/** The file as-is, for the bridge to put in the worker prompt. */
export const memoryText = (id: string) => render(load(id)).trim();

export function addNote(id: string, s: string | undefined, t: string | undefined) {
  const mem = load(id);
  const k = section(s);
  const n = note(t);
  const list = mem.get(k) ?? [];
  if (list.some((x) => x.toLowerCase() === n.toLowerCase())) return memoryView(id);
  list.push(n);
  mem.set(k, list);
  save(id, mem);
  return memoryView(id);
}

export function editNote(id: string, s: string | undefined, n: number, t: string | undefined) {
  const mem = load(id);
  const k = section(s);
  mem.get(k)![slot(mem, k, n)] = note(t);
  save(id, mem);
  return memoryView(id);
}

export function removeNote(id: string, s: string | undefined, n: number) {
  const mem = load(id);
  const k = section(s);
  mem.get(k)!.splice(slot(mem, k, n), 1);
  save(id, mem);
  return memoryView(id);
}
