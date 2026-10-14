import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  billionContextPiSidecarPath,
  readBillionContextPiSummary,
} from "../src/billion-context-pi.ts";

async function withSession(run: (sessionPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-vot-billion-context-pi-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, "");
    await run(sessionPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function block(blockId: string, tier: number, active = true) {
  return { blockId, runId: "run-1", tier, summary: "summary", directMessageIds: [], effectiveMessageIds: [],
    directBlockIds: [], compressedTokens: 12, createdAt: 1, survivedCount: 0, generation: "young", active };
}

test("derives the Billion Context Pi sidecar next to the transcript", () => {
  assert.equal(billionContextPiSidecarPath("C:\\Users\\south\\session.jsonl"),
    "C:\\Users\\south\\session.jsonl.acp.json");
});

test("an absent sidecar is not detected and has zero block counts", async () => {
  await withSession(async (sessionPath) => {
    assert.deepEqual(await readBillionContextPiSummary(sessionPath), {
      detected: false,
      sidecarPresent: false,
      manifestStatus: "absent",
      totalBlocks: 0,
      tiers: { t1: 0, t2: 0, t3: 0 },
    });
  });
});

test("detects the producer and counts persisted blocks in each tier", async () => {
  await withSession(async (sessionPath) => {
    await writeFile(billionContextPiSidecarPath(sessionPath), JSON.stringify({
      schemaVersion: 1,
      producer: "billion-context-pi@0.8.0",
      blocks: [block("b1", 1), block("b2", 1, false), block("b3", 2), block("b4", 3)],
    }));
    assert.deepEqual(await readBillionContextPiSummary(sessionPath), {
      detected: true,
      sidecarPresent: true,
      manifestStatus: "valid",
      totalBlocks: 4,
      tiers: { t1: 2, t2: 1, t3: 1 },
    });
  });
});

test("recognizes the documented pre-contract sidecar version and empty block list", async () => {
  await withSession(async (sessionPath) => {
    await writeFile(billionContextPiSidecarPath(sessionPath), JSON.stringify({
      producer: "billion-context-pi@dev",
      blocks: [],
    }));
    const result = await readBillionContextPiSummary(sessionPath);
    assert.equal(result.detected, true);
    assert.equal(result.manifestStatus, "valid");
    assert.equal(result.totalBlocks, 0);
    assert.deepEqual(result.tiers, { t1: 0, t2: 0, t3: 0 });
  });
});

test("does not classify another producer's or malformed sidecar as Billion Context Pi", async () => {
  await withSession(async (sessionPath) => {
    const path = billionContextPiSidecarPath(sessionPath);
    await writeFile(path, JSON.stringify({ producer: "other@1", blocks: [] }));
    assert.equal((await readBillionContextPiSummary(sessionPath)).manifestStatus, "foreign");
    await writeFile(path, "{");
    assert.equal((await readBillionContextPiSummary(sessionPath)).manifestStatus, "malformed");
    assert.equal((await readBillionContextPiSummary(sessionPath)).detected, false);
  });
});

test("keeps detection but reports unsupported schemas or invalid block indexes", async () => {
  await withSession(async (sessionPath) => {
    const path = billionContextPiSidecarPath(sessionPath);
    await writeFile(path, JSON.stringify({ schemaVersion: 2, producer: "billion-context-pi@1", blocks: [] }));
    assert.equal((await readBillionContextPiSummary(sessionPath)).manifestStatus, "unsupported");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, producer: "billion-context-pi@1", blocks: [block("B000001", 1)] }));
    const malformed = await readBillionContextPiSummary(sessionPath);
    assert.equal(malformed.detected, true);
    assert.equal(malformed.manifestStatus, "malformed");
    assert.equal(malformed.totalBlocks, null);
  });
});
