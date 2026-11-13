// src/cli.ts
import { appendFileSync } from "node:fs";

// src/core/paths.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function dataHome(home = homedir()) {
  return process.env.TOKEN_TRACKER_HOME || join(home, ".claude", "token-tracker");
}
function stateFile(name) {
  return join(dataHome(), name);
}
function restrictWindows(dir) {
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
  } catch {
  }
}
function ensureDataHome() {
  const dir = dataHome();
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 448 });
  if (!existed && process.platform === "win32") restrictWindows(dir);
  return dir;
}

// src/cli.ts
var sub = process.argv[2] ?? "";
console.log(sub);
try {
  ensureDataHome();
  appendFileSync(stateFile("debug.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${sub}
`);
} catch {
}
process.exit(0);
