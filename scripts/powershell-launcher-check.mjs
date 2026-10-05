import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  classifyPowerShellAvailability,
  classifyPowerShellLauncherExit,
} from "./powershell-policy.mjs";

const releaseRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/powershell-launcher-check.mjs <release-directory>");

async function findExecutable(names) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

const powershell = await findExecutable(process.platform === "win32"
  ? ["powershell.exe", "pwsh.exe"]
  : ["pwsh", "powershell"]);
const availability = classifyPowerShellAvailability(powershell);

async function unusedLoopbackPort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a port for launcher integration tests.");
  await new Promise((resolveClose) => probe.close(resolveClose));
  return address.port;
}

function stopProcessTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
}

async function runLauncherTests() {
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-vot-powershell-test-"));
const callerDirectory = join(temporaryRoot, "external-project");
const shimDirectory = join(temporaryRoot, "node-shim");
const shimLog = join(temporaryRoot, "node-shim.log");
await mkdir(callerDirectory);
await mkdir(shimDirectory);
let child;
let output = "";

try {
  const port = await unusedLoopbackPort();
  child = spawn(powershell, ["-NoProfile", "-File", join(releaseRoot, "pi-vot.ps1")], {
    cwd: callerDirectory,
    env: { ...process.env, PORT: "1", PI_VOT_PORT: String(port) },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolveClose) => child.once("close", (code) => resolveClose(code)));
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });

  const deadline = Date.now() + 15_000;
  let health;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const exitCode = await closed;
      const result = classifyPowerShellLauncherExit(exitCode, output);
      if (result.status === "skipped") {
        console.log(`PowerShell launcher validation: SKIPPED\n(${result.reason})`);
        return;
      }
      if (result.status === "failed") throw new Error(result.message);
      throw new Error(`PowerShell launcher exited before starting the server (${exitCode}):\n${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(health, `PowerShell launcher did not start the server:\n${output}`);
  assert.equal(resolve(health.projectDirectory), callerDirectory, "launcher must preserve the caller's working directory");
  assert.match(output, new RegExp(`127\\.0\\.0\\.1:${port}`), "PI_VOT_PORT override should reach the application");

  stopProcessTree(child);
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(5_000).then(() => { throw new Error("PowerShell-launched process tree did not stop."); }),
  ]);
  child = undefined;
  output = "";

  const missingNode = spawnSync(powershell, ["-NoProfile", "-File", join(releaseRoot, "pi-vot.ps1")], {
    cwd: callerDirectory,
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(missingNode.status, 0, "launcher must reject a missing Node executable");
  assert.match(`${missingNode.stdout}\n${missingNode.stderr}`, /Node\.js 22\.19 or newer is required.*node was not found/s);

  if (process.platform !== "win32") {
    const nodeShim = join(shimDirectory, "node");
    await writeFile(nodeShim, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then printf "%s\\n" "$FAKE_NODE_VERSION"; exit 0; fi',
      'printf "%s\\n%s\\n%s\\n%s\\n" "$PWD" "$1" "$PI_VOT_PORT" "$PORT" > "$FAKE_NODE_LOG"',
      'exit "${FAKE_NODE_EXIT_CODE:-37}"',
      "",
    ].join("\n"));
    await chmod(nodeShim, 0o755);

    const rejectedVersions = [
      ["v21.7.0", /currently supports Node 22\.x only.*Detected: v21\.7\.0/s],
      ["v22.8.0", /requires Node 22\.19 or newer.*Detected: v22\.8\.0/s],
      ["v23.2.0", /currently supports Node 22\.x only.*Detected: v23\.2\.0/s],
    ];
    for (const [version, message] of rejectedVersions) {
      const result = spawnSync(powershell, ["-NoProfile", "-File", join(releaseRoot, "pi-vot.ps1")], {
        cwd: callerDirectory,
        env: { ...process.env, PATH: shimDirectory, FAKE_NODE_VERSION: version },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.notEqual(result.status, 0, `${version} must be rejected`);
      assert.match(`${result.stdout}\n${result.stderr}`, message);
    }

    const propagated = spawnSync(powershell, ["-NoProfile", "-File", join(releaseRoot, "pi-vot.ps1")], {
      cwd: callerDirectory,
      env: {
        ...process.env,
        PATH: shimDirectory,
        FAKE_NODE_VERSION: process.versions.node,
        FAKE_NODE_LOG: shimLog,
        FAKE_NODE_EXIT_CODE: "37",
        PORT: "17000",
        PI_VOT_PORT: "18123",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(propagated.status, 37, "launcher must propagate the Node process exit code");
    const [workingDirectory, serverArgument, port, genericPort] = (await readFile(shimLog, "utf8")).trimEnd().split("\n");
    assert.equal(workingDirectory, callerDirectory);
    assert.equal(resolve(serverArgument), resolve(releaseRoot, "app/server.js"));
    assert.equal(port, "18123");
    assert.equal(genericPort, "17000");
  }
} finally {
  if (child) stopProcessTree(child);
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("PowerShell launcher validation: PASS (Node acceptance/rejections, external caller cwd, PI_VOT_PORT override, missing-Node diagnostic, and exit propagation).");
}

if (availability.status === "skipped") {
  console.log(`PowerShell launcher validation: SKIPPED\n(${availability.reason})`);
} else {
  await runLauncherTests();
}
