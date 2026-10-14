import { lstat, readFile, readdir } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { isAbsolute, join, posix as posixPath, win32 as win32Path } from "node:path";

export interface BigPiSummary {
  storagePresent: boolean;
  diskUsageBytes: number | null;
  manifestStatus: "absent" | "missing" | "unreadable" | "malformed" | "unsupported" | "valid";
  totalChunks: number | null;
  tiers: {
    t1: number | null;
    t2: number | null;
    t3: number | null;
  } | null;
}

interface BigPiFileSystem {
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const nodeFileSystem: BigPiFileSystem = { lstat, readdir, readFile };

export function bigPiDirectoryPath(sessionPath: string): string {
  return `${sessionPath}.big-pi`;
}

export function bigPiLegacySidecarPath(sessionPath: string): string {
  return `${sessionPath}.big-pi.json`;
}

const noChunks = {
  totalChunks: 0,
  tiers: { t1: 0, t2: 0, t3: 0 },
};

const unavailableChunks = { totalChunks: null, tiers: null };
type ChunkCounts = {
  totalChunks: number;
  tiers: { t1: number; t2: number; t3: number };
};

export async function readBigPiSummary(
  sessionPath: string,
  fileSystem: BigPiFileSystem = nodeFileSystem,
): Promise<BigPiSummary> {
  const directory = bigPiDirectoryPath(sessionPath);
  let root: Stats;
  try {
    root = await fileSystem.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        storagePresent: false,
        diskUsageBytes: 0,
        manifestStatus: "absent",
        ...noChunks,
      };
    }
    return {
      storagePresent: true,
      diskUsageBytes: null,
      manifestStatus: "unreadable",
      ...unavailableChunks,
    };
  }

  let diskUsageBytes: number | null = 0;
  if (root.isDirectory()) {
    try {
      diskUsageBytes = await measureDirectory(directory, fileSystem);
    } catch {
      diskUsageBytes = null;
    }
  } else if (root.isSymbolicLink()) {
    diskUsageBytes = 0;
  } else {
    diskUsageBytes = null;
  }

  let manifestStatus: BigPiSummary["manifestStatus"] = root.isDirectory() ? "malformed" : "unreadable";
  let totalChunks: number | null = null;
  let tiers: BigPiSummary["tiers"] = null;
  const manifestPath = join(directory, "manifest.json");
  if (root.isDirectory()) {
    try {
      const manifestInfo = await fileSystem.lstat(manifestPath);
      if (!manifestInfo.isFile()) {
        manifestStatus = "unreadable";
      } else {
        let contents: string;
        try {
          contents = await fileSystem.readFile(manifestPath, "utf8");
        } catch (error) {
          manifestStatus = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
        }
        if (manifestStatus === "malformed") {
          let manifest: unknown;
          try {
            manifest = JSON.parse(contents!);
          } catch {
            manifestStatus = "malformed";
          }
          if (manifestStatus === "malformed" &&
            typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)) {
            const record = manifest as Record<string, unknown>;
            if (typeof record.schemaVersion !== "number" || !Number.isInteger(record.schemaVersion) ||
              typeof record.producer !== "string") {
              manifestStatus = "malformed";
            } else if (record.schemaVersion !== 1 || record.producer !== "big-pi") {
              manifestStatus = "unsupported";
            } else {
              const session = record.session;
              const counts = typeof session === "object" && session !== null && !Array.isArray(session) &&
                (session as Record<string, unknown>).sessionPath === sessionPath
                ? countCommittedBlocks(record.blocks)
                : null;
              if (!counts) {
                manifestStatus = "malformed";
              } else {
                manifestStatus = "valid";
                ({ totalChunks, tiers } = counts);
              }
            }
          } else if (manifestStatus === "malformed" &&
            (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))) {
            manifestStatus = "malformed";
          }
        }
      }
    } catch (error) {
      manifestStatus = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
  }

  return {
    storagePresent: true,
    diskUsageBytes,
    manifestStatus,
    totalChunks,
    tiers,
  };
}

function countCommittedBlocks(blocks: unknown): ChunkCounts | null {
  if (!Array.isArray(blocks)) return null;
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const tiers = { t1: 0, t2: 0, t3: 0 };
  for (const block of blocks) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
    const entry = block as Record<string, unknown>;
    if (typeof entry.blockId !== "string" || !/^B\d+$/.test(entry.blockId) ||
      typeof entry.tier !== "number" || !Number.isInteger(entry.tier) ||
      typeof entry.chunkPath !== "string" || typeof entry.sha256 !== "string") return null;
    if (entry.tier !== 1 && entry.tier !== 2 && entry.tier !== 3) return null;
    if (!isSafeChunkPath(entry.chunkPath) || !/^[a-f\d]{64}$/.test(entry.sha256)) return null;
    if (seenIds.has(entry.blockId) || seenPaths.has(entry.chunkPath)) return null;
    seenIds.add(entry.blockId);
    seenPaths.add(entry.chunkPath);
    if (entry.tier === 1) tiers.t1++;
    else if (entry.tier === 2) tiers.t2++;
    else tiers.t3++;
  }
  return { totalChunks: tiers.t1 + tiers.t2 + tiers.t3, tiers };
}

function isSafeChunkPath(path: string): boolean {
  const match = /^blocks\/([^/]+)\.json$/.exec(path);
  const filename = match?.[1];
  if (!filename || /[<>:"|?*\u0000-\u001f]/.test(filename) ||
    filename.endsWith(".") || filename.endsWith(" ") ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) ||
    path.includes("\\") || isAbsolute(path) ||
    win32Path.isAbsolute(path) || /^[a-z]:/i.test(path)) return false;
  const normalized = posixPath.normalize(path);
  return normalized === path && !path.split("/").some((part) => part === "." || part === "..");
}

async function measureDirectory(
  directory: string,
  fileSystem: BigPiFileSystem,
): Promise<number> {
  let total = 0;
  const entries = await fileSystem.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const info = await fileSystem.lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      total += await measureDirectory(path, fileSystem);
    } else if (info.isFile()) {
      total += info.size;
    }
    if (!Number.isSafeInteger(total)) throw new Error("Big Pi storage size exceeds safe integer range.");
  }
  return total;
}
