import { spawn } from "node:child_process";
import path from "node:path";
import { REPO } from "../core/paths.ts";

/**
 * Run `coach` as a given profile in a child process. The bridge serves several
 * people but core/db.ts binds one DB per process, so per-person work always
 * goes through the CLI.
 */
export function coachCli(profile: string, args: string[], timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, COACH_PROFILE: profile };
    delete env.COACH_DB;
    const child = spawn(path.join(REPO, "bin", "coach"), args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      try {
        const v = JSON.parse(out) as { error?: string };
        if (v && typeof v === "object" && "error" in v) reject(new Error(v.error));
        else resolve(v);
      } catch {
        reject(new Error(`coach ${args[0]} exited ${code}: ${out.slice(0, 200)}`));
      }
    });
    child.on("error", reject);
  });
}
