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
const { MINIMUM_NODE_VERSION, TESTED_NODE_MAJOR } = await import(pathToFileURL(resolve(coreRoot, "app/runtime-policy.js")));
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
if ($Detected -lt $Minimum) {
    if ($env:PI_VOT_ALLOW_UNSUPPORTED_NODE -ceq '1') {
        [Console]::Error.WriteLine(('WARNING: Pi-vot is running on Node ' + $VersionText + ' below the minimum ' + $Manifest.node.minimum + '.'))
        [Console]::Error.WriteLine('PI_VOT_ALLOW_UNSUPPORTED_NODE=1 is set; continuing anyway.')
    } else {
        [Console]::Error.WriteLine(('Pi-vot requires Node.js >=' + $Manifest.node.minimum + '.' + [Environment]::NewLine + 'Detected: ' + $VersionText))
        exit 1
    }
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

Install this extracted directory as a Pi package:
  pi install "C:\Tools\pi-vot-${packageInfo.version}-win-x64"
  Restart Pi if it was already running, then type /pi-vot at Pi's prompt.
  Do not use "pi install pi-vot" for this ZIP; that names an npm package, not this folder.
  Pi packages cannot add a top-level command named pi pi-vot.

Fallback if PowerShell scripts are restricted:
  node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"

Minimum Node.js: >= 22.19.0. Recommended/tested baseline: Node 22.
Newer Node versions are allowed but may not have received the same level of validation.
Pi installed/configured and Chrome/Chromium are also required.
No npm install or build is needed.
The server opens the default browser when ready. Set PI_VOT_OPEN_BROWSER=0 to disable this.
Default URL: http://127.0.0.1:17361 (only PI_VOT_PORT overrides the port; generic PORT is ignored).

PowerShell port override:
  $env:PI_VOT_PORT = "18000"
  node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"
  Remove-Item Env:PI_VOT_PORT

cmd.exe port override:
  set PI_VOT_PORT=18000
  node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"

Optional Pi executable override:
  PI_VOT_PI_EXECUTABLE pins the installed Pi executable or launcher explicitly.
  It must be an absolute path; project-relative paths are not accepted. On Windows,
  it may point to Pi's absolute .cmd shim.

  PowerShell:
    $env:PI_VOT_PI_EXECUTABLE = "C:\Users\you\AppData\Roaming\npm\pi.cmd"
    node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"
    Remove-Item Env:PI_VOT_PI_EXECUTABLE

  cmd.exe:
    set "PI_VOT_PI_EXECUTABLE=C:\Users\you\AppData\Roaming\npm\pi.cmd"
    node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"

Older Node override (only for versions below 22.19.0; the value must be exactly 1):
  PowerShell:
    $env:PI_VOT_ALLOW_UNSUPPORTED_NODE = "1"
    node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"
    Remove-Item Env:PI_VOT_ALLOW_UNSUPPORTED_NODE

  cmd.exe:
    set PI_VOT_ALLOW_UNSUPPORTED_NODE=1
    node "C:\Tools\pi-vot-${packageInfo.version}-win-x64\app\server.js"

Node 22.19.0 and newer start without this override. Newer-than-tested Node majors print an advisory and continue.

If local policy restricts PowerShell scripts, do not weaken policy for Pi-vot; launch with the approved Node executable. Organizations requiring signed scripts can sign the launcher through their normal deployment process.
`;

const finalFiles = [
  "app/server.js",
  "app/runtime-policy.js",
  "app/pi-service.js",
  "app/runtime-registry.js",
  "app/big-pi.js",
  "app/billion-context-pi.js",
  "app/request.js",
  "app/package.json",
  "app/web/index.html",
  "app/web/main.js",
  "app/web/markdown-security.js",
  "app/web/style.css",
  "app/web/help.md",
  "app/web/vendor/THIRD_PARTY.json",
  "app/web/vendor/highlight-LICENSE",
  "app/web/vendor/highlight.min.js",
  "app/web/vendor/marked-LICENSE.md",
  "app/web/vendor/marked.umd.js",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "package.json",
  "pi-vot-extension.js",
  "browser-launch.js",
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
      recommendedTestedMajor: TESTED_NODE_MAJOR,
    },
    launchMethods: ["PowerShell", "direct-node", "pi-package /pi-vot"],
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
  if (manifest.node.minimum !== MINIMUM_NODE_VERSION || manifest.node.recommendedTestedMajor !== TESTED_NODE_MAJOR) {
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
