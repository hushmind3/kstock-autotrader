import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const command = process.argv[2];
if (!new Set(["dev", "start"]).has(command)) {
  throw new Error("Usage: node scripts/next-run.mjs <dev|start>");
}
const host = process.env.WEB_HOST ?? "127.0.0.1";
const port = process.env.WEB_PORT ?? "3100";
const child = spawn(process.execPath, [nextBin, command, "--hostname", host, "--port", port], {
  stdio: "inherit",
  env: process.env,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
