import { createHash } from "node:crypto";
import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  powershellCompressArchiveCommand,
  removeStaleZipArtifacts,
  systemZipArguments,
  validateZipEntries,
  writeZipChecksumIfPresent,
  zipRootDirectoryName,
} from "./release-archive.mjs";
import { runPackageValidationChecks } from "./release-validation.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(repositoryRoot, "build/release-core");
const packageInfo = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const releaseRoot = resolve(repositoryRoot, `release/pi-vot-${packageInfo.version}-win-x64`);
const zipPath = `${releaseRoot}.zip`;
const { MINIMUM_NODE_VERSION, MAXIMUM_NODE_VERSION_EXCLUSIVE } = await import(pathToFileURL(resolve(coreRoot, "app/runtime-policy.js")));
const vendorInfo = JSON.parse(await readFile(resolve(coreRoot, "app/web/vendor/THIRD_PARTY.json"), "utf8"));

const psLauncher = String.raw`$ErrorActionPreference = 'Stop'
$ReleaseRoot = $PSScriptRoot
$ManifestPath = Join-Path $ReleaseRoot 'RELEASE-MANIFEST.json'
$ServerPath = Join-Path (Join-Path $ReleaseRoot 'app') 'server.js'

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $ServerPath -PathType Leaf)) {
    [Console]::Error.WriteLine('Pi-vot release files are incomplete.')
    exit 1
}

$Node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $Node) {
    [Console]::Error.WriteLine('Node.js 22.19 or newer is required, but node was not found on PATH.')
    exit 1
}

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$VersionText = (& $Node.Source --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $VersionText -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') {
    [Console]::Error.WriteLine("Could not determine the Node.js version. Detected: $VersionText")
    exit 1
}
$Detected = [version]("$($Matches[1]).$($Matches[2]).$($Matches[3])")
$Minimum = [version]$Manifest.node.minimum
$MaximumExclusive = [version]$Manifest.node.maximumExclusive
if ($Detected.Major -ne $Minimum.Major) {
    [Console]::Error.WriteLine(('Pi-vot currently supports Node ' + $Minimum.Major + '.x only.' + [Environment]::NewLine + 'Detected: ' + $VersionText))
    exit 1
}
if ($Detected -lt $Minimum) {
    [Console]::Error.WriteLine(('Pi-vot requires Node ' + $Minimum.Major + '.' + $Minimum.Minor + ' or newer within the Node ' + $Minimum.Major + ' release line.' + [Environment]::NewLine + 'Detected: ' + $VersionText))
    exit 1
}
if ($Detected -ge $MaximumExclusive) {
    [Console]::Error.WriteLine(('Pi-vot currently supports Node ' + $Minimum.Major + '.x only.' + [Environment]::NewLine + 'Detected: ' + $VersionText))
    exit 1
}

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('Pi was not found on PATH. Install and configure Pi separately; Pi-vot will still start.')
}

& $Node.Source $ServerPath
$ExitCode = $LASTEXITCODE
if ($null -eq $ExitCode) { $ExitCode = 1 }
exit $ExitCode
`;

const startHere = String.raw`Pi-vot ${packageInfo.version} - Windows x64

Preferred:
  PowerShell (from the project directory; run the script by full path if installed elsewhere):
  .\pi-vot.ps1

Fallback if PowerShell scripts are restricted:
  node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"

Requires Node.js 22.19+ in the Node 22 release line, Pi installed/configured, and Chrome/Chromium.
No npm install or build is needed.
Default URL: http://127.0.0.1:17361 (only PI_VOT_PORT overrides the port; generic PORT is ignored).

PowerShell port override:
  $env:PI_VOT_PORT = "18000"
  node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"
  Remove-Item Env:PI_VOT_PORT

cmd.exe port override:
  set PI_VOT_PORT=18000
  node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"

Temporary unsupported Node override (testing only; the value must be exactly 1):
  PowerShell:
    $env:PI_VOT_ALLOW_UNSUPPORTED_NODE = "1"
    node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"
    Remove-Item Env:PI_VOT_ALLOW_UNSUPPORTED_NODE

  cmd.exe:
    set PI_VOT_ALLOW_UNSUPPORTED_NODE=1
    node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"

If local policy restricts PowerShell scripts, do not weaken policy for Pi-vot; launch with the approved Node executable. Organizations requiring signed scripts can sign the launcher through their normal deployment process.
`;

const finalFiles = [
  "app/server.js",
  "app/runtime-policy.js",
  "app/pi-service.js",
  "app/runtime-registry.js",
  "app/request.js",
  "app/package.json",
  "app/web/index.html",
  "app/web/main.js",
  "app/web/markdown-security.js",
  "app/web/style.css",
  "app/web/vendor/THIRD_PARTY.json",
  "app/web/vendor/highlight-LICENSE",
  "app/web/vendor/highlight.min.js",
  "app/web/vendor/marked-LICENSE.md",
  "app/web/vendor/marked.umd.js",
  "README.md",
  "LICENSE",
  "pi-vot.ps1",
  "START-HERE.txt",
  "RELEASE-MANIFEST.json",
  "SHA256SUMS",
];

async function writeManifest() {
  let gitCommit = null;
  try {
    const worktree = execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!worktree.trim()) {
      gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    }
  } catch {}
  const manifest = {
    product: "Pi-vot",
    version: packageInfo.version,
    platform: "win32",
    arch: "x64",
    node: {
      minimum: MINIMUM_NODE_VERSION,
      maximumExclusive: MAXIMUM_NODE_VERSION_EXCLUSIVE,
    },
    launchMethods: ["PowerShell", "direct-node"],
    build: {
      gitCommit,
      timestamp: new Date().toISOString(),
    },
    vendoredRuntimeComponents: vendorInfo.components.map(({ name, version }) => ({ name, version })),
  };
  await writeFile(join(releaseRoot, "RELEASE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function generateChecksums() {
  const names = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (relative(releaseRoot, file).split(sep).join("/") !== "SHA256SUMS") {
        names.push(relative(releaseRoot, file).split(sep).join("/"));
      }
    }
  }
  await walk(releaseRoot);
  names.sort();
  const lines = [];
  for (const name of names) {
    const digest = createHash("sha256").update(await readFile(join(releaseRoot, name))).digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  await writeFile(join(releaseRoot, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

async function validateRelease() {
  const actual = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else actual.push(relative(releaseRoot, file).split(sep).join("/"));
    }
  }
  await walk(releaseRoot);
  actual.sort();
  const expected = [...finalFiles].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const unexpected = actual.filter((file) => !expected.includes(file));
    const missing = expected.filter((file) => !actual.includes(file));
    throw new Error(`Release allowlist validation failed. Unexpected: ${unexpected.join(", ") || "none"}. Missing: ${missing.join(", ") || "none"}.`);
  }
  const manifest = JSON.parse(await readFile(join(releaseRoot, "RELEASE-MANIFEST.json"), "utf8"));
  if (manifest.node.minimum !== MINIMUM_NODE_VERSION || manifest.node.maximumExclusive !== MAXIMUM_NODE_VERSION_EXCLUSIVE) {
    throw new Error("Release Node version policy does not match the application.");
  }
  const checksums = (await readFile(join(releaseRoot, "SHA256SUMS"), "utf8")).trimEnd().split("\n");
  if (checksums.length !== expected.length - 1 || checksums.some((line) => line.endsWith("  SHA256SUMS"))) {
    throw new Error("Release checksum coverage is incomplete or includes SHA256SUMS itself.");
  }
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksum entry: ${line}`);
    const actualDigest = createHash("sha256").update(await readFile(join(releaseRoot, match[2]))).digest("hex");
    if (actualDigest !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
  }
}

async function createZip() {
  const zipExecutable = spawnSync("zip", ["-v"], { stdio: "ignore" });
  if (!zipExecutable.error && zipExecutable.status === 0) {
    const result = spawnSync("zip", systemZipArguments(releaseRoot, zipPath), {
      cwd: dirname(releaseRoot),
      stdio: "inherit",
    });
    if (!result.error && result.status === 0) return true;
  }
  if (process.platform === "win32") {
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      const script = `$ErrorActionPreference = 'Stop'; ${powershellCompressArchiveCommand(releaseRoot, zipPath)}`;
      const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "inherit" });
      if (!result.error && result.status === 0) return true;
    }
  }
  await rm(zipPath, { force: true });
  return false;
}

function inspectZipEntries(archivePath) {
  for (const [executable, args] of [
    ["unzip", ["-Z1", archivePath]],
    ["zipinfo", ["-1", archivePath]],
  ]) {
    const result = spawnSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!result.error && result.status === 0) return result.stdout.split(/\r?\n/).filter(Boolean);
  }
  if (process.platform === "win32") {
    const encodedPath = Buffer.from(archivePath).toString("base64");
    const command = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $a=[IO.Compression.ZipFile]::OpenRead($p); try { $a.Entries | ForEach-Object { $_.FullName } } finally { $a.Dispose() }`;
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (!result.error && result.status === 0) return result.stdout.split(/\r?\n/).filter(Boolean);
    }
  }
  return null;
}

await removeStaleZipArtifacts(zipPath);
await access(join(coreRoot, "app/server.js"));
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
await cp(coreRoot, releaseRoot, { recursive: true });
await writeFile(join(releaseRoot, "pi-vot.ps1"), psLauncher);
await writeFile(join(releaseRoot, "START-HERE.txt"), startHere);
await writeManifest();
await generateChecksums();
await validateRelease();

runPackageValidationChecks({
  runSmoke: () => spawnSync(process.execPath, ["scripts/smoke-release.mjs", releaseRoot], {
    cwd: repositoryRoot,
    stdio: "inherit",
  }),
  runPowerShellLauncher: () => spawnSync(process.execPath, ["scripts/powershell-launcher-check.mjs", releaseRoot], {
    cwd: repositoryRoot,
    stdio: "inherit",
  }),
});

if (await createZip()) {
  const entries = inspectZipEntries(zipPath);
  if (entries) {
    validateZipEntries(entries, zipRootDirectoryName(releaseRoot), finalFiles);
  } else {
    console.warn("ZIP was created but no available tool could inspect its contents.");
  }
  const checksumPath = await writeZipChecksumIfPresent(zipPath);
  if (!checksumPath) throw new Error("ZIP creation reported success but the archive file is missing.");
  console.log(`Windows release ZIP: ${zipPath}`);
  console.log(`ZIP SHA-256 sidecar: ${checksumPath}`);
} else {
  await writeZipChecksumIfPresent(zipPath);
  console.warn(`Release tree validated at ${releaseRoot}; no supported ZIP tool is available on this build host, so no ZIP was created.`);
}

console.log(`Windows release directory validated: ${releaseRoot}`);
