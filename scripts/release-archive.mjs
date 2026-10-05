import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";

export function zipRootDirectoryName(releaseRoot) {
  return basename(releaseRoot);
}

export function systemZipArguments(releaseRoot, zipPath) {
  return ["-qr", zipPath, zipRootDirectoryName(releaseRoot)];
}

export function powershellCompressArchiveCommand(releaseRoot, zipPath) {
  const escapedRoot = releaseRoot.replaceAll("'", "''");
  const escapedZip = zipPath.replaceAll("'", "''");
  return `Compress-Archive -Path '${escapedRoot}' -DestinationPath '${escapedZip}' -Force`;
}

export function validateZipEntries(entries, rootDirectory, expectedFiles) {
  const prefix = `${rootDirectory}/`;
  const expected = new Set(expectedFiles);
  const found = new Set();
  const allowedDirectories = new Set(["", "app", "app/web", "app/web/vendor"]);

  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (!normalized.startsWith(prefix)) {
      throw new Error(`ZIP entry is outside the expected root directory '${rootDirectory}': ${entry}`);
    }
    const relativePath = normalized.slice(prefix.length).replace(/\/$/, "");
    if (!relativePath) continue;
    if (relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Invalid path in ZIP archive: ${entry}`);
    }
    if (entry.endsWith("/") || entry.endsWith("\\")) {
      if (!allowedDirectories.has(relativePath)) throw new Error(`Unexpected directory in ZIP archive: ${entry}`);
      continue;
    }
    if (!expected.has(relativePath)) throw new Error(`Unexpected file in ZIP archive: ${entry}`);
    found.add(relativePath);
  }

  const missing = expectedFiles.filter((file) => !found.has(file));
  if (missing.length) throw new Error(`ZIP archive is missing release files: ${missing.join(", ")}`);
}

export async function removeStaleZipArtifacts(zipPath) {
  await Promise.all([
    rm(zipPath, { force: true }),
    rm(`${zipPath}.sha256`, { force: true }),
  ]);
}

export async function writeZipChecksumIfPresent(zipPath) {
  let bytes;
  try {
    bytes = await readFile(zipPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      await rm(`${zipPath}.sha256`, { force: true });
      return null;
    }
    throw error;
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const sidecarPath = `${zipPath}.sha256`;
  await writeFile(sidecarPath, `${checksum}  ${basename(zipPath)}\n`);
  return sidecarPath;
}
