import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import registerPiVotExtension from "../pi-vot-extension.js";

test("source tree is a Pi package with the Pi-vot launcher extension", async () => {
  const packageInfo = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(packageInfo.keywords.includes("pi-package"));
  assert.deepEqual(packageInfo.pi.extensions, ["./pi-vot-extension.js"]);
  await access(new URL("../pi-vot-extension.js", import.meta.url));

  let registered;
  registerPiVotExtension({ registerCommand: (name, options) => { registered = { name, options }; } });
  assert.equal(registered.name, "pi-vot");
  assert.match(registered.options.description, /browser app/);
  assert.equal(typeof registered.options.handler, "function");
});

test("release assembly allowlists the installable package and browser launcher", async () => {
  const assembler = await readFile(new URL("../scripts/assemble-release.mjs", import.meta.url), "utf8");
  const windowsPackager = await readFile(new URL("../scripts/package-win.mjs", import.meta.url), "utf8");
  for (const source of [assembler, windowsPackager]) {
    assert.match(source, /pi-vot-extension\.js/);
    assert.match(source, /browser-launch\.js/);
    assert.match(source, /package\.json/);
    assert.match(source, /CHANGELOG\.md/);
  }
});
