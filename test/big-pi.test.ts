import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bigPiDirectoryPath,
  bigPiLegacySidecarPath,
  readBigPiSummary,
} from "../src/big-pi.ts";

async function withSession(run: (sessionPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-big-pi-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, "");
    await run(sessionPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("derives dedicated storage and legacy cleanup paths from the transcript path", () => {
  assert.equal(bigPiDirectoryPath("C:\\Users\\south\\session.jsonl"),
    "C:\\Users\\south\\session.jsonl.big-pi");
  assert.equal(bigPiLegacySidecarPath("C:\\Users\\south\\session.jsonl"),
    "C:\\Users\\south\\session.jsonl.big-pi.json");
});

test("an absent storage folder reports exact zero usage and zero chunks", async () => {
  await withSession(async (sessionPath) => {
    assert.deepEqual(await readBigPiSummary(sessionPath), {
      storagePresent: false,
      diskUsageBytes: 0,
      manifestStatus: "absent",
      totalChunks: 0,
      tiers: { t1: 0, t2: 0, t3: 0 },
    });
  });
});

test("disk usage includes manifest, chunks, temporary, and orphan files", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    await mkdir(join(directory, "blocks"), { recursive: true });
    const files = [
      [join(directory, "manifest.json"), '{"format":"unknown"}'],
      [join(directory, "blocks", "B000001.json"), '{"summary":"not read"}'],
      [join(directory, "temporary.tmp"), "temporary"],
      [join(directory, "orphan.json"), "orphan"],
    ] as const;
    for (const [path, contents] of files) await writeFile(path, contents);

    const result = await readBigPiSummary(sessionPath);
    assert.equal(result.storagePresent, true);
    assert.equal(result.diskUsageBytes, files.reduce((bytes, [, contents]) => bytes + Buffer.byteLength(contents), 0));
    assert.equal(result.manifestStatus, "malformed");
    assert.equal(result.totalChunks, null);
    assert.equal(result.tiers, null);
  });
});

function manifest(
  sessionPath: string,
  blocks: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    producer: "big-pi",
    session: { sessionPath },
    blocks,
    ...overrides,
  };
}

function block(blockId: string, tier: number, chunkPath: string, sha256 = "a".repeat(64)) {
  return { blockId, tier, chunkPath, sha256 };
}

test("counts every committed tier entry without reading or requiring its chunk file", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    await mkdir(directory);
    const committed = [
      block("B000001", 1, "blocks/B000001.json"),
      block("B000002", 1, "blocks/B000002~orphan-collision (1).json", "b".repeat(64)),
      block("B000003", 2, "blocks/B000003.json"),
      block("B000004", 3, "blocks/B000004.json"),
    ];
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest(sessionPath, committed)));
    const result = await readBigPiSummary(sessionPath);
    assert.equal(result.manifestStatus, "valid");
    assert.deepEqual(result.tiers, { t1: 2, t2: 1, t3: 1 });
    assert.equal(result.totalChunks, 4);
  });
});

test("counts dormant, superseded, missing, and damaged chunks as committed index entries", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    await mkdir(directory);
    const entries = [
      { ...block("B000001", 1, "blocks/dormant.json"), status: "dormant" },
      { ...block("B000002", 2, "blocks/superseded.json"), supersededBy: "B000003" },
      block("B000003", 3, "blocks/missing.json"),
      block("B000004", 1, "blocks/damaged.json", "c".repeat(64)),
    ];
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest(sessionPath, entries)));

    const result = await readBigPiSummary(sessionPath);
    assert.deepEqual(result.tiers, { t1: 2, t2: 1, t3: 1 });
    assert.equal(result.totalChunks, 4);
  });
});

test("a valid empty committed index has zero counts even when storage has bytes", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    await mkdir(directory);
    const contents = JSON.stringify(manifest(sessionPath, []));
    await writeFile(join(directory, "manifest.json"), contents);
    await writeFile(join(directory, "orphan.json"), "orphan bytes");

    const result = await readBigPiSummary(sessionPath);
    assert.equal(result.manifestStatus, "valid");
    assert.equal(result.diskUsageBytes, Buffer.byteLength(contents) + "orphan bytes".length);
    assert.deepEqual(result.tiers, { t1: 0, t2: 0, t3: 0 });
    assert.equal(result.totalChunks, 0);
  });
});

test("unsupported identity or version is distinct from malformed index data", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    await mkdir(directory);
    const path = join(directory, "manifest.json");
    for (const value of [
      manifest(sessionPath, [], { schemaVersion: 2 }),
      manifest(sessionPath, [], { producer: "other" }),
    ]) {
      await writeFile(path, JSON.stringify(value));
      assert.equal((await readBigPiSummary(sessionPath)).manifestStatus, "unsupported");
    }
    const malformed = [
      manifest(sessionPath, {}),
      manifest(sessionPath, [block("B000001", 1, "blocks/one.json"), block("B000001", 2, "blocks/two.json")]),
      manifest(sessionPath, [block("B000001", 1, "blocks/same.json"), block("B000002", 2, "blocks/same.json")]),
      manifest(sessionPath, [block("B000001-x", 1, "blocks/one.json")]),
      manifest(sessionPath, [block("B000001", 1, "outside.json")]),
      manifest(sessionPath, [block("B000001", 1, "blocks/../outside.json")]),
      manifest(sessionPath, [block("B000001", 1, "blocks/B000001:unsafe.json")]),
      manifest(sessionPath, [block("B000001", 1, "/blocks/one.json")]),
      manifest(sessionPath, [block("B000001", 1, "C:/outside.json")]),
      manifest(sessionPath, [block("B000001", 1, "blocks/one.json", "A".repeat(64))]),
      manifest(sessionPath, [block("B000001", 1, "blocks/one.json", "invalid")]),
      manifest(sessionPath, [], { session: {} }),
      manifest(sessionPath, [], { session: { sessionPath: `${sessionPath}.other` } }),
      manifest(sessionPath, [], { session: undefined }),
      { schemaVersion: 1, producer: "big-pi", session: { sessionPath } },
    ];
    for (const value of malformed) {
      await writeFile(path, JSON.stringify(value));
      const result = await readBigPiSummary(sessionPath);
      assert.equal(result.manifestStatus, "malformed");
      assert.equal(result.diskUsageBytes, Buffer.byteLength(JSON.stringify(value)));
      assert.equal(result.totalChunks, null);
      assert.equal(result.tiers, null);
    }
  });
});

test("storage counts zero-byte and temporary files and excludes symlinks and their targets", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    const target = join(sessionPath, "..", "outside");
    const link = join(directory, "linked-file");
    await mkdir(target);
    await writeFile(join(target, "outside.txt"), "outside bytes");
    await mkdir(directory);
    await writeFile(join(directory, "empty"), "");
    await writeFile(join(directory, "temporary.tmp"), "abc");
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");

    const result = await readBigPiSummary(sessionPath);
    assert.equal(result.diskUsageBytes, 3);
    assert.equal(result.totalChunks, null);
  });
});

test("missing, malformed, and unreadable manifests remain distinct", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    await mkdir(directory);

    assert.equal((await readBigPiSummary(sessionPath)).manifestStatus, "missing");
    await writeFile(join(directory, "manifest.json"), "{");
    assert.equal((await readBigPiSummary(sessionPath)).manifestStatus, "malformed");
    await rm(join(directory, "manifest.json"));
    await mkdir(join(directory, "manifest.json"));
    const unreadable = await readBigPiSummary(sessionPath);
    assert.equal(unreadable.manifestStatus, "unreadable");
    assert.equal(unreadable.totalChunks, null);
    assert.equal(unreadable.tiers, null);
  });
});

test("partial directory scan failures make disk usage unavailable rather than reporting a partial total", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    await mkdir(join(directory, "blocks"), { recursive: true });
    await writeFile(join(directory, "manifest.json"), "{}");
    await writeFile(join(directory, "blocks", "chunk.json"), "bytes");
    const fileSystem = {
      lstat,
      readFile,
      async readdir(path: string, options: { withFileTypes: true }) {
        if (path.endsWith(`${join("blocks")}`)) throw Object.assign(new Error("read denied"), { code: "EACCES" });
        return readdir(path, options);
      },
    };

    const result = await readBigPiSummary(sessionPath, fileSystem as never);
    assert.equal(result.storagePresent, true);
    assert.equal(result.diskUsageBytes, null);
    assert.equal(result.manifestStatus, "malformed");
    assert.equal(result.totalChunks, null);
  });
});

test("a storage-folder symlink is not followed", async () => {
  await withSession(async (sessionPath) => {
    const directory = bigPiDirectoryPath(sessionPath);
    const target = join(sessionPath, "..", "outside");
    await mkdir(target);
    await writeFile(join(target, "file"), "outside");
    await symlink(target, directory, process.platform === "win32" ? "junction" : "dir");

    const result = await readBigPiSummary(sessionPath);
    assert.equal(result.storagePresent, true);
    assert.equal(result.diskUsageBytes, 0);
    assert.equal(result.totalChunks, null);
    assert.equal((await lstat(join(target, "file"))).isFile(), true);
  });
});
