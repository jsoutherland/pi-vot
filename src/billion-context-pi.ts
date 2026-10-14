import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";

export interface BillionContextPiSummary {
  detected: boolean;
  sidecarPresent: boolean;
  manifestStatus: "absent" | "unreadable" | "malformed" | "unsupported" | "foreign" | "valid";
  totalBlocks: number | null;
  tiers: { t1: number; t2: number; t3: number } | null;
}

interface BillionContextPiFileSystem {
  lstat(path: string): Promise<Stats>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const nodeFileSystem: BillionContextPiFileSystem = { lstat, readFile };

export function billionContextPiSidecarPath(sessionPath: string): string {
  return `${sessionPath}.acp.json`;
}

export async function readBillionContextPiSummary(
  sessionPath: string,
  fileSystem: BillionContextPiFileSystem = nodeFileSystem,
): Promise<BillionContextPiSummary> {
  const sidecarPath = billionContextPiSidecarPath(sessionPath);
  let info: Stats;
  try {
    info = await fileSystem.lstat(sidecarPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { detected: false, sidecarPresent: false, manifestStatus: "absent", totalBlocks: 0,
        tiers: { t1: 0, t2: 0, t3: 0 } };
    }
    return { detected: false, sidecarPresent: false, manifestStatus: "unreadable", totalBlocks: null, tiers: null };
  }

  if (!info.isFile()) {
    return { detected: false, sidecarPresent: true, manifestStatus: "unreadable", totalBlocks: null, tiers: null };
  }

  let contents: string;
  try {
    contents = await fileSystem.readFile(sidecarPath, "utf8");
  } catch {
    return {
      detected: false,
      sidecarPresent: true,
      manifestStatus: "unreadable",
      totalBlocks: null,
      tiers: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { detected: false, sidecarPresent: true, manifestStatus: "malformed", totalBlocks: null, tiers: null };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { detected: false, sidecarPresent: true, manifestStatus: "malformed", totalBlocks: null, tiers: null };
  }
  const sidecar = parsed as Record<string, unknown>;
  if (typeof sidecar.producer !== "string" || !sidecar.producer.startsWith("billion-context-pi@")) {
    return { detected: false, sidecarPresent: true, manifestStatus: "foreign", totalBlocks: null, tiers: null };
  }

  if (sidecar.schemaVersion !== undefined &&
    (typeof sidecar.schemaVersion !== "number" || !Number.isInteger(sidecar.schemaVersion))) {
    return { detected: true, sidecarPresent: true, manifestStatus: "malformed", totalBlocks: null, tiers: null };
  }
  if (sidecar.schemaVersion !== undefined && sidecar.schemaVersion !== 1) {
    return { detected: true, sidecarPresent: true, manifestStatus: "unsupported", totalBlocks: null, tiers: null };
  }
  if (!Array.isArray(sidecar.blocks)) {
    return { detected: true, sidecarPresent: true, manifestStatus: "malformed", totalBlocks: null, tiers: null };
  }

  const tiers = { t1: 0, t2: 0, t3: 0 };
  const seenIds = new Set<string>();
  for (const item of sidecar.blocks) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { detected: true, sidecarPresent: true, manifestStatus: "malformed", totalBlocks: null, tiers: null };
    }
    const block = item as Record<string, unknown>;
    if (typeof block.blockId !== "string" || !/^b\d+$/.test(block.blockId) || seenIds.has(block.blockId) ||
      !Number.isInteger(block.tier) || block.tier !== 1 && block.tier !== 2 && block.tier !== 3) {
      return { detected: true, sidecarPresent: true, manifestStatus: "malformed", totalBlocks: null, tiers: null };
    }
    seenIds.add(block.blockId);
    if (block.tier === 1) tiers.t1++;
    else if (block.tier === 2) tiers.t2++;
    else tiers.t3++;
  }

  return {
    detected: true,
    sidecarPresent: true,
    manifestStatus: "valid",
    totalBlocks: tiers.t1 + tiers.t2 + tiers.t3,
    tiers,
  };
}
