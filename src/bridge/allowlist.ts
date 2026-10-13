// Who the coach will listen to. Fail-closed: exact handle match only, 1:1
// chats only. (A looser `sender.includes(handle)` would also accept any
// address that merely contains the digits, e.g. a different country prefix.)

import { isProfileId } from "../core/paths.ts";

export type Operator = {
  /** profile id: names the person's data dir and session. lowercase slug */
  id: string;
  handle: string;
  name: string;
  /** free text the coach should know: goals, conditions, preferences */
  notes?: string;
  /** "non-technical" = plain, warm language, no jargon */
  style?: string;
};

/** Canonical form: lowercase email, or phone as digits with US country code. */
export function normalizeHandle(raw: string): string {
  const s = raw.trim().replace(/^(tel|mailto|sms|imessage):/i, "");
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

export function makeAllowlist(operators: Operator[]) {
  const byHandle = new Map<string, Operator>();
  const ids = new Set<string>();
  for (const o of operators) {
    if (!o.id || !isProfileId(o.id)) throw new Error(`config.json: ${o.name} needs an "id" (lowercase slug, e.g. "alex")`);
    if (ids.has(o.id)) throw new Error(`config.json: duplicate profile id "${o.id}"`);
    ids.add(o.id);
    const key = normalizeHandle(o.handle);
    // a handle that normalizes to nothing (or a too-short number) would be a hole
    if (!key.includes("@") && key.length < 11) throw new Error(`config.json: handle for ${o.name} is not a full phone number or email`);
    if (byHandle.has(key)) throw new Error(`config.json: handle for ${o.name} is listed twice`);
    byHandle.set(key, o);
  }
  if (!byHandle.size) throw new Error("config.json: no operators — refusing to start with an empty allowlist");
  return (sender: string | undefined | null): Operator | undefined =>
    sender ? byHandle.get(normalizeHandle(sender)) : undefined;
}

/**
 * iMessage group chat? Spectrum's iMessage space carries type "dm" | "group";
 * chat guids also encode it (`any;-;` DM vs `any;+;` group). Either signal
 * counts. Groups are dropped even when the operator is in them, since a
 * reply there would go to everyone.
 */
export function isGroupSpace(space: { id?: string; type?: unknown } | undefined, chatGuid?: string): boolean {
  if (space?.type === "group") return true;
  return [space?.id, chatGuid].some((g) => typeof g === "string" && g.includes(";+;"));
}
