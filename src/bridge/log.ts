import fs from "node:fs";
import path from "node:path";
import { DATA } from "../core/paths.ts";

const LOG = path.join(DATA, "events.log");

export const log = (line: string) => {
  const entry = `${new Date().toISOString()} ${line}\n`;
  fs.appendFileSync(LOG, entry);
  console.log(entry.trim());
};
