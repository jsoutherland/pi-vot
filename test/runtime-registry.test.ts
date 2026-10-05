import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiDiscoveryContext } from "../src/pi-service.ts";
import {
  PiRuntimeRegistry,
  MAX_ACTIVE_RUNTIMES,
} from "../src/runtime-registry.ts";
import type {
  PiVotEvent,
  PiVotSnapshot,
  PiSession,
} from "../src/pi-service.ts";
import type { ImageAttachment } from "../src/request.ts";

class FakeRuntime {
  private listeners = new Set<(event: PiVotEvent) => void>();
  private state: PiVotSnapshot["state"] = "idle";
  private compacting = false;
  private context: PiVotSnapshot["context"] = { tokens: null, contextWindow: null, percent: null };
  private model: PiVotSnapshot["model"] = null;
  private transcript: PiVotSnapshot["transcript"] = [];
  private queuedMessages: PiVotSnapshot["queuedMessages"] = [];
  private sessions: PiSession[] = [];
  private readonly cwd: string;
  private readonly knownSessions: Map<string, PiSession[]>;
  activeSessionId: string | null = null;
  stopped = false;
  failInitialize = false;
  abortCount = 0;
  sentMessages: string[] = [];
  newSessionCount = 0;
  renamedSessions: Array<{ id: string; name: string }> = [];
  deletedSessions: string[] = [];
  sentImages: ImageAttachment[][] = [];

  constructor(cwd: string, knownSessions: Map<string, PiSession[]>) {
    this.cwd = cwd;
    this.knownSessions = knownSessions;
  }

  async initialize(): Promise<void> {
    if (this.failInitialize) throw new Error("Fake Pi failed to initialize.");
    this.sessions = this.knownSessions.get(this.cwd) ?? [];
    this.activeSessionId = this.sessions[0]?.id ?? `${this.cwd}/generated.jsonl`;
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
    };
  }

  async refreshPersistedState(): Promise<void> {}

  async getAvailableModels() {
    return [
      { provider: "fake", id: "fake-model", name: "fake-model", contextWindow: 10_000 },
      { provider: "fake", id: "changed-model", name: "changed-model", contextWindow: 20_000 },
    ];
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
    this.activeSessionId = `${this.cwd}/new-session.jsonl`;
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

async function createFixture(sessionCount = 5): Promise<{
  root: string;
  cwd: string;
  sessions: PiSession[];
  registry: PiRuntimeRegistry;
  services: FakeRuntime[];
  sessionsDirectory: string;
  configuredSessions: Map<string, PiSession[]>;
  discoveryContext: PiDiscoveryContext;
  failNextInitialization: () => void;
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
  const registry = new PiRuntimeRegistry(cwd, (directory) => {
    const service = new FakeRuntime(directory, configuredSessions);
    service.failInitialize = failNextInitialization;
    failNextInitialization = false;
    services.push(service);
    return service as never;
  }, discoveryContext);
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
    const activeSession = fixture.registry.snapshot().sessions.find(({ active }) => active)!;
    await assert.rejects(fixture.registry.deleteSession(activeSession.id), /Close this session's runtime/);

    const fifth = fixture.sessions.find(({ id }) =>
      !fixture.services.some((service) => service.activeSessionId === id),
    )!;
    await fixture.registry.switchSession(fifth.id);
    assert.equal(fixture.registry.snapshot().selectedSessionId, fifth.id);
    await assert.rejects(fixture.registry.sendMessage("capacity", undefined, fifth.id), /Four Pi sessions are already active/);
    assert.equal(fixture.services.length, MAX_ACTIVE_RUNTIMES);
    assert.equal(fixture.services.some((service) => service.stopped), false);

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
    assert.equal(fixture.registry.snapshot().selectedSessionId, otherSessions[0]!.id);
    assert.equal(fixture.registry.snapshot().sessions.find(({ id }) => id === otherSessions[0]!.id)?.hasRuntime, false);
    assert.deepEqual(fixture.registry.snapshot().transcript.map(({ type }) => type), ["user", "assistant"]);
    const firstMessage = fixture.registry.snapshot().transcript[0];
    assert.equal(firstMessage?.type, "user");
    if (firstMessage?.type === "user") assert.equal(firstMessage.text, `History from ${otherProject}`);
    await fixture.registry.switchSession(otherSessions[1]!.id);
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
    assert.equal(fixture.services.length, 0);

    await fixture.registry.switchSession(sessionB);
    assert.equal(fixture.registry.snapshot().model, null);
    assert.equal(fixture.services.length, 0);
    await fixture.registry.sendMessage("activate B", undefined, sessionB);
    await fixture.registry.abort(sessionB);
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

test("deleting an inactive session uses a temporary helper instead of borrowing a busy runtime", async () => {
  const fixture = await createFixture(2);
  try {
    await fixture.registry.initialize();
    const sessionA = fixture.registry.snapshot().activeSessionId!;
    const sessionB = fixture.sessions.find(({ id }) => id !== sessionA)!.id;
    await fixture.registry.sendMessage("start A", "a-running", sessionA);
    const runtimeA = fixture.services[0]!;

    await fixture.registry.deleteSession(sessionB);

    assert.deepEqual(fixture.services[1]!.deletedSessions, [sessionB]);
    assert.equal(fixture.services[1]!.stopped, true);
    assert.equal(runtimeA.snapshot().state, "running");
    assert.equal(runtimeA.stopped, false);
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
    assert.equal(fixture.services[2]!.newSessionCount, 1);
    assert.equal(fixture.services[2]!.stopped, false);
  } finally {
    await fixture.registry.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
