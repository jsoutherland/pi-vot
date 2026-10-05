import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const releaseRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/smoke-release.mjs <release-directory>");

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-vot-release-smoke-"));
const callerDirectory = join(temporaryRoot, "external-project");
const isolatedPath = join(temporaryRoot, "empty-path");
await mkdir(callerDirectory);
await mkdir(isolatedPath);
const portProbe = createServer();
await new Promise((resolveListen, reject) => portProbe.once("error", reject).listen(0, "127.0.0.1", resolveListen));
const address = portProbe.address();
if (!address || typeof address === "string") throw new Error("Could not reserve a local port for the release smoke test.");
const port = address.port;
await new Promise((resolveClose) => portProbe.close(resolveClose));

const child = spawn(process.execPath, [join(releaseRoot, "app/server.js")], {
  cwd: callerDirectory,
  env: { ...process.env, PATH: isolatedPath, PORT: "1", PI_VOT_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Release server exited early (${child.exitCode}):\n${output}`);
    try {
      return await fetch(`http://127.0.0.1:${port}/`);
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Release server did not start:\n${output}`);
}

try {
  const startHere = await readFile(join(releaseRoot, "START-HERE.txt"), "utf8");
  assert.match(startHere, /PI_VOT_PORT/);
  assert.match(startHere, /generic PORT is ignored/);
  assert.match(startHere, /\$env:PI_VOT_ALLOW_UNSUPPORTED_NODE = "1"/);
  assert.match(startHere, /set PI_VOT_ALLOW_UNSUPPORTED_NODE=1/);
  assert.match(startHere, /node "C:\\Tools\\pi-vot-[^"]+-win-x64\\app\\server\.js"/);

  const page = await waitForServer();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  assert.match(await page.text(), /Pi-vot/);
  const mainJs = await fetch(`http://127.0.0.1:${port}/main.js`);
  assert.equal(mainJs.status, 200);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
  const snapshot = await health.json();
  assert.equal(resolve(snapshot.projectDirectory), callerDirectory);
  assert.match(output, new RegExp(`127\\.0\\.0\\.1:${port}`));
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(5_000).then(() => { throw new Error(`Release server failed to shut down gracefully:\n${output}`); }),
    ]);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Assembled-release smoke test passed (direct Node launch, isolated PATH, external cwd, local assets, graceful shutdown).");
