import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const launcherCheck = resolve("scripts/powershell-launcher-check.mjs");

async function withFakePowerShell(run) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-vot-powershell-check-"));
  try {
    const bin = join(temporaryRoot, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "pwsh"), [
      "#!/bin/sh",
      'printf "%s\\n" "$FAKE_PS_STDOUT"',
      'printf "%s\\n" "$FAKE_PS_STDERR" >&2',
      'exit "${FAKE_PS_EXIT_CODE:-1}"',
      "",
    ].join("\n"));
    await chmod(join(bin, "pwsh"), 0o755);
    await run(temporaryRoot, bin);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function runLauncherCheck(releaseRoot, path, extraEnv = {}) {
  return spawnSync(process.execPath, [launcherCheck, releaseRoot], {
    encoding: "utf8",
    env: { ...process.env, PATH: path, ...extraEnv },
    timeout: 5_000,
  });
}

test("early PowerShell policy-block output is captured and exits successfully", {
  skip: process.platform === "win32",
}, async () => {
  await withFakePowerShell((releaseRoot, bin) => {
    const result = runLauncherCheck(releaseRoot, bin, {
      FAKE_PS_STDOUT: "PowerShell startup",
      FAKE_PS_STDERR: "cannot be loaded because running scripts is disabled on this system.",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PowerShell launcher validation: SKIPPED/);
    assert.match(result.stdout, /script execution blocked by local execution policy/);
  });
});

test("arbitrary early PowerShell output remains fatal and is included", {
  skip: process.platform === "win32",
}, async () => {
  await withFakePowerShell((releaseRoot, bin) => {
    const result = runLauncherCheck(releaseRoot, bin, {
      FAKE_PS_STDOUT: "launcher stdout",
      FAKE_PS_STDERR: "unrelated launcher failure",
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /launcher stdout/);
    assert.match(result.stderr, /unrelated launcher failure/);
  });
});

test("missing PowerShell skips the launcher check successfully", {
  skip: process.platform === "win32",
}, async () => {
  await withFakePowerShell(async (releaseRoot) => {
    const emptyPath = join(releaseRoot, "empty-path");
    await mkdir(emptyPath);
    const result = runLauncherCheck(releaseRoot, emptyPath);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PowerShell launcher validation: SKIPPED/);
    assert.match(result.stdout, /PowerShell is unavailable/);
  });
});
