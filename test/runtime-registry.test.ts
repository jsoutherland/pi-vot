import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bigPiDirectoryPath,
  bigPiLegacySidecarPath,
  readBigPiSummary,
  type BigPiSummary,
} from "../src/big-pi.ts";
import { billionContextPiSidecarPath } from "../src/billion-context-pi.ts";
import type { PiDiscoveryContext } from "../src/pi-service.ts";
import {
  PiRuntimeRegistry,
  HISTORY_PAGE_SIZE,
  MAX_ACTIVE_RUNTIMES,
  hydrateStablePiSession,
} from "../src/runtime-registry.ts";
import { deletePiSessionFiles } from "../src/pi-service.ts";
import type {
  PiVotEvent,
  PiVotSnapshot,
  PiSession,
} from "../src/pi-service.ts";
import type { ImageAttachment } from "../src/request.ts";

class FakeRuntime {
  private static nextSessionId = 0;
  private listeners = new Set<(event: PiVotEvent) => void>();
  private state: PiVotSnapshot["state"] = "idle";
  private compacting = false;
  private context: PiVotSnapshot["context"] = { tokens: null, contextWindow: null, percent: null };
  private model: PiVotSnapshot["model"] = null;
  private transcript: PiVotSnapshot["transcript"] = [];
  private readonly historyRevision = "fake-runtime-history";
  private queuedMessages: PiVotSnapshot["queuedMessages"] = [];
  private sessions: PiSession[] = [];
  private readonly cwd: string;
  private readonly knownSessions: Map<string, PiSession[]>;
  private readonly initialSessionId?: string;
  activeSessionId: string | null = null;
  stopped = false;
  failInitialize = false;
  abortCount = 0;
  refreshCount = 0;
  refreshWork?: () => Promise<void>;
  sentMessages: string[] = [];
  newSessionCount = 0;
  renamedSessions: Array<{ id: string; name: string }> = [];
  deletedSessions: string[] = [];
  sentImages: ImageAttachment[][] = [];
  waitBeforeSend?: () => Promise<void>;
  startRunningBeforeNewSessionError = false;

  constructor(cwd: string, knownSessions: Map<string, PiSession[]>, initialSessionId?: string) {
    this.cwd = cwd;
    this.knownSessions = knownSessions;
    this.initialSessionId = initialSessionId;
  }

  async initialize(): Promise<void> {
    if (this.failInitialize) throw new Error("Fake Pi failed to initialize.");
    this.sessions = this.knownSessions.get(this.cwd) ?? [];
    if (this.initialSessionId) {
      this.activeSessionId = `${this.cwd}/fresh-${this.initialSessionId}.jsonl`;
      this.sessions.unshift({
        id: this.activeSessionId,
        cwd: this.cwd,
        name: null,
        preview: "New session",
        updatedAt: new Date().toISOString(),
      });
    } else {
      this.activeSessionId = this.sessions[0]?.id ?? `${this.cwd}/generated.jsonl`;
    }
    this.model = { provider: "fake", id: "fake-model", name: "fake-model", contextWindow: 10_000 };
    this.context = { tokens: 100, contextWindow: 10_000, percent: 1 };
    this.transcript = [];
  }

  subscribe(listener: (event: PiVotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PiVotSnapshot {
    return {
      state: this.state,
      isCompacting: this.compacting,
      context: { ...this.context },
      model: this.model ? { ...this.model } : null,
      queuedMessages: this.queuedMessages.map((item) => ({ ...item })),
      projectDirectory: this.cwd,
      activeSessionId: this.activeSessionId,
      activeSessionName: this.sessions.find(({ id }) => id === this.activeSessionId)?.name ?? null,
      sessions: this.sessions.map((item) => ({ ...item })),
      transcript: this.transcript.map((item) => ({ ...item })),
      historyRevision: this.historyRevision,
    };
  }

  setTranscript(items: PiVotSnapshot["transcript"]): void {
    this.transcript = items.map((item) => ({ ...item }));
  }

  get canChangeModel(): boolean {
    return this.state === "idle" && !this.compacting && this.queuedMessages.length === 0;
  }

  async refreshPersistedState(): Promise<void> {
    this.refreshCount++;
    await this.refreshWork?.();
  }

  async getAvailableModels() {
    return [
      { provider: "fake", id: "fake-model", name: "fake-model", contextWindow: 10_000 },
      { provider: "fake", id: "changed-model", name: "changed-model", contextWindow: 20_000 },
    ];
  }

  async getPromptTemplates() {
    return [{ name: "review", description: "Review changes" }];
  }

  async changeModel(provider: string, modelId: string): Promise<void> {
    if (this.state !== "idle" || this.compacting || this.queuedMessages.length > 0) {
      throw new Error("Model can be changed when the session is idle.");
    }
    this.model = { provider, id: modelId, name: modelId, contextWindow: 20_000 };
    this.context = { tokens: 100, contextWindow: 20_000, percent: 0.5 };
    this.emit({ type: "model_update", model: this.model });
    this.emit({ type: "context_update", context: this.context });
  }

  async switchSession(sessionId: string): Promise<void> {
    this.activeSessionId = sessionId;
    this.emit({ type: "session_snapshot", snapshot: this.snapshot() });
  }

  async sendMessage(
    message: string,
    messageId = "fake-message",
    images: ImageAttachment[] = [],
  ): Promise<"started" | "steered" | "queued"> {
    await this.waitBeforeSend?.();
    if (message === "fail new session") throw new Error("Fake Pi rejected the prompt.");
    this.sentMessages.push(message);
    this.sentImages.push(images);
    if (this.compacting) {
      this.emit({ type: "queued_message", id: messageId, message });
      return "queued";
    }
    const prior = this.state;
    this.state = prior === "running" ? "running" : "running";
    this.transcript.push({ id: messageId, type: "user", text: message });
    this.emit({ type: "state", state: "running" });
    return prior === "running" ? "steered" : "started";
  }

  async abort(): Promise<void> {
    this.abortCount++;
    this.state = "idle";
    this.emit({ type: "state", state: "idle" });
  }

  async compact(): Promise<void> {
    this.compacting = true;
    this.emit({ type: "compaction_start", reason: "manual" });
  }

  async newSession(): Promise<void> {
    this.newSessionCount++;
    if (this.startRunningBeforeNewSessionError) {
      this.startRunningBeforeNewSessionError = false;
      this.state = "running";
      this.emit({ type: "state", state: "running" });
      throw new Error("Finish or stop the active Pi operation before switching sessions or projects.");
    }
    this.activeSessionId = `${this.cwd}/new-session-${++FakeRuntime.nextSessionId}.jsonl`;
    this.sessions.unshift({
      id: this.activeSessionId,
      cwd: this.cwd,
      name: null,
      preview: "New session",
      updatedAt: new Date().toISOString(),
    });
    this.emit({ type: "session_snapshot", snapshot: this.snapshot() });
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    this.renamedSessions.push({ id: sessionId, name });
    const session = this.sessions.find(({ id }) => id === sessionId);
    if (session) session.name = name;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.push(sessionId);
    await this.stop();
    await deletePiSessionFiles(sessionId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  emit(event: PiVotEvent): void {
    if (event.type === "state") this.state = event.state;
    else if (event.type === "context_update") this.context = { ...event.context };
    else if (event.type === "compaction_start") this.compacting = true;
    else if (event.type === "compaction_end") this.compacting = false;
    else if (event.type === "queued_message") this.queuedMessages.push({ id: event.id, message: event.message });
    for (const listener of this.listeners) listener(event);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the runtime refresh.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function createFixture(
  sessionCount = 5,
  historyCacheByteLimit?: number,
  historyLoader?: typeof hydrateStablePiSession,
  bigPiReader?: typeof readBigPiSummary,
): Promise<{
  root: string;
  cwd: string;
  sessions: PiSession[];
  registry: PiRuntimeRegistry;
  services: FakeRuntime[];
  sessionsDirectory: string;
  configuredSessions: Map<string, PiSession[]>;
  discoveryContext: PiDiscoveryContext;
  failNextInitialization: () => void;
  setSendWaiter: (waiter: (() => Promise<void>) | undefined) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-vot-registry-"));
  const cwd = join(root, "project");
  const sessionsDirectory = join(root, "pi-sessions");
  const agentDirectory = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionsDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  const sessions: PiSession[] = [];
  for (let index = 0; index < sessionCount; index++) {
    const id = join(sessionsDirectory, `session-${index}.jsonl`);
    await writeFile(id, `${JSON.stringify({ type: "session", id: `id-${index}`, cwd })}\n`);
    sessions.push({
      id,
      cwd,
      name: `Session ${index}`,
      preview: `Session ${index}`,
      updatedAt: new Date(Date.now() - index * 1_000).toISOString(),
    });
  }
  const discoveryContext: PiDiscoveryContext = {
    env: {
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_CODING_AGENT_SESSION_DIR: sessionsDirectory,
    },
    home: join(root, "home"),
  };
  const configuredSessions = new Map([[cwd, sessions]]);
  const services: FakeRuntime[] = [];
  let failNextInitialization = false;
  let sendWaiter: (() => Promise<void>) | undefined;
  const registry = new PiRuntimeRegistry(cwd, (directory, initialSessionId) => {
    const service = new FakeRuntime(directory, configuredSessions, initialSessionId);
    service.failInitialize = failNextInitialization;
    service.waitBeforeSend = () => sendWaiter?.() ?? Promise.resolve();
    failNextInitialization = false;
    services.push(service);
    return service as never;
  }, discoveryContext, historyCacheByteLimit, historyLoader, bigPiReader);
  return {
    root,
    cwd,
    sessions,
    registry,
    services,
    sessionsDirectory,
    configuredSessions,
    discoveryContext,
    failNextInitialization: () => { failNextInitialization = true; },
    setSendWaiter: (waiter) => { sendWaiter = waiter; },
  };
}

async function addProjectSessions(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  cwd: string,
  count = 1,
): Promise<PiSession[]> {
  await mkdir(cwd, { recursive: true });
  const sessions: PiSession[] = [];
  for (let index = 0; index < count; index++) {
    const id = join(fixture.sessionsDirectory, `other-${index}.jsonl`);
    await writeFile(id, [
      JSON.stringify({ type: "session", id: `other-${index}`, cwd }),
      JSON.stringify({
        type: "message",
        id: `other-${index}-user`,
        message: { role: "user", content: `History from ${cwd}` },
      }),
      JSON.stringify({
        type: "message",
        id: `other-${index}-assistant`,
        message: { role: "assistant", content: [{ type: "text", text: "Stored project answer." }] },
      }),
    ].join("\n") + "\n");
    sessions.push({
      id,
      cwd,
      name: `Other project session ${index}`,
      preview: `Other project session ${index}`,
      updatedAt: new Date().toISOString(),
    });
  }
  fixture.configuredSessions.set(cwd, sessions);
  return sessions;
}

function waitForSnapshot(
  registry: PiRuntimeRegistry,
  predicate: (snapshot: PiVotSnapshot) => boolean,
): Promise<PiVotSnapshot> {
  const current = registry.snapshot();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = registry.subscribe((event) => {
      if (event.type !== "session_snapshot" || !predicate(event.snapshot)) return;
      unsubscribe();
      resolve(event.snapshot);
    });
  });
}

test("inactive history pages are chronological, stable, bounded, and do not activate Pi", async () => {
  const fixture = await createFixture(2);
  const records: unknown[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < 250; index++) {
    const id = `history-${index}`;
    records.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      message: {
        role: "user",
        content: index === 149 || index === 249 ? "x".repeat(1_200_000) : `Message ${index}`,
      },
    });
    parentId = id;
  }
  await writeFile(fixture.sessions[0]!.id, [
    JSON.stringify({ type: "session", id: "large-history", cwd: fixture.cwd }),
    ...records.map((record) => JSON.stringify(record)),
    "",
  ].join("\n"));
  await writeFile(`${fixture.sessions[0]!.id}.pi-vot.jsonl`, `${JSON.stringify({
    type: "compaction",
    id: "history-compaction",
    createdAt: "2026-10-02T00:00:00.000Z",
    afterId: "history-149",
    afterIndex: 149,
  })}\n`);
  try {
    await fixture.registry.initialize();
    const initial = fixture.registry.snapshot();
    assert.equal(initial.transcript.length, 1);
    assert.equal(initial.transcript[0]?.id, "history-249");
    assert.ok(Buffer.byteLength(JSON.stringify(initial.transcript)) > 1_048_576);
    assert.equal(initial.transcriptHasOlder, true);
    assert.equal(fixture.services.length, 0);

    const allIds = initial.transcript.map((item) => item.id);
    const sessionId = fixture.sessions[0]!.id;
    let cursor = initial.transcriptBeforeId;
    while (cursor) {
      const page = await fixture.registry.getOlderTranscriptPage(sessionId, cursor, initial.historyRevision!);
      assert.ok(page.items.length > 0);
      assert.ok(page.items.length <= HISTORY_PAGE_SIZE);
      if (page.items.some((item) => item.id === "history-149")) assert.equal(page.items.length, 1);
      allIds.unshift(...page.items.map((item) => item.id));
      cursor = page.beforeId;
      assert.equal(page.hasOlder, Boolean(cursor));
    }

    assert.equal(allIds.length, 251);
    assert.equal(new Set(allIds).size, allIds.length);
    assert.equal(allIds[0], "history-0");
    assert.equal(allIds.at(-1), "history-249");
    assert.ok(allIds.indexOf("history-compaction") > allIds.indexOf("history-149"));
    assert.deepEqual(
      allIds.filter((id) => id.startsWith("history-") && id !== "history-compaction"),
      Array.from({ length: 250 }, (_, index) => `history-${index}`),
    );
    assert.equal(fixture.services.length, 0);
    await assert.rejects(
      fixture.registry.getOlderTranscriptPage(sessionId, "missing-cursor", initial.historyRevision!),
      /cursor is no longer valid/,
    );
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("New Session uses the folder of the selected inactive session", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const projectB = join(fixture.root, "project-b");
    const [sessionB] = await addProjectSessions(fixture, projectB);
    await fixture.registry.refreshPersistedState();
    await fixture.registry.switchSession(sessionB!.id);

    await fixture.registry.newSession();

    const snapshot = fixture.registry.snapshot();
    assert.equal(snapshot.sessions.find(({ id }) => id === snapshot.selectedSessionId)?.cwd, projectB);
    const projectRuntime = fixture.services.find((service) => service.snapshot().projectDirectory === projectB);
    assert.ok(projectRuntime);
    assert.equal(projectRuntime.newSessionCount, 0);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cache eviction preserves the authoritative revision and accepts the saved cursor", async () => {
  const fixture = await createFixture(9);
  const transcript = Array.from({ length: 105 }, (_, index) => ({
    type: "message",
    id: `evicted-${index}`,
    parentId: index ? `evicted-${index - 1}` : null,
    message: { role: "user", content: `Evicted message ${index}` },
  }));
  for (const session of fixture.sessions) {
    await writeFile(session.id, [
      JSON.stringify({ type: "session", id: session.id, cwd: fixture.cwd }),
      ...transcript.map((record) => JSON.stringify(record)),
      "",
    ].join("\n"));
  }
  try {
    await fixture.registry.initialize();
    let original = fixture.registry.snapshot();
    const session = fixture.sessions.find(({ id }) => id === original.selectedSessionId)!;
    assert.equal(original.historyRevision, (await fixture.registry.getOlderTranscriptPage(
      session.id,
      original.transcriptBeforeId!,
      original.historyRevision!,
    )).historyRevision);

    for (const other of fixture.sessions.filter(({ id }) => id !== session.id)) {
      await fixture.registry.switchSession(other.id);
      const snapshot = await waitForSnapshot(fixture.registry, (value) =>
        value.selectedSessionId === other.id && value.transcript.at(-1)?.id === "evicted-104");
      await fixture.registry.getOlderTranscriptPage(other.id, snapshot.transcriptBeforeId!, snapshot.historyRevision!);
    }

    await fixture.registry.switchSession(session.id);
    original = fixture.registry.snapshot();
    const page = await fixture.registry.getOlderTranscriptPage(
      session.id,
      original.transcriptBeforeId!,
      original.historyRevision!,
    );
    assert.equal(page.historyRevision, original.historyRevision);
    assert.equal(page.items.at(-1)?.id, "evicted-4");
    assert.equal(fixture.registry.snapshot().historyRevision, page.historyRevision);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("oversized histories page repeatedly without being cacheable and keep one revision", async () => {
  const fixture = await createFixture(1, 1_048_576);
  const transcript = Array.from({ length: 350 }, (_, index) => ({
    type: "message",
    id: `oversized-${index}`,
    parentId: index ? `oversized-${index - 1}` : null,
    message: { role: "user", content: `${index}: ${"x".repeat(4_000)}` },
  }));
  await writeFile(fixture.sessions[0]!.id, [
    JSON.stringify({ type: "session", id: "oversized", cwd: fixture.cwd }),
    ...transcript.map((record) => JSON.stringify(record)),
    "",
  ].join("\n"));
  try {
    await fixture.registry.initialize();
    const sessionId = fixture.sessions[0]!.id;
    const initial = fixture.registry.snapshot();
    let cursor = initial.transcriptBeforeId!;
    let loaded = 0;
    for (let pageIndex = 0; pageIndex < 4 && cursor; pageIndex++) {
      const page = await fixture.registry.getOlderTranscriptPage(sessionId, cursor, initial.historyRevision!);
      assert.equal(page.historyRevision, initial.historyRevision);
      assert.ok(page.items.length > 0);
      loaded += page.items.length;
      cursor = page.beforeId ?? "";
    }
    assert.equal(loaded + initial.transcript.length, 350);
    assert.equal(cursor, "");
    assert.equal(fixture.registry.snapshot().historyRevision, initial.historyRevision);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("history pages preserve the last valid snapshot on read failure and recover without changing its revision", async () => {
  const fixture = await createFixture(1);
  const records = Array.from({ length: 105 }, (_, index) => JSON.stringify({
    type: "message",
    id: `stable-${index}`,
    parentId: index ? `stable-${index - 1}` : null,
    message: { role: "user", content: `Stable message ${index}` },
  }));
  const session = fixture.sessions[0]!;
  const content = `${JSON.stringify({ type: "session", id: "stable", cwd: fixture.cwd })}\n${records.join("\n")}\n`;
  await writeFile(session.id, content);
  try {
    await fixture.registry.initialize();
    const previous = fixture.registry.snapshot();
    await rm(session.id);
    await assert.rejects(
      fixture.registry.getOlderTranscriptPage(session.id, previous.transcriptBeforeId!, previous.historyRevision!),
      /last available conversation is unchanged/,
    );
    const failed = fixture.registry.snapshot();
    assert.deepEqual(failed.transcript, previous.transcript);
    assert.equal(failed.historyRevision, previous.historyRevision);
    assert.equal(failed.status?.kind, "error");

    await writeFile(session.id, content);
    const page = await fixture.registry.getOlderTranscriptPage(
      session.id,
      previous.transcriptBeforeId!,
      previous.historyRevision!,
    );
    assert.equal(page.historyRevision, previous.historyRevision);
    assert.equal(page.items.at(-1)?.id, "stable-4");
    assert.equal(fixture.registry.snapshot().status, null);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("continued transcript mutation exhausts retries without erasing valid displayed history", async () => {
  let simulateMutation = false;
  let fingerprintCalls = 0;
  const fixture = await createFixture(1, undefined, (session) =>
    hydrateStablePiSession(
      session,
      undefined,
      async (sessionId) => simulateMutation
        ? `changing-${fingerprintCalls++}`
        : `${sessionId}-${(await stat(sessionId)).size}`,
    ));
  const session = fixture.sessions[0]!;
  const records = Array.from({ length: 105 }, (_, index) => JSON.stringify({
    type: "message",
    id: `stable-${index}`,
    parentId: index ? `stable-${index - 1}` : null,
    message: { role: "user", content: `Stable message ${index}` },
  }));
  const original = `${JSON.stringify({ type: "session", id: "stable", cwd: fixture.cwd })}\n${records.join("\n")}\n`;
  await writeFile(session.id, original);
  try {
    await fixture.registry.initialize();
    const previous = fixture.registry.snapshot();
    await writeFile(session.id, `${original}{"type":"message","id":"external-change"}\n`);
    simulateMutation = true;

    await assert.rejects(
      fixture.registry.getOlderTranscriptPage(
        session.id,
        previous.transcriptBeforeId!,
        previous.historyRevision!,
      ),
      /last available conversation is unchanged/,
    );
    assert.equal(fingerprintCalls, 6);
    assert.deepEqual(fixture.registry.snapshot().transcript, previous.transcript);
    assert.equal(fixture.registry.snapshot().historyRevision, previous.historyRevision);
    assert.equal(fixture.registry.snapshot().status?.kind, "error");

    simulateMutation = false;
    await writeFile(session.id, original);
    const page = await fixture.registry.getOlderTranscriptPage(
      session.id,
      previous.transcriptBeforeId!,
      previous.historyRevision!,
    );
    assert.equal(page.historyRevision, previous.historyRevision);
    assert.equal(page.items.at(-1)?.id, "stable-4");
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("stable hydration retries from a fresh fingerprint and bounds repeated transcript changes", async () => {
  const session = {
    id: "/fake/session.jsonl",
    cwd: "/fake",
    name: "Session",
    preview: "Session",
    updatedAt: new Date().toISOString(),
  };
  const hydrated = { session, transcript: [], model: null };
  let fingerprintCalls = 0;
  let readCalls = 0;
  const fingerprints = ["before-1", "after-1", "before-2", "before-2"];
  const stable = await hydrateStablePiSession(
    session,
    async () => { readCalls++; return hydrated; },
    async () => fingerprints[fingerprintCalls++]!,
  );
  assert.equal(readCalls, 2);
  assert.equal(stable.fingerprint, "before-2");

  fingerprintCalls = 0;
  readCalls = 0;
  await assert.rejects(
    hydrateStablePiSession(
      session,
      async () => { readCalls++; return hydrated; },
      async () => `changing-${fingerprintCalls++}`,
    ),
    /kept changing/,
  );
  assert.equal(readCalls, 3);
  assert.equal(fingerprintCalls, 6);
});

test("external branch replacement invalidates cached cursors and same-ID edits refresh the latest page", async () => {
  const fixture = await createFixture();
  const session = fixture.sessions[0]!;
  const createRecords = (prefix: string, revised = false): unknown[] => {
    const records: unknown[] = [{ type: "session", id: "stable-session", cwd: fixture.cwd }];
    let parentId: string | null = null;
    for (let index = 0; index < 250; index++) {
      const id = `${prefix}-${index}`;
      records.push({
        type: "message",
        id,
        parentId,
        message: { role: "user", content: revised && index === 249 ? "Updated existing message ID" : `${prefix} message ${index}` },
      });
      parentId = id;
    }
    return records;
  };
  const writeRecords = (records: unknown[]) => writeFile(session.id, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await writeRecords(createRecords("branch-a"));
  try {
    await fixture.registry.initialize();
    const initial = fixture.registry.snapshot();
    assert.equal(initial.transcript.at(-1)?.id, "branch-a-249");
    const cursor = initial.transcriptBeforeId!;

    await writeRecords(createRecords("branch-b"));
    await assert.rejects(
      fixture.registry.getOlderTranscriptPage(session.id, cursor, initial.historyRevision!),
      (error: Error & { historyRevision?: string }) =>
        /history changed/.test(error.message) && error.historyRevision !== initial.historyRevision,
    );
    const branchB = fixture.registry.snapshot();
    assert.notEqual(branchB.historyRevision, initial.historyRevision);
    assert.equal(branchB.transcript.at(-1)?.id, "branch-b-249");
    const page = await fixture.registry.getOlderTranscriptPage(
      session.id,
      branchB.transcriptBeforeId!,
      branchB.historyRevision!,
    );
    assert.equal(page.items.at(-1)?.id, "branch-b-149");
    assert.equal(page.historyRevision, branchB.historyRevision);

    await writeRecords(createRecords("branch-b", true));
    await assert.rejects(
      fixture.registry.getOlderTranscriptPage(session.id, page.beforeId!, branchB.historyRevision!),
      (error: Error & { historyRevision?: string }) => error.historyRevision !== branchB.historyRevision,
    );
    const revised = fixture.registry.snapshot();
    assert.notEqual(revised.historyRevision, branchB.historyRevision);
    const latest = revised.transcript.at(-1);
    assert.equal(latest?.type, "user");
    if (latest?.type === "user") assert.equal(latest.text, "Updated existing message ID");
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("inactive history pages remain consistent after runtime activation and release", async () => {
  const fixture = await createFixture();
  const session = fixture.sessions[0]!;
  const transcript = Array.from({ length: 250 }, (_, index) => ({
    id: `runtime-history-${index}`,
    type: "user" as const,
    text: `Runtime history ${index}`,
  }));
  await writeFile(session.id, [
    JSON.stringify({ type: "session", id: "runtime-history", cwd: fixture.cwd }),
    ...transcript.map((item, index) => JSON.stringify({
      type: "message",
      id: item.id,
      parentId: index ? transcript[index - 1]!.id : null,
      message: { role: "user", content: item.text },
    })),
    "",
  ].join("\n"));
  try {
    await fixture.registry.initialize();
    const inactive = fixture.registry.snapshot();
    await fixture.registry.wakeSession(session.id);
    fixture.services[0]!.setTranscript(transcript);
    const active = fixture.registry.snapshot();
    const runtimePage = await fixture.registry.getOlderTranscriptPage(
      session.id,
      active.transcriptBeforeId!,
      active.historyRevision!,
    );
    assert.equal(runtimePage.items.at(-1)?.id, "runtime-history-149");
    await fixture.registry.releaseRuntime(session.id);
    const released = fixture.registry.snapshot();
    assert.equal(released.historyRevision, active.historyRevision);
    const releasedPage = await fixture.registry.getOlderTranscriptPage(
      session.id,
      released.transcriptBeforeId!,
      released.historyRevision!,
    );
    assert.equal(releasedPage.items.at(-1)?.id, "runtime-history-149");
    assert.notEqual(inactive.historyRevision, released.historyRevision);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("selection is read-only; Send, release, and the four-runtime cap are enforced", async () => {
  const fixture = await createFixture();
  try {
    fixture.discoveryContext.env.PI_CODING_AGENT_DIR = join(fixture.root, "changed-after-construction");
    await fixture.registry.initialize();
    assert.equal(fixture.services.length, 0);
    assert.equal(fixture.registry.snapshot().sessions.filter((session) => session.active).length, 0);
    assert.ok(fixture.registry.snapshot().sessions.every((session) => session.cwd === fixture.cwd));

    const selectedInitially = fixture.registry.snapshot().activeSessionId!;
    const browsed = fixture.sessions.filter(({ id }) => id !== selectedInitially).slice(0, MAX_ACTIVE_RUNTIMES);
    for (const session of browsed) {
      await fixture.registry.switchSession(session.id);
      assert.equal(fixture.registry.snapshot().selectedSessionId, session.id);
      assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === session.id)?.hasRuntime, false);
    }
    assert.equal(fixture.services.length, 0);
    for (const session of fixture.sessions.slice(0, MAX_ACTIVE_RUNTIMES)) {
      await fixture.registry.sendMessage(`activate ${session.id}`, undefined, session.id);
    }
    assert.equal(fixture.services.length, MAX_ACTIVE_RUNTIMES);
    assert.equal(fixture.registry.snapshot().sessions.filter((session) => session.active).length, MAX_ACTIVE_RUNTIMES);
    const fifth = fixture.sessions.find(({ id }) =>
      !fixture.services.some((service) => service.activeSessionId === id),
    )!;
    await fixture.registry.switchSession(fifth.id);
    assert.equal(fixture.registry.snapshot().selectedSessionId, fifth.id);
    await assert.rejects(fixture.registry.sendMessage("capacity", undefined, fifth.id), /Four Pi sessions are already active/);
    assert.equal(fixture.services.length, MAX_ACTIVE_RUNTIMES);
    assert.equal(fixture.services.some((service) => service.stopped), false);

    const emptyProject = join(fixture.root, "empty-project");
    await mkdir(emptyProject, { recursive: true });
    await fixture.registry.changeProjectDirectory(emptyProject);
    assert.equal(fixture.registry.snapshot().selectedSessionId, null);
    await assert.rejects(
      fixture.registry.sendNewSessionMessage("capacity pending", undefined, undefined, [], "send", emptyProject),
      /Four Pi sessions are already active/,
    );
    assert.equal(fixture.services.length, MAX_ACTIVE_RUNTIMES);

    for (const service of fixture.services) await service.abort();
    await fixture.registry.releaseRuntime(fixture.services[0]!.activeSessionId!);
    assert.equal(fixture.services[0]!.stopped, true);
    await fixture.registry.sendMessage("activate fifth", undefined, fifth.id);
    assert.equal(fixture.services.length, MAX_ACTIVE_RUNTIMES + 1);
    assert.equal(fixture.registry.snapshot().sessions.filter((session) => session.active).length, MAX_ACTIVE_RUNTIMES);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("choosing a project clears selection and defers one new session until Send", async () => {
  const fixture = await createFixture();
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.sessions[0]!.id;
    await fixture.registry.sendMessage("existing A", "existing-a", sessionA);
    const runtimeA = fixture.services[0]!;
    const projectB = join(fixture.root, "project-b");
    await addProjectSessions(fixture, projectB);

    await fixture.registry.changeProjectDirectory(projectB);
    assert.equal(fixture.registry.snapshot().selectedSessionId, null);
    assert.equal(fixture.registry.snapshot().transcript.length, 0);
    assert.equal(fixture.services.length, 1);
    assert.equal(fixture.registry.snapshot().sessions.some(({ cwd }) => cwd === fixture.cwd), true);

    const image: ImageAttachment = {
      mimeType: "image/png",
      name: "pending.png",
      data: "aW1hZ2U=",
      size: 5,
    };
    const first = await fixture.registry.sendNewSessionMessage(
      "first in B",
      "first-b",
      undefined,
      [image],
      "send",
      projectB,
    );
    const runtimeB = fixture.services[1]!;
    assert.equal(first.sessionId, runtimeB.activeSessionId);
    assert.equal(runtimeB.newSessionCount, 0);
    assert.deepEqual(runtimeB.sentMessages, ["first in B"]);
    assert.deepEqual(runtimeB.sentImages, [[image]]);
    assert.deepEqual(runtimeA.sentMessages, ["existing A"]);

    await fixture.registry.sendMessage("next in B", "next-b", first.sessionId);
    assert.deepEqual(runtimeB.sentMessages, ["first in B", "next in B"]);
    assert.equal(fixture.registry.snapshot().selectedSessionId, first.sessionId);

    await fixture.registry.changeProjectDirectory(projectB);
    assert.equal(fixture.registry.snapshot().selectedSessionId, null);
    assert.equal(fixture.services.length, 2);

    const failed = await fixture.registry.sendNewSessionMessage(
      "fail new session",
      "failed-b",
      undefined,
      [],
      "send",
      projectB,
    ).then(
      () => null,
      (error: Error & { sessionId?: string }) => error,
    );
    assert.ok(failed);
    assert.equal(typeof failed.sessionId, "string");
    const failedSessionId = failed.sessionId!;
    const startsBeforeRetry = fixture.services.length;
    const retry = await fixture.registry.sendNewSessionMessage(
      "retry in B",
      "retry-b",
      failedSessionId,
      [],
      "send",
      projectB,
    );
    assert.equal(retry.sessionId, failedSessionId);
    assert.equal(fixture.services.length, startsBeforeRetry);
    assert.deepEqual(fixture.services.at(-1)!.sentMessages, ["retry in B"]);

    const selectedBeforeInvalid = fixture.registry.snapshot().selectedSessionId;
    await assert.rejects(fixture.registry.changeProjectDirectory(join(fixture.root, "missing")), /Select an existing project directory/);
    assert.equal(fixture.registry.snapshot().selectedSessionId, selectedBeforeInvalid);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a pending Send stays bound to its original project when navigation changes", async () => {
  const fixture = await createFixture();
  try {
    await fixture.registry.initialize();
    const projectB = join(fixture.root, "project-b");
    const projectC = join(fixture.root, "project-c");
    await addProjectSessions(fixture, projectB);
    await mkdir(projectC, { recursive: true });
    await fixture.registry.changeProjectDirectory(projectB);

    let markEntered!: () => void;
    let releaseSend!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseSend = resolve; });
    fixture.setSendWaiter(async () => {
      markEntered();
      await blocked;
    });
    const sending = fixture.registry.sendNewSessionMessage(
      "bound to B",
      "bound-b",
      undefined,
      [],
      "send",
      projectB,
    );
    await entered;
    await fixture.registry.changeProjectDirectory(projectC);
    releaseSend();
    const result = await sending;

    assert.equal(fixture.registry.snapshot().projectDirectory, projectC);
    assert.equal(fixture.registry.snapshot().selectedSessionId, null);
    assert.equal(fixture.services.at(-1)!.snapshot().projectDirectory, projectB);
    assert.deepEqual(fixture.services.at(-1)!.sentMessages, ["bound to B"]);
    assert.equal(fixture.registry.snapshot().sessions.some(({ id }) => id === result.sessionId), true);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deleting an active session disposes its runtime and removes only its three session files", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const session = fixture.sessions[0]!;
    await fixture.registry.wakeSession(session.id);
    const unrelated = fixture.sessions.find(({ id }) => id !== session.id)!;
    const metadata = `${session.id}.pi-vot.jsonl`;
    const bigPi = bigPiDirectoryPath(session.id);
    const legacyBigPi = bigPiLegacySidecarPath(session.id);
    const unrelatedMetadata = `${unrelated.id}.pi-vot.jsonl`;
    const unrelatedBigPi = bigPiLegacySidecarPath(unrelated.id);
    await Promise.all([
      writeFile(metadata, '{"type":"compaction"}\n'),
      mkdir(bigPi, { recursive: true }),
      writeFile(legacyBigPi, "legacy Big Pi data"),
      writeFile(unrelatedMetadata, "keep metadata"),
      writeFile(unrelatedBigPi, "keep Big Pi data"),
    ]);
    await writeFile(join(bigPi, "manifest.json"), "{}");
    const runtime = fixture.services.at(-1)!;

    await fixture.registry.deleteSession(session.id);
    await fixture.registry.refreshPersistedState();

    assert.equal(runtime.stopped, true);
    assert.equal(fixture.registry.snapshot().sessions.some(({ id }) => id === session.id), false);
    for (const file of [session.id, metadata, bigPi, legacyBigPi]) {
      await assert.rejects(stat(file), { code: "ENOENT" });
    }
    for (const file of [unrelated.id, unrelatedMetadata, unrelatedBigPi]) await stat(file);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("live session navigation coalesces pending refreshes, refreshes again after completion, and isolates late results", async () => {
  const fixture = await createFixture(2);
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  try {
    await fixture.registry.initialize();
    const [sessionA, sessionB] = fixture.sessions;
    assert.ok(sessionA && sessionB);
    await fixture.registry.wakeSession(sessionA.id);
    const runtimeA = fixture.services.at(-1)!;
    await fixture.registry.wakeSession(sessionB.id);
    const runtimeB = fixture.services.at(-1)!;

    for (const [session, runtime] of [[sessionA, runtimeA], [sessionB, runtimeB]] as const) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      gates.set(session.id, { promise, resolve });
      runtime.refreshWork = async () => {
        await promise;
        if (session.id === sessionA.id) {
          runtime.emit({ type: "context_update", context: { tokens: 333, contextWindow: 10_000, percent: 3.33 } });
        }
      };
    }

    const navigationA = fixture.registry.switchSession(sessionA.id);
    assert.equal(fixture.registry.snapshot().selectedSessionId, sessionA.id);
    assert.equal(fixture.registry.snapshot().state, "idle");
    assert.equal(await Promise.race([
      navigationA.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]), "done");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runtimeA.refreshCount, 1);

    await fixture.registry.switchSession(sessionB.id);
    await fixture.registry.switchSession(sessionA.id);
    await fixture.registry.switchSession(sessionB.id);
    await fixture.registry.switchSession(sessionA.id);
    assert.equal(runtimeA.refreshCount, 1);
    assert.equal(runtimeB.refreshCount, 1);
    assert.equal(fixture.registry.snapshot().selectedSessionId, sessionA.id);

    await fixture.registry.switchSession(sessionB.id);
    gates.get(sessionA.id)!.resolve();
    const registryInternals = fixture.registry as unknown as {
      runtimeRefreshes: Map<object, Promise<void>>;
      runtimes: Map<string, { service: FakeRuntime }>;
    };
    const runtimeEntry = registryInternals.runtimes.get(sessionA.id)!;
    await registryInternals.runtimeRefreshes.get(runtimeEntry);
    assert.equal(registryInternals.runtimeRefreshes.has(runtimeEntry), false);
    assert.equal(runtimeA.canChangeModel, true);
    assert.equal(runtimeEntry.service, runtimeA);
    assert.equal(fixture.registry.snapshot().selectedSessionId, sessionB.id);
    assert.notEqual(fixture.registry.snapshot().context.tokens, 333);

    await fixture.registry.switchSession(sessionA.id);
    assert.equal(fixture.registry.snapshot().selectedSessionId, sessionA.id);
    assert.equal(fixture.registry.snapshot().context.tokens, 333);
    await waitFor(() => runtimeA.refreshCount === 2);
    assert.equal(runtimeA.refreshCount, 2);
    gates.get(sessionB.id)!.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("selecting running, stopping, compacting, or queued runtimes does not refresh Pi", async () => {
  const fixture = await createFixture(4);
  try {
    await fixture.registry.initialize();
    const [sessionA, sessionB, sessionC, sessionD] = fixture.sessions;
    assert.ok(sessionA && sessionB && sessionC && sessionD);
    const runtimeBySession = new Map<string, FakeRuntime>();
    for (const session of [sessionA, sessionB, sessionC, sessionD]) {
      await fixture.registry.wakeSession(session.id);
      runtimeBySession.set(session.id, fixture.services.at(-1)!);
    }

    const running = runtimeBySession.get(sessionA.id)!;
    await running.sendMessage("still running");
    const stopping = runtimeBySession.get(sessionB.id)!;
    stopping.emit({ type: "state", state: "stopping" });
    const compacting = runtimeBySession.get(sessionC.id)!;
    await compacting.compact();
    const queued = runtimeBySession.get(sessionD.id)!;
    await queued.compact();
    assert.equal(await queued.sendMessage("queued work", "queued-id"), "queued");
    queued.emit({ type: "compaction_end", success: true, aborted: false });
    assert.equal(queued.snapshot().state, "idle");
    assert.equal(queued.snapshot().queuedMessages.length, 1);

    for (const session of [sessionA, sessionB, sessionC, sessionD]) {
      const selection = fixture.registry.switchSession(session.id);
      assert.equal(fixture.registry.snapshot().selectedSessionId, session.id);
      assert.equal(await Promise.race([
        selection.then(() => "done"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
      ]), "done");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const runtime of runtimeBySession.values()) assert.equal(runtime.refreshCount, 0);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Wake activates one persisted session without sending or changing its transcript", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const target = fixture.sessions[1]!;
    const transcriptBefore = fixture.registry.snapshot().transcript;
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === target.id)?.hasRuntime, false);
    await assert.rejects(
      fixture.registry.wakeSession(join(fixture.sessionsDirectory, "deleted.jsonl")),
      /session is no longer available/,
    );
    assert.equal(fixture.services.length, 0);

    await fixture.registry.wakeSession(target.id);

    const snapshot = fixture.registry.snapshot();
    const runtime = fixture.services[0]!;
    assert.equal(fixture.services.length, 1);
    assert.equal(snapshot.selectedSessionId, target.id);
    assert.equal(snapshot.sessions.find(({ id }) => id === target.id)?.hasRuntime, true);
    assert.equal(snapshot.model?.id, "fake-model");
    assert.deepEqual(snapshot.context, { tokens: 100, contextWindow: 10_000, percent: 1 });
    assert.deepEqual(snapshot.transcript, transcriptBefore);
    assert.deepEqual(runtime.sentMessages, []);
    assert.equal(runtime.snapshot().isCompacting, false);
    assert.equal(fixture.registry.snapshot().sessions.filter(({ hasRuntime }) => hasRuntime).length, 1);

    await fixture.registry.releaseRuntime(target.id);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === target.id)?.hasRuntime, false);
    assert.deepEqual(fixture.registry.snapshot().transcript, transcriptBefore);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("inactive session Big Pi storage stays isolated across selection without activating Pi", async () => {
  const fixture = await createFixture(2);
  try {
    const [sessionA, sessionB] = fixture.sessions;
    assert.ok(sessionA && sessionB);
    const storageA = bigPiDirectoryPath(sessionA.id);
    const storageB = bigPiDirectoryPath(sessionB.id);
    const manifestA = JSON.stringify({
      schemaVersion: 1,
      producer: "big-pi",
      session: { sessionPath: sessionA.id },
      blocks: [{
        blockId: "B000001",
        tier: 1,
        chunkPath: "blocks/B000001.json",
        sha256: "a".repeat(64),
        private: "not sent",
      }],
    });
    const temporaryA = "temporary";
    const malformedManifest = "{ malformed";
    await Promise.all([mkdir(storageA), mkdir(storageB)]);
    await writeFile(join(storageA, "manifest.json"), manifestA);
    await writeFile(join(storageA, "orphan.tmp"), temporaryA);
    await writeFile(join(storageB, "manifest.json"), malformedManifest);

    await fixture.registry.initialize();
    await fixture.registry.switchSession(sessionA.id);
    await waitForSnapshot(fixture.registry, (snapshot) =>
      snapshot.selectedSessionId === sessionA.id &&
      snapshot.bigPi?.diskUsageBytes === Buffer.byteLength(manifestA) + Buffer.byteLength(temporaryA));
    assert.equal(fixture.registry.snapshot().selectedSessionId, sessionA.id);
    assert.deepEqual(fixture.registry.snapshot().bigPi, {
      storagePresent: true,
      diskUsageBytes: Buffer.byteLength(manifestA) + Buffer.byteLength(temporaryA),
      manifestStatus: "valid",
      totalChunks: 1,
      tiers: { t1: 1, t2: 0, t3: 0 },
    });
    assert.equal(JSON.stringify(fixture.registry.snapshot()).includes("private"), false);
    assert.equal(fixture.services.length, 0);

    await fixture.registry.switchSession(sessionB.id);
    await waitForSnapshot(fixture.registry, (snapshot) =>
      snapshot.selectedSessionId === sessionB.id && snapshot.bigPi?.manifestStatus === "malformed");
    assert.equal(fixture.registry.snapshot().bigPi?.manifestStatus, "malformed");
    assert.equal(fixture.registry.snapshot().bigPi?.diskUsageBytes, Buffer.byteLength(malformedManifest));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(fixture.registry.snapshot().bigPi?.manifestStatus, "malformed");
    await fixture.registry.refreshPersistedState();
    assert.equal(fixture.registry.snapshot().sessions.length, 2);
    assert.equal(fixture.registry.snapshot().bigPi?.manifestStatus, "malformed");
    assert.equal(fixture.services.length, 0);

    await fixture.registry.switchSession(sessionA.id);
    assert.deepEqual(fixture.registry.snapshot().bigPi, {
      storagePresent: true,
      diskUsageBytes: Buffer.byteLength(manifestA) + Buffer.byteLength(temporaryA),
      manifestStatus: "valid",
      totalChunks: 1,
      tiers: { t1: 1, t2: 0, t3: 0 },
    });
    assert.equal(fixture.services.length, 0);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("inactive Billion Context Pi summaries are session-scoped and do not activate Pi", async () => {
  const fixture = await createFixture(2);
  try {
    const [sessionA, sessionB] = fixture.sessions;
    assert.ok(sessionA && sessionB);
    const sidecar = billionContextPiSidecarPath(sessionA.id);
    await writeFile(sidecar, JSON.stringify({
      schemaVersion: 1,
      producer: "billion-context-pi@0.8.0",
      blocks: [
        { blockId: "b1", tier: 1 },
        { blockId: "b2", tier: 2 },
        { blockId: "b3", tier: 3 },
      ],
    }));
    const bigPiDirectory = bigPiDirectoryPath(sessionA.id);
    await mkdir(bigPiDirectory);
    await writeFile(join(bigPiDirectory, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      producer: "big-pi",
      session: { sessionPath: sessionA.id },
      blocks: [{ blockId: "B000001", tier: 1, chunkPath: "blocks/B000001.json", sha256: "a".repeat(64) }],
    }));
    await fixture.registry.initialize();
    await fixture.registry.switchSession(sessionA.id);
    const selected = await waitForSnapshot(fixture.registry, (snapshot) =>
      snapshot.selectedSessionId === sessionA.id && snapshot.billionContextPi?.manifestStatus === "valid");
    assert.deepEqual(selected.billionContextPi, {
      detected: true,
      sidecarPresent: true,
      manifestStatus: "valid",
      totalBlocks: 3,
      tiers: { t1: 1, t2: 1, t3: 1 },
    });
    assert.equal(fixture.registry.snapshot().billionContextPi?.detected, true);
    assert.equal(fixture.registry.snapshot().bigPi?.storagePresent, true);
    assert.equal(fixture.services.length, 0);

    await fixture.registry.switchSession(sessionB.id);
    const other = await waitForSnapshot(fixture.registry, (snapshot) =>
      snapshot.selectedSessionId === sessionB.id && snapshot.billionContextPi?.manifestStatus === "absent");
    assert.equal(other.billionContextPi?.detected, false);
    assert.equal(fixture.services.length, 0);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("compaction completion refreshes selected-session Big Pi disk usage", async () => {
  const fixture = await createFixture(1);
  try {
    const session = fixture.sessions[0]!;
    const storage = bigPiDirectoryPath(session.id);
    await mkdir(storage);
    const manifest = (blocks: unknown[]) => JSON.stringify({
      schemaVersion: 1,
      producer: "big-pi",
      session: { sessionPath: session.id },
      blocks,
    });
    const firstBlock = {
      blockId: "B000001",
      tier: 1,
      chunkPath: "blocks/B000001.json",
      sha256: "a".repeat(64),
    };
    const firstManifest = manifest([firstBlock]);
    await writeFile(join(storage, "manifest.json"), firstManifest);
    await fixture.registry.initialize();
    const initial = await waitForSnapshot(fixture.registry, (snapshot) =>
      snapshot.bigPi?.diskUsageBytes === Buffer.byteLength(firstManifest));
    assert.equal(initial.bigPi?.totalChunks, 1);

    await fixture.registry.wakeSession(session.id);
    const service = fixture.services[0]!;
    const updatedManifest = manifest([
      firstBlock,
      { ...firstBlock, blockId: "B000002", tier: 2, chunkPath: "blocks/B000002.json" },
    ]);
    await writeFile(join(storage, "manifest.json"), updatedManifest);
    service.emit({ type: "compaction_end", success: true, aborted: false });

    const updatedDiskUsage = Buffer.byteLength(updatedManifest);
    const refreshed = await waitForSnapshot(fixture.registry, (snapshot) =>
      snapshot.selectedSessionId === session.id &&
      snapshot.bigPi?.manifestStatus === "valid" &&
      snapshot.bigPi.diskUsageBytes === updatedDiskUsage &&
      snapshot.bigPi.totalChunks === 2);
    assert.equal(refreshed.bigPi?.diskUsageBytes, updatedDiskUsage);
    assert.equal(refreshed.bigPi?.totalChunks, 2);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("successful Big Pi compression refreshes the stats after its manifest commit", async () => {
  const fixture = await createFixture(1);
  try {
    const session = fixture.sessions[0]!;
    const storage = bigPiDirectoryPath(session.id);
    await mkdir(storage);
    const manifest = (blocks: unknown[]) => JSON.stringify({
      schemaVersion: 1,
      producer: "big-pi",
      session: { sessionPath: session.id },
      blocks,
    });
    await writeFile(join(storage, "manifest.json"), manifest([]));
    await fixture.registry.initialize();
    assert.equal(fixture.registry.snapshot().bigPi?.totalChunks, 0);

    await fixture.registry.wakeSession(session.id);
    await writeFile(join(storage, "manifest.json"), manifest([{
      blockId: "B000001",
      tier: 1,
      chunkPath: "blocks/B000001.json",
      sha256: "a".repeat(64),
    }]));
    fixture.services[0]!.emit({
      type: "tool_end",
      toolCallId: "compress-1",
      toolName: "big_pi_compress",
      output: "Committed B000001",
      isError: false,
    });

    const refreshed = await waitForSnapshot(fixture.registry, (snapshot) => snapshot.bigPi?.totalChunks === 1);
    assert.equal(refreshed.bigPi?.manifestStatus, "valid");
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("successful BCP compress refreshes its block stats after the sidecar commit", async () => {
  const fixture = await createFixture(1);
  try {
    const session = fixture.sessions[0]!;
    const sidecar = billionContextPiSidecarPath(session.id);
    const manifest = (blocks: unknown[]) => JSON.stringify({
      producer: "billion-context-pi@1.0.0",
      schemaVersion: 1,
      blocks,
    });
    await writeFile(sidecar, manifest([]));
    await fixture.registry.initialize();
    assert.equal(fixture.registry.snapshot().billionContextPi?.totalBlocks, 0);

    await fixture.registry.wakeSession(session.id);
    await writeFile(sidecar, manifest([{ blockId: "b1", tier: 1 }]));
    fixture.services[0]!.emit({
      type: "tool_end",
      toolCallId: "compress-1",
      toolName: "compress",
      output: "Compressed b1",
      isError: false,
    });

    const refreshed = await waitForSnapshot(fixture.registry, (snapshot) =>
      snapshot.billionContextPi?.totalBlocks === 1);
    assert.equal(refreshed.billionContextPi?.manifestStatus, "valid");
    assert.equal(refreshed.billionContextPi?.tiers?.t1, 1);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("overlapping Big Pi refreshes coalesce and preserve one trailing scan", async () => {
  const resolvers: Array<(summary: BigPiSummary) => void> = [];
  let delayedReads = 0;
  let delay = false;
  const reader = async (sessionPath: string): Promise<BigPiSummary> => {
    if (!delay) return readBigPiSummary(sessionPath);
    delayedReads++;
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const fixture = await createFixture(1, undefined, undefined, reader);
  try {
    await fixture.registry.initialize();
    const sessionId = fixture.sessions[0]!.id;
    delay = true;
    const registry = fixture.registry as unknown as {
      refreshBigPiSummary(id: string): Promise<void>;
    };
    const first = registry.refreshBigPiSummary(sessionId);
    await waitFor(() => delayedReads === 1);
    const overlapping = registry.refreshBigPiSummary(sessionId);
    resolvers[0]!({
      storagePresent: true,
      diskUsageBytes: 111,
      manifestStatus: "valid",
      totalChunks: 1,
      tiers: { t1: 1, t2: 0, t3: 0 },
    });
    await waitFor(() => delayedReads === 2);
    resolvers[1]!({
      storagePresent: true,
      diskUsageBytes: 222,
      manifestStatus: "valid",
      totalChunks: 2,
      tiers: { t1: 0, t2: 2, t3: 0 },
    });
    await Promise.all([first, overlapping]);
    assert.equal(delayedReads, 2);
    assert.equal(fixture.registry.snapshot().bigPi?.diskUsageBytes, 222);
    assert.equal(fixture.registry.snapshot().bigPi?.totalChunks, 2);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("session deletion invalidates an in-flight Big Pi scan", async () => {
  let release!: (summary: BigPiSummary) => void;
  let delayedReads = 0;
  let delay = false;
  const reader = async (sessionPath: string): Promise<BigPiSummary> => {
    if (!delay) return readBigPiSummary(sessionPath);
    delayedReads++;
    return new Promise((resolve) => { release = resolve; });
  };
  const fixture = await createFixture(1, undefined, undefined, reader);
  try {
    await fixture.registry.initialize();
    const sessionId = fixture.sessions[0]!.id;
    delay = true;
    const registry = fixture.registry as unknown as {
      refreshBigPiSummary(id: string): Promise<void>;
      bigPiBySession: Map<string, BigPiSummary | null>;
    };
    const refresh = registry.refreshBigPiSummary(sessionId);
    await waitFor(() => delayedReads === 1);
    await fixture.registry.deleteSession(sessionId);
    release({
      storagePresent: true,
      diskUsageBytes: 999,
      manifestStatus: "valid",
      totalChunks: 9,
      tiers: { t1: 0, t2: 0, t3: 9 },
    });
    await refresh;
    assert.equal(registry.bigPiBySession.has(sessionId), false);
    assert.equal(fixture.registry.snapshot().selectedSessionId, null);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent and repeated Wake requests share one runtime; lazy Send still submits normally", async () => {
  const fixture = await createFixture(3);
  try {
    await fixture.registry.initialize();
    const target = fixture.sessions[1]!;

    await Promise.all([
      fixture.registry.wakeSession(target.id),
      fixture.registry.wakeSession(target.id),
    ]);
    await fixture.registry.wakeSession(target.id);
    assert.equal(fixture.services.length, 1);
    assert.deepEqual(fixture.services[0]!.sentMessages, []);

    await fixture.registry.releaseRuntime(target.id);
    const lazyTarget = fixture.sessions[2]!;
    await fixture.registry.sendMessage("normal lazy send", "lazy-send", lazyTarget.id);
    assert.equal(fixture.services.length, 2);
    assert.deepEqual(fixture.services[1]!.sentMessages, ["normal lazy send"]);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === lazyTarget.id)?.active, true);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Wake enforces the four-runtime cap and failed startup frees its slot", async () => {
  const fixture = await createFixture(5);
  try {
    await fixture.registry.initialize();
    const targetSessions = fixture.sessions.slice(0, MAX_ACTIVE_RUNTIMES);
    for (const session of targetSessions) await fixture.registry.wakeSession(session.id);
    const fifth = fixture.sessions[MAX_ACTIVE_RUNTIMES]!;

    await assert.rejects(fixture.registry.wakeSession(fifth.id), /Four Pi sessions are already active/);
    assert.equal(fixture.services.length, MAX_ACTIVE_RUNTIMES);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === fifth.id)?.hasRuntime, false);

    const target = fixture.sessions[4]!;
    await fixture.registry.releaseRuntime(targetSessions[0]!.id);
    fixture.failNextInitialization();
    await assert.rejects(fixture.registry.wakeSession(target.id), /Fake Pi failed to initialize/);
    assert.equal(fixture.services.at(-1)?.stopped, true);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === target.id)?.hasRuntime, false);
    await fixture.registry.wakeSession(target.id);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === target.id)?.hasRuntime, true);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("New Session reports a failed startup, leaves no runtime registered, and can retry", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const previouslySelected = fixture.registry.snapshot().selectedSessionId;
    fixture.failNextInitialization();

    await assert.rejects(
      fixture.registry.newSession(),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : String(error), /Fake Pi failed to initialize/);
        assert.doesNotMatch(error instanceof Error ? error.message : String(error), /Finish or stop the active Pi operation/);
        return true;
      },
    );

    assert.equal(fixture.registry.snapshot().selectedSessionId, previouslySelected);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === previouslySelected)?.hasRuntime, false);
    assert.equal(fixture.services.at(-1)?.stopped, true);

    await fixture.registry.newSession();

    const selected = fixture.registry.snapshot().selectedSessionId;
    assert.notEqual(selected, previouslySelected);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === selected)?.hasRuntime, true);
    assert.equal(fixture.services.at(-1)?.stopped, false);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("all project groups remain visible and inactive transcripts hydrate without runtimes", async () => {
  const fixture = await createFixture(2);
  const otherProject = join(fixture.root, "other-project");
  const otherSessions = await addProjectSessions(fixture, otherProject, 2);
  try {
    await fixture.registry.initialize();
    const snapshot = fixture.registry.snapshot();
    assert.equal(fixture.services.length, 0);
    assert.deepEqual([...new Set(snapshot.sessions.map(({ cwd }) => cwd))], [fixture.cwd, otherProject]);
    assert.deepEqual(snapshot.sessions.slice(0, 2).map(({ cwd }) => cwd), [fixture.cwd, fixture.cwd]);
    assert.equal(snapshot.sessions.filter(({ cwd }) => cwd === otherProject).length, 2);

    await fixture.registry.switchSession(otherSessions[0]!.id);
    await waitForSnapshot(fixture.registry, (current) =>
      current.selectedSessionId === otherSessions[0]!.id && current.transcript.length > 0,
    );
    assert.equal(fixture.registry.snapshot().selectedSessionId, otherSessions[0]!.id);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === otherSessions[0]!.id)?.hasRuntime, false);
    assert.deepEqual(fixture.registry.snapshot().transcript.map(({ type }) => type), ["user", "assistant"]);
    const firstMessage = fixture.registry.snapshot().transcript[0];
    assert.equal(firstMessage?.type, "user");
    if (firstMessage?.type === "user") assert.equal(firstMessage.text, `History from ${otherProject}`);
    await fixture.registry.switchSession(otherSessions[1]!.id);
    await waitForSnapshot(fixture.registry, (current) =>
      current.selectedSessionId === otherSessions[1]!.id && current.transcript.length > 0,
    );
    assert.equal(fixture.services.length, 0);
    await fixture.registry.sendMessage("activate this project history", undefined, otherSessions[1]!.id);
    assert.equal(fixture.services.length, 1);
    assert.equal(fixture.services[0]!.snapshot().projectDirectory, otherProject);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("known project-specific session directories survive project changes and refresh", async () => {
  const fixture = await createFixture(1);
  const customProject = join(fixture.root, "custom-project");
  const customSessionDirectory = join(fixture.root, "custom-only-sessions");
  const customSession = join(customSessionDirectory, "history.jsonl");
  await mkdir(join(customProject, ".pi"), { recursive: true });
  await mkdir(customSessionDirectory, { recursive: true });
  await writeFile(join(customProject, ".pi", "settings.json"), JSON.stringify({
    sessionDir: customSessionDirectory,
  }));
  await writeFile(customSession, [
    JSON.stringify({ type: "session", id: "custom-history", cwd: customProject }),
    JSON.stringify({
      type: "message",
      id: "custom-user",
      message: { role: "user", content: `Stored under ${customProject}` },
    }),
  ].join("\n") + "\n");
  try {
    await fixture.registry.initialize();
    await fixture.registry.changeProjectDirectory(customProject);
    assert.ok(fixture.registry.snapshot().sessions.some(({ id }) => id === customSession));
    await fixture.registry.changeProjectDirectory(fixture.cwd);
    await fixture.registry.refreshPersistedState();
    assert.ok(fixture.registry.snapshot().sessions.some(({ id }) => id === customSession));
    assert.equal(fixture.services.length, 0);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("model inspection does not activate historical sessions and model state stays runtime-local", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.registry.snapshot().activeSessionId!;
    const sessionB = fixture.sessions.find(({ id }) => id !== sessionA)!.id;
    const inactiveModels = await fixture.registry.getAvailableModels(sessionB);
    assert.equal(inactiveModels.hasRuntime, false);
    assert.equal(inactiveModels.canChange, false);
    assert.match(inactiveModels.message ?? "", /Activate this session/);
    const inactiveTemplates = await fixture.registry.getPromptTemplates(sessionB);
    assert.equal(inactiveTemplates.hasRuntime, false);
    assert.deepEqual(inactiveTemplates.commands, []);
    assert.match(inactiveTemplates.message ?? "", /Activate this session/);
    assert.equal(fixture.services.length, 0);

    await fixture.registry.switchSession(sessionB);
    assert.equal(fixture.registry.snapshot().model, null);
    assert.equal(fixture.services.length, 0);
    await fixture.registry.sendMessage("activate B", undefined, sessionB);
    await fixture.registry.abort(sessionB);
    const activeTemplates = await fixture.registry.getPromptTemplates(sessionB);
    assert.equal(activeTemplates.hasRuntime, true);
    assert.deepEqual(activeTemplates.commands, [{ name: "review", description: "Review changes" }]);
    const modelB = fixture.registry.snapshot().model;
    await fixture.registry.changeModel(sessionB, "fake", "changed-model");
    assert.equal(fixture.registry.snapshot().model?.id, "changed-model");
    await fixture.registry.switchSession(sessionA);
    assert.equal(fixture.registry.snapshot().model, null);
    await fixture.registry.sendMessage("activate A", undefined, sessionA);
    assert.equal(fixture.services[0]!.snapshot().model?.id, "changed-model");
    assert.notDeepEqual(fixture.services[0]!.snapshot().model, modelB);
    assert.equal(fixture.services[1]!.snapshot().model?.id, "fake-model");
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("project model choice is remembered for the next session without changing the prior runtime", async () => {
  const fixture = await createFixture(1);
  const otherProject = join(fixture.root, "other-project");
  await mkdir(otherProject, { recursive: true });
  try {
    await fixture.registry.initialize();
    await fixture.registry.wakeSession(fixture.sessions[0]!.id);
    const priorRuntime = fixture.services[0]!;
    await fixture.registry.changeProjectDirectory(otherProject);
    const options = await fixture.registry.getProjectAvailableModels(otherProject);
    assert.equal(options.model?.id, "fake-model");
    assert.equal(options.models.length, 2);
    await fixture.registry.changeProjectModel(otherProject, "fake", "changed-model");
    assert.equal(fixture.registry.snapshot().model?.id, "changed-model");
    assert.equal(priorRuntime.snapshot().model?.id, "fake-model");

    await fixture.registry.sendNewSessionMessage("use project model", "new-message", undefined, [], "send", otherProject);
    assert.equal(fixture.services.at(-1)?.snapshot().model?.id, "changed-model");
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("events carry their owning session and failure/stop remain isolated", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.registry.snapshot().activeSessionId!;
    await fixture.registry.sendMessage("activate A", undefined, sessionA);
    const runtimeA = fixture.services[0]!;
    const sessionB = fixture.sessions.find(({ id }) => id !== sessionA)!.id;
    await fixture.registry.switchSession(sessionB);
    await fixture.registry.sendMessage("activate B", undefined, sessionB);
    const runtimeB = fixture.services[1]!;
    const events: PiVotEvent[] = [];
    fixture.registry.subscribe((event) => events.push(event));

    runtimeA.emit({ type: "assistant_delta", messageId: "a-1", text: "A only" });
    runtimeA.emit({ type: "context_update", context: { tokens: 10, contextWindow: 100, percent: 10 } });
    runtimeA.emit({ type: "error", message: "A failed" });
    runtimeA.emit({ type: "state", state: "failed", error: "A failed" });
    runtimeB.emit({ type: "assistant_delta", messageId: "b-1", text: "B only" });
    await fixture.registry.abort(sessionB);

    assert.ok(events.some((event) => event.type === "assistant_delta" &&
      event.sessionId === sessionA && event.text === "A only"));
    assert.ok(events.some((event) => event.type === "assistant_delta" &&
      event.sessionId === sessionB && event.text === "B only"));
    assert.equal(runtimeA.abortCount, 0);
    assert.equal(runtimeB.abortCount, 1);
    assert.equal(fixture.registry.snapshot().activeSessionId, sessionB);
    assert.equal(fixture.registry.snapshot().state, "idle");
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === sessionA)?.active, false);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Send lazily activates an inactive session and compaction queues remain session-local", async () => {
  const fixture = await createFixture(3);
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.registry.snapshot().activeSessionId!;
    const sessionB = fixture.sessions.find(({ id }) => id !== sessionA)!.id;
    const sessionC = fixture.sessions.find(({ id }) => id !== sessionA && id !== sessionB)!.id;
    assert.equal(fixture.services.length, 0);

    const image = { mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 };
    assert.equal(await fixture.registry.sendMessage("start B", "b-message", sessionB, [image]), "started");
    assert.equal(fixture.services.length, 1);
    assert.deepEqual(fixture.services[0]!.sentImages[0], [image]);
    assert.equal(fixture.registry.snapshot().activeSessionId, sessionA);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === sessionB)?.active, true);

    await fixture.registry.sendMessage("start A", "a-message", sessionA);
    await fixture.registry.compact(sessionA);
    assert.equal(await fixture.registry.sendMessage("queue in A", "a-queued", sessionA), "queued");
    await fixture.registry.switchSession(sessionB);
    assert.equal(fixture.registry.snapshot().isCompacting, false);
    assert.deepEqual(fixture.registry.snapshot().queuedMessages, []);
    await fixture.registry.switchSession(sessionA);
    assert.equal(fixture.registry.snapshot().isCompacting, true);
    assert.deepEqual(fixture.registry.snapshot().queuedMessages.map(({ id }) => id), ["a-queued"]);

    await fixture.registry.sendMessage("activate C", "c-message", sessionC);
    assert.equal(fixture.services.length, 3);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === sessionC)?.active, true);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("project browsing changes do not release existing runtimes and shutdown closes every runtime", async () => {
  const fixture = await createFixture(2);
  const secondProject = join(fixture.root, "other-project");
  await mkdir(secondProject);
  try {
    await fixture.registry.initialize();
    const initial = fixture.registry.snapshot().activeSessionId;
    await fixture.registry.sendMessage("start current", undefined, initial!);
    const differentSession = fixture.sessions.find(({ id }) => id !== initial)!;
    await fixture.registry.switchSession(differentSession.id);
    await fixture.registry.changeProjectDirectory(secondProject);
    assert.equal(fixture.services.length, 1);
    assert.equal(fixture.services.some((service) => service.stopped), false);
    assert.equal(fixture.registry.snapshot().projectDirectory, secondProject);
    await fixture.registry.stop();
    assert.ok(fixture.services.every((service) => service.stopped));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("background runtimes stay visible, selectable, stoppable, and releasable across project refreshes", async () => {
  const fixture = await createFixture(2);
  const secondProject = join(fixture.root, "other-project");
  const [sessionB] = await addProjectSessions(fixture, secondProject);
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.registry.snapshot().activeSessionId!;
    await fixture.registry.sendMessage("keep running in A", "a-running", sessionA);
    const runtimeA = fixture.services[0]!;
    await fixture.registry.changeProjectDirectory(secondProject);
    await fixture.registry.switchSession(sessionB!.id);
    await fixture.registry.sendMessage("start B", "b-start", sessionB!.id);

    const activeA = fixture.registry.snapshot().sessions.find(({ id }) => id === sessionA);
    const activeB = fixture.registry.snapshot().sessions.find(({ id }) => id === sessionB!.id);
    assert.ok(activeA);
    assert.ok(activeB);
    assert.equal(activeA.active, true);
    assert.equal(activeA.cwd, fixture.cwd);
    assert.equal(activeB.cwd, secondProject);
    assert.equal(activeA.name, fixture.sessions.find(({ id }) => id === sessionA)?.name);

    await fixture.registry.refreshPersistedState();
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === sessionA)?.active, true);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === sessionA)?.cwd, fixture.cwd);
    await fixture.registry.switchSession(sessionA);
    assert.equal(fixture.registry.snapshot().state, "running");
    await fixture.registry.abort(sessionA);
    await fixture.registry.releaseRuntime(sessionA);
    assert.equal(runtimeA.stopped, true);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === sessionA)?.hasRuntime, false);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("renaming an inactive session uses a temporary helper instead of borrowing a busy runtime", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.registry.snapshot().activeSessionId!;
    const sessionB = fixture.sessions.find(({ id }) => id !== sessionA)!.id;
    await fixture.registry.sendMessage("start A", "a-running", sessionA);
    const runtimeA = fixture.services[0]!;

    await fixture.registry.renameSession(sessionB, "Renamed B");

    assert.deepEqual(fixture.services[1]!.renamedSessions, [{ id: sessionB, name: "Renamed B" }]);
    assert.equal(fixture.services[1]!.stopped, true);
    assert.equal(runtimeA.snapshot().state, "running");
    assert.equal(runtimeA.stopped, false);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("deleting an inactive session leaves a busy runtime untouched", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.registry.snapshot().activeSessionId!;
    const sessionB = fixture.sessions.find(({ id }) => id !== sessionA)!.id;
    await fixture.registry.sendMessage("start A", "a-running", sessionA);
    const runtimeA = fixture.services[0]!;

    await fixture.registry.deleteSession(sessionB);

    assert.equal(fixture.services.length, 1);
    assert.equal(runtimeA.snapshot().state, "running");
    assert.equal(runtimeA.stopped, false);
    await assert.rejects(stat(sessionB), { code: "ENOENT" });
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("metadata helper creation is rejected at capacity without stopping busy runtimes", async () => {
  const fixture = await createFixture(5);
  try {
    await fixture.registry.initialize();
    const activeSessionIds = [fixture.registry.snapshot().activeSessionId!];
    activeSessionIds.push(...fixture.sessions
      .filter(({ id }) => id !== activeSessionIds[0])
      .slice(0, MAX_ACTIVE_RUNTIMES - 1)
      .map(({ id }) => id));

    for (const sessionId of activeSessionIds) {
      await fixture.registry.sendMessage(`busy ${sessionId}`, `message-${sessionId}`, sessionId);
    }

    const inactiveSession = fixture.sessions.find(({ id }) => !activeSessionIds.includes(id))!;
    await assert.rejects(
      fixture.registry.renameSession(inactiveSession.id, "Cannot rename yet"),
      /Four Pi sessions are already active/,
    );
    assert.equal(fixture.services.length, MAX_ACTIVE_RUNTIMES);
    assert.ok(fixture.services.every((service) => service.snapshot().state === "running"));
    assert.ok(fixture.services.every((service) => !service.stopped));
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("New Session works for a released selection without commandeering a busy runtime", async () => {
  const fixture = await createFixture(3);
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.registry.snapshot().activeSessionId!;
    const sessionB = fixture.sessions.find(({ id }) => id !== sessionA)!.id;
    await fixture.registry.sendMessage("start A", "a-running", sessionA);
    await fixture.registry.abort(sessionA);
    await fixture.registry.sendMessage("keep B running", "b-running", sessionB);
    const runtimeB = fixture.services[1]!;
    await fixture.registry.releaseRuntime(sessionA);

    await fixture.registry.newSession();

    const newSessionId = fixture.registry.snapshot().activeSessionId!;
    assert.notEqual(newSessionId, sessionA);
    assert.equal(fixture.services.length, 3);
    assert.equal(fixture.services[0]!.stopped, true);
    assert.equal(runtimeB.snapshot().state, "running");
    assert.equal(runtimeB.stopped, false);
    assert.equal(fixture.services[2]!.newSessionCount, 0);
    assert.equal(fixture.services[2]!.stopped, false);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("New Session starts another runtime in the same project when its selected session is busy", async () => {
  const fixture = await createFixture(3);
  try {
    await fixture.registry.initialize();
    const busySessionId = fixture.registry.snapshot().activeSessionId!;
    await fixture.registry.sendMessage("keep this session running", "busy-session", busySessionId);
    const busyRuntime = fixture.services[0]!;

    await fixture.registry.newSession();

    const newSessionId = fixture.registry.snapshot().activeSessionId!;
    assert.notEqual(newSessionId, busySessionId);
    assert.match(newSessionId, /fresh-[0-9a-f-]+\.jsonl$/);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === newSessionId)?.cwd, fixture.cwd);
    assert.equal(fixture.services.length, 2);
    assert.equal(fixture.services[1]!.newSessionCount, 0);
    assert.equal(busyRuntime.snapshot().state, "running");
    assert.equal(busyRuntime.stopped, false);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("New Session inherits the model from the awake session in the same project", async () => {
  const fixture = await createFixture(3);
  try {
    await fixture.registry.initialize();
    const sourceSessionId = fixture.registry.snapshot().activeSessionId!;
    await fixture.registry.wakeSession(sourceSessionId);
    await fixture.registry.changeModel(sourceSessionId, "fake", "changed-model");
    await fixture.registry.sendMessage("keep this session running", "busy-session", sourceSessionId);

    await fixture.registry.newSession();

    const newSessionId = fixture.registry.snapshot().activeSessionId!;
    assert.notEqual(newSessionId, sourceSessionId);
    assert.equal(fixture.registry.snapshot().model?.id, "changed-model");
    assert.equal(fixture.services[1]!.snapshot().model?.id, "changed-model");
    assert.equal(fixture.services[0]!.snapshot().state, "running");
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("New Session starts an isolated runtime when another session in the project is busy", async () => {
  const fixture = await createFixture(3);
  try {
    await fixture.registry.initialize();
    const selectedIdleSessionId = fixture.registry.snapshot().activeSessionId!;
    const busySessionId = fixture.sessions.find(({ id }) => id !== selectedIdleSessionId)!.id;
    await fixture.registry.wakeSession(busySessionId);
    await fixture.registry.sendMessage("keep this session running", "other-busy-session", busySessionId);
    const busyRuntime = fixture.services[0]!;

    // Keep an idle session selected while another session in the same project
    // is running, matching the background-runtime case in the UI.
    await fixture.registry.switchSession(selectedIdleSessionId);
    await fixture.registry.newSession();

    const newSessionId = fixture.registry.snapshot().activeSessionId!;
    assert.notEqual(newSessionId, selectedIdleSessionId);
    assert.notEqual(newSessionId, busySessionId);
    assert.match(newSessionId, /fresh-[0-9a-f-]+\.jsonl$/);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === newSessionId)?.cwd, fixture.cwd);
    assert.equal(fixture.services.length, 2);
    assert.equal(fixture.services[1]!.newSessionCount, 0);
    assert.equal(busyRuntime.snapshot().state, "running");
    assert.equal(busyRuntime.stopped, false);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("New Session retries in a fresh runtime if Pi becomes busy during the new-session command", async () => {
  const fixture = await createFixture(3);
  try {
    await fixture.registry.initialize();
    const previouslySelected = fixture.registry.snapshot().activeSessionId!;
    await fixture.registry.wakeSession(previouslySelected);
    const existingRuntime = fixture.services[0]!;
    existingRuntime.startRunningBeforeNewSessionError = true;

    await fixture.registry.newSession();

    const newSessionId = fixture.registry.snapshot().activeSessionId!;
    assert.notEqual(newSessionId, previouslySelected);
    assert.match(newSessionId, /fresh-[0-9a-f-]+\.jsonl$/);
    assert.equal(fixture.services.length, 2);
    assert.equal(existingRuntime.snapshot().state, "running");
    assert.equal(existingRuntime.stopped, false);
    assert.equal(fixture.services[1]!.newSessionCount, 0);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
