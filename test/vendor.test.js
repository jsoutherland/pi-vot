import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyVendorAssets } from "../scripts/verify-vendor-assets.mjs";

test("vendored runtime assets match their manifest SHA-256 values", async () => {
  await verifyVendorAssets();
});

test("vendor verification fails clearly when a recorded asset changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-vendor-"));
  try {
    const manifest = JSON.parse(await readFile(new URL("../web/vendor/THIRD_PARTY.json", import.meta.url), "utf8"));
    await writeFile(join(directory, "THIRD_PARTY.json"), JSON.stringify(manifest));
    const firstAsset = manifest.components[0].vendoredFile;
    await copyFile(new URL(`../web/vendor/${firstAsset}`, import.meta.url), join(directory, firstAsset));
    await writeFile(join(directory, firstAsset), "changed");
    await assert.rejects(verifyVendorAssets(directory), /integrity check failed for marked\.umd\.js/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
