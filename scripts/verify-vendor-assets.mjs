import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const vendorDirectory = fileURLToPath(new URL("../web/vendor/", import.meta.url));

export async function verifyVendorAssets(directory = vendorDirectory) {
  const manifestPath = resolve(directory, "THIRD_PARTY.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    throw new Error("Vendor manifest must contain a non-empty components array.");
  }

  for (const component of manifest.components) {
    if (typeof component.vendoredFile !== "string" ||
      basename(component.vendoredFile) !== component.vendoredFile ||
      !/^[a-f0-9]{64}$/.test(component.sha256 ?? "")) {
      throw new Error(`Invalid vendored filename or SHA-256 entry in ${manifestPath}.`);
    }
    const filePath = resolve(directory, component.vendoredFile);
    const actual = createHash("sha256").update(await readFile(filePath)).digest("hex");
    if (actual !== component.sha256) {
      throw new Error(
        `Vendored asset integrity check failed for ${component.vendoredFile}: expected ${component.sha256}, got ${actual}.`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await verifyVendorAssets();
    console.log("Vendored runtime assets verified.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
