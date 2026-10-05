import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  powershellCompressArchiveCommand,
  removeStaleZipArtifacts,
  systemZipArguments,
  validateZipEntries,
  writeZipChecksumIfPresent,
  zipRootDirectoryName,
} from "../scripts/release-archive.mjs";

const releaseRoot = join(tmpdir(), "pi-vot-0.1.0-win-x64");
const zipPath = join(tmpdir(), "pi-vot-0.1.0-win-x64.zip");
const files = ["app/server.js", "README.md", "SHA256SUMS"];

function available(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function inspect(zipPath) {
  for (const [command, args] of [["unzip", ["-Z1", zipPath]], ["zipinfo", ["-1", zipPath]]]) {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!result.error && result.status === 0) return result.stdout.split(/\r?\n/).filter(Boolean);
  }
  throw new Error("No ZIP archive inspection command is available.");
}

test("both ZIP strategies target one identically named top-level release directory", () => {
  const rootName = zipRootDirectoryName(releaseRoot);
  assert.equal(rootName, "pi-vot-0.1.0-win-x64");
  assert.deepEqual(systemZipArguments(releaseRoot, zipPath), ["-qr", zipPath, rootName]);
  assert.equal(
    powershellCompressArchiveCommand(releaseRoot, zipPath),
    `Compress-Archive -Path '${releaseRoot}' -DestinationPath '${zipPath}' -Force`,
  );
  assert.doesNotMatch(powershellCompressArchiveCommand(releaseRoot, zipPath), /\\\*/);
});

test("ZIP layout validation requires the expected root and allowlisted files", () => {
  validateZipEntries([
    "pi-vot-0.1.0-win-x64/",
    "pi-vot-0.1.0-win-x64/app/",
    "pi-vot-0.1.0-win-x64/app/server.js",
    "pi-vot-0.1.0-win-x64/README.md",
    "pi-vot-0.1.0-win-x64/SHA256SUMS",
  ], "pi-vot-0.1.0-win-x64", files);
  assert.throws(
    () => validateZipEntries(["app/server.js"], "pi-vot-0.1.0-win-x64", files),
    /outside the expected root directory/,
  );
  assert.throws(
    () => validateZipEntries([
      "pi-vot-0.1.0-win-x64/app/server.js",
      "pi-vot-0.1.0-win-x64/README.md",
    ], "pi-vot-0.1.0-win-x64", files),
    /missing release files/,
  );
  assert.throws(
    () => validateZipEntries([
      "pi-vot-0.1.0-win-x64/app/server.js",
      "pi-vot-0.1.0-win-x64/README.md",
      "pi-vot-0.1.0-win-x64/SHA256SUMS",
      "pi-vot-0.1.0-win-x64/app/../../outside",
    ], "pi-vot-0.1.0-win-x64", files),
    /Invalid path in ZIP archive/,
  );
});

test("ZIP checksum sidecar uses a stable digest and the archive filename", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-zip-checksum-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, "pi-vot-0.1.0-win-x64.zip");
  const archiveBytes = Buffer.from("same archive bytes");
  await writeFile(archive, archiveBytes);

  const sidecar = await writeZipChecksumIfPresent(archive);
  assert.equal(sidecar, `${archive}.sha256`);
  const expected = createHash("sha256").update(archiveBytes).digest("hex");
  assert.equal(await readFile(sidecar, "utf8"), `${expected}  pi-vot-0.1.0-win-x64.zip\n`);
  assert.equal(await writeZipChecksumIfPresent(archive), sidecar);
  assert.equal(await readFile(sidecar, "utf8"), `${expected}  pi-vot-0.1.0-win-x64.zip\n`);
});

test("stale ZIP artifacts are removed and missing archives produce no checksum sidecar", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-zip-cleanup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, "pi-vot-0.1.0-win-x64.zip");
  const sidecar = `${archive}.sha256`;
  await writeFile(archive, "stale zip");
  await writeFile(sidecar, "stale checksum");

  await removeStaleZipArtifacts(archive);
  assert.equal(await writeZipChecksumIfPresent(archive), null);
  await assert.rejects(readFile(archive));
  await assert.rejects(readFile(sidecar));
});

const powershellCommand = process.platform === "win32" ? "powershell.exe" : "pwsh";
const zipToolsAvailable = available("zip", ["-v"]) &&
  (available("unzip", ["-v"]) || available("zipinfo", ["-h"]));
const powershellAvailable = available(powershellCommand, ["-NoProfile", "-Command", "exit 0"]);

test("available archivers create the same single-root release layout", {
  skip: !zipToolsAvailable || !powershellAvailable,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-archive-layout-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rootName = "pi-vot-test-win-x64";
  const sourceRoot = join(directory, rootName);
  await mkdir(join(sourceRoot, "app"), { recursive: true });
  await writeFile(join(sourceRoot, "app/server.js"), "server");
  await writeFile(join(sourceRoot, "README.md"), "readme");
  const expectedFiles = ["app/server.js", "README.md"];
  const zipArchive = join(directory, "system-zip.zip");
  const powershellArchive = join(directory, "powershell.zip");

  const zipResult = spawnSync("zip", systemZipArguments(sourceRoot, zipArchive), {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(zipResult.status, 0, zipResult.stderr);
  const powershellScript = `$ErrorActionPreference = 'Stop'; ${powershellCompressArchiveCommand(sourceRoot, powershellArchive)}`;
  const powershellResult = spawnSync(powershellCommand, ["-NoProfile", "-NonInteractive", "-Command", powershellScript], {
    encoding: "utf8",
  });
  assert.equal(powershellResult.status, 0, powershellResult.stderr);

  const zipEntries = inspect(zipArchive);
  const powershellEntries = inspect(powershellArchive);
  validateZipEntries(zipEntries, rootName, expectedFiles);
  validateZipEntries(powershellEntries, rootName, expectedFiles);
  assert.deepEqual(
    zipEntries.filter((entry) => !entry.endsWith("/")).sort(),
    powershellEntries.filter((entry) => !entry.endsWith("/")).sort(),
  );
});
