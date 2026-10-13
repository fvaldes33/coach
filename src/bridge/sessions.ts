import fs from "node:fs";
import path from "node:path";
import { DATA } from "../core/paths.ts";

// Per-conversation worker session ids. The session is keyed by worker too, so
// flipping COACH_WORKER between claude and codex never tries to resume a
// foreign id. The CLI's own auto-compaction keeps the long thread alive.
const SESSIONS = path.join(DATA, "sessions.json");
const sessions: Record<string, string> = fs.existsSync(SESSIONS)
  ? JSON.parse(fs.readFileSync(SESSIONS, "utf8"))
  : {};

const save = () => fs.writeFileSync(SESSIONS, JSON.stringify(sessions, null, 2));

export const getSession = (key: string): string | undefined => sessions[key];
export const setSession = (key: string, id: string) => {
  sessions[key] = id;
  save();
};
export const clearSession = (key: string) => {
  delete sessions[key];
  save();
};
