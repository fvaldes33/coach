import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, WORKSPACE } from "../core/paths.ts";

// Headless worker runners: one contract for Claude Code and Codex.
// COACH_WORKER=codex runs jobs on Codex CLI; unset/claude = Claude Code.
// COACH_WORKER_MODEL overrides the model for either.
// Both run in coach/ so they load coach/AGENTS.md (the nutritionist brief),
// and both get bin/ on PATH so `coach …` works as a bare command.

export type WorkerRun = { text: string; sessionId: string | null; costUsd: number | null };
export type Worker = (profile: string, prompt: string, resumeId?: string, images?: string[]) => Promise<WorkerRun>;

export const WORKER_NAME = process.env.COACH_WORKER === "codex" ? "codex" : "claude";
const MODEL = process.env.COACH_WORKER_MODEL || (WORKER_NAME === "codex" ? "gpt-5.6" : "");
const TIMEOUT_MS = 20 * 60 * 1000;

function workerEnv(profile: string, strip: string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    COACH_BRIDGE: "1",
    // `coach` resolves this person's DB from the profile; COACH_DB is
    // removed below so nothing in the bridge's env can point it elsewhere.
    COACH_PROFILE: profile,
    PATH: `${path.join(REPO, "bin")}:${process.env.PATH ?? ""}`,
  };
  // Worker never needs bridge credentials.
  for (const k of [...strip, "COACH_DB", "PROJECT_ID", "PROJECT_SECRET", "TYPESAFE_API_KEY"]) delete env[k];
  return env;
}

function killAfter(child: ReturnType<typeof spawn>) {
  return setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000);
  }, TIMEOUT_MS);
}

// ---- claude (stream-json, stdin prompt, subscription auth) ----
// Non-bare -p loads CLAUDE.md, which is why ANTHROPIC_API_KEY is stripped:
// in -p the key always wins when present. Images are passed as paths in the
// prompt; Claude opens them with its Read tool.
const runClaude: Worker = (profile, prompt, resumeId) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "--print",
        "-",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        ...(MODEL ? ["--model", MODEL] : []),
        ...(resumeId ? ["--resume", resumeId] : []),
      ],
      {
        cwd: WORKSPACE,
        env: workerEnv(profile, ["ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_PARENT_SESSION"]),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.write(prompt);
    child.stdin.end();
    let buf = "",
      out = "",
      sessionId: string | null = null,
      costUsd: number | null = null;
    const timer = killAfter(child);
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          // session_id isn't reliably on the init event of --resume runs;
          // capture it wherever it shows up, last one wins.
          if (typeof ev.session_id === "string" && ev.session_id) sessionId = ev.session_id;
          if (ev.type === "result") {
            out = ev.result ?? out;
            costUsd = ev.total_cost_usd ?? null;
          }
        } catch {
          /* non-JSON stream line — skip */
        }
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || out) resolve({ text: out, sessionId, costUsd });
      else reject(new Error(`claude exited ${code}`));
    });
    child.on("error", reject);
  });

// ---- codex (exec --json; final message from -o file) ----
// Codex can't open image paths on its own, so photos go in with -i. Live web
// search is on so ambiguous foods can be looked up.
const runCodex: Worker = (profile, prompt, resumeId, images = []) =>
  new Promise((resolve, reject) => {
    const lastMsg = path.join(os.tmpdir(), `coach-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = [
      "exec",
      ...(resumeId ? ["resume", resumeId] : []),
      "--json",
      "-m",
      MODEL,
      // -C isn't valid on `resume`; a resumed session keeps its workspace.
      ...(resumeId ? [] : ["-C", WORKSPACE]),
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-c",
      'web_search="live"',
      "-o",
      lastMsg,
      ...images.flatMap((f) => ["-i", f]),
      "-", // prompt from stdin (required explicitly for `resume`)
    ];
    const child = spawn("codex", args, { cwd: WORKSPACE, env: workerEnv(profile, ["OPENAI_API_KEY"]), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.write(prompt);
    child.stdin.end();
    let buf = "",
      lastAgentMessage = "",
      sessionId: string | null = null;
    const timer = killAfter(child);
    const scanForId = (ev: unknown): void => {
      if (!ev || typeof ev !== "object") return;
      const o = ev as Record<string, unknown>;
      for (const k of ["thread_id", "session_id", "conversation_id"])
        if (typeof o[k] === "string" && o[k]) sessionId = o[k] as string;
      for (const v of Object.values(o)) if (v && typeof v === "object") scanForId(v);
    };
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          scanForId(ev);
          const item = (ev.item ?? ev.msg ?? {}) as Record<string, unknown>;
          const t = (item.text as string) ?? (item.message as string) ?? (ev.text as string);
          const kind = `${item.type ?? item.item_type ?? ev.type ?? ""}`;
          if (typeof t === "string" && t && /agent|message/i.test(kind)) lastAgentMessage = t;
        } catch {
          /* non-JSON line — skip */
        }
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = "";
      try {
        text = fs.readFileSync(lastMsg, "utf8").trim();
        fs.unlinkSync(lastMsg);
      } catch {
        /* fall back to stream capture */
      }
      if (!text) text = lastAgentMessage;
      if (code === 0 || text) resolve({ text, sessionId, costUsd: null });
      else reject(new Error(`codex exited ${code}`));
    });
    child.on("error", reject);
  });

export const runWorker: Worker = WORKER_NAME === "codex" ? runCodex : runClaude;
