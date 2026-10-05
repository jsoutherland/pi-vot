import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(repositoryRoot, "build/release-core");
const compiledFiles = [
  "server.js",
  "runtime-policy.js",
  "pi-service.js",
  "runtime-registry.js",
  "request.js",
];
const webFiles = [
  "index.html",
  "main.js",
  "markdown-security.js",
  "style.css",
  "vendor/THIRD_PARTY.json",
  "vendor/highlight-LICENSE",
  "vendor/highlight.min.js",
  "vendor/marked-LICENSE.md",
  "vendor/marked.umd.js",
];

async function copyRequired(source, destination) {
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) throw new Error(`Required release input is missing: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, "app/web"), { recursive: true });
for (const file of compiledFiles) {
  await copyRequired(resolve(repositoryRoot, `build/compiled/app/${file}`), resolve(outputRoot, `app/${file}`));
}
for (const file of webFiles) {
  await copyRequired(resolve(repositoryRoot, `web/${file}`), resolve(outputRoot, `app/web/${file}`));
}
await writeFile(resolve(outputRoot, "app/package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
await copyRequired(resolve(repositoryRoot, "README.md"), resolve(outputRoot, "README.md"));
await copyRequired(resolve(repositoryRoot, "LICENSE"), resolve(outputRoot, "LICENSE"));

const releaseFiles = [...compiledFiles.map((file) => `app/${file}`), ...webFiles.map((file) => `app/web/${file}`), "app/package.json", "README.md", "LICENSE"];
const unexpected = [];
async function inspect(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) await inspect(absolute, relative);
    else if (!releaseFiles.includes(relative)) unexpected.push(relative);
  }
}
await inspect(outputRoot);
if (unexpected.length) throw new Error(`Unexpected generic release content: ${unexpected.join(", ")}`);

console.log(`Assembled generic release tree: ${outputRoot}`);
console.log(`Included ${releaseFiles.length} explicitly allowlisted files.`);
