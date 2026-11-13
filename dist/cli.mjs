// src/cli.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var sub = process.argv[2] ?? "";
console.log(sub);
try {
  const home = process.env.TOKEN_TRACKER_HOME || join(homedir(), ".claude", "token-tracker");
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, "debug.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${sub}
`);
} catch {
}
process.exit(0);
