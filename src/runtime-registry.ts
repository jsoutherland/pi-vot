import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PiService,
  capturePiDiscoveryContext,
  discoverPiSessions,
  hydratePiSession,
  type ActiveModel,
  type AvailableModelsResult,
  type PiDiscoveryContext,
  type PiVotEvent,
  type PiVotSnapshot,
  type PiSession,
} from "./pi-service.ts";
import type { ImageAttachment } from "./request.ts";

export const MAX_ACTIVE_RUNTIMES = 4;

interface Runtime {
  service: PiService;
  cwd: string;
  sessionId: string;
  unsubscribe: () => void;
}

const emptySnapshot = (projectDirectory: string): PiVotSnapshot => ({
  state: "idle",
  isCompacting: false,
  context: { tokens: null, contextWindow: null, percent: null },
  model: null,
  queuedMessages: [],
  projectDirectory,
  activeSessionId: null,
  selectedSessionId: null,
  activeSessionName: null,
  sessions: [],
  transcript: [],
});

function sortSessions(sessions: PiSession[], currentCwd: string): PiSession[] {
  const recency = new Map<string, string>();
  for (const session of sessions) {
    if ((recency.get(session.cwd) ?? "") < session.updatedAt) recency.set(session.cwd, session.updatedAt);
  }
  return [...sessions].sort((left, right) => {
    const leftCurrent = process.platform === "win32"
      ? left.cwd.toLowerCase() === currentCwd.toLowerCase()
      : left.cwd === currentCwd;
    const rightCurrent = process.platform === "win32"
      ? right.cwd.toLowerCase() === currentCwd.toLowerCase()
      : right.cwd === currentCwd;
    if (leftCurrent && !rightCurrent) return -1;
    if (rightCurrent && !leftCurrent) return 1;
    if (left.cwd !== right.cwd) {
      const recentOrder = (recency.get(right.cwd) ?? "").localeCompare(recency.get(left.cwd) ?? "");
      if (recentOrder) return recentOrder;
      return left.cwd.localeCompare(right.cwd);
    }
    return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
  });
}

function mergeSessions(existing: PiSession[], updated: PiSession[], currentCwd: string): PiSession[] {
  const sessions = new Map(existing.map((session) => [session.id, session]));
  for (const session of updated) sessions.set(session.id, { ...sessions.get(session.id), ...session });
  return sortSessions([...sessions.values()], currentCwd);
}

export class PiRuntimeRegistry {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly activations = new Map<string, Promise<Runtime>>();
  private readonly listeners = new Set<(event: PiVotEvent) => void>();
  private readonly savedSnapshots = new Map<string, PiVotSnapshot>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly temporaryServices = new Set<PiService>();
  private browsedProject: string;
  private readonly createService: (directory: string) => PiService;
  private readonly discoveryContext: PiDiscoveryContext;
  private selectedSessionId: string | null = null;
  private sessions: PiSession[] = [];
  private starting = 0;
  private closing = false;

  constructor(
    cwd = process.cwd(),
    createService?: (directory: string) => PiService,
    discoveryContext?: PiDiscoveryContext,
  ) {
    this.browsedProject = resolve(cwd);
    this.discoveryContext = capturePiDiscoveryContext(
      discoveryContext?.env,
      discoveryContext?.home,
    );
    this.createService = createService ??
      ((directory) => new PiService(directory, undefined, undefined, this.discoveryContext));
  }

  get state(): string {
    return this.snapshot().state;
  }

  async initialize(): Promise<void> {
    await this.refreshPersistedState();
    const [first] = this.sessions;
    if (first) {
      this.selectedSessionId = first.id;
      await this.hydrateInactiveSession(first);
    } else {
      const runtime = await this.startRuntime(this.browsedProject);
      this.selectedSessionId = runtime.sessionId;
      await this.refreshPersistedState();
    }
    this.emitSnapshot();
  }

  snapshot(): PiVotSnapshot {
    const runtime = this.selectedSessionId ? this.runtimes.get(this.selectedSessionId) : undefined;
    const base = runtime?.service.snapshot() ??
      (this.selectedSessionId ? this.savedSnapshots.get(this.selectedSessionId) : undefined) ??
      emptySnapshot(this.browsedProject);
    const active = new Set([...this.runtimes.entries()]
      .filter(([, runtime]) => runtime.service.state !== "failed")
      .map(([sessionId]) => sessionId));
    return {
      ...base,
      projectDirectory: this.browsedProject,
      activeSessionId: this.selectedSessionId,
      selectedSessionId: this.selectedSessionId,
      sessions: sortSessions(this.sessions.map((session) => ({
        ...session,
        cwd: session.cwd ?? this.sessionCwds.get(session.id) ?? this.browsedProject,
        active: active.has(session.id),
        hasRuntime: this.runtimes.has(session.id),
      })), this.browsedProject),
      transcript: base.transcript.map((item) => ({ ...item })),
      queuedMessages: base.queuedMessages.map((item) => ({ ...item })),
    };
  }

  subscribe(listener: (event: PiVotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refreshPersistedState(): Promise<void> {
    this.sessions = sortSessions(await this.discoverPersistedSessions(), this.browsedProject);
    for (const session of this.sessions) this.sessionCwds.set(session.id, session.cwd);
    const selectedRuntime = this.selectedSessionId
      ? this.runtimes.get(this.selectedSessionId)
      : undefined;
    if (selectedRuntime) {
      await selectedRuntime.service.refreshPersistedState();
      this.savedSnapshots.set(selectedRuntime.sessionId, selectedRuntime.service.snapshot());
    } else if (this.selectedSessionId) {
      const selected = this.sessions.find(({ id }) => id === this.selectedSessionId);
      if (selected) await this.hydrateInactiveSession(selected);
    }
    this.addKnownSessionsIfMissing();
    this.emitSnapshot();
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!this.sessions.some(({ id }) => id === sessionId)) {
      this.sessions = sortSessions(await this.discoverPersistedSessions(), this.browsedProject);
      for (const session of this.sessions) this.sessionCwds.set(session.id, session.cwd);
    }
    const session = this.sessions.find(({ id }) => id === sessionId);
    if (!session) throw new Error("That Pi session is no longer available; refresh the session list.");
    this.selectedSessionId = sessionId;
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      await runtime.service.refreshPersistedState();
      this.savedSnapshots.set(sessionId, runtime.service.snapshot());
    } else {
      await this.hydrateInactiveSession(session);
    }
    this.sessions = sortSessions(await this.discoverPersistedSessions(), this.browsedProject);
    for (const item of this.sessions) this.sessionCwds.set(item.id, item.cwd);
    this.addKnownSessionsIfMissing();
    this.emitSnapshot();
  }

  async sendMessage(
    message: string,
    messageId?: string,
    sessionId?: string,
    images: ImageAttachment[] = [],
  ): Promise<string> {
    const target = sessionId || this.selectedSessionId;
    if (!target) {
      const runtime = await this.startRuntime(this.browsedProject);
      this.selectedSessionId = runtime.sessionId;
      return runtime.service.sendMessage(message, messageId, images);
    }
    const runtime = await this.ensureRuntimeForSession(target);
    if (!sessionId || target === this.selectedSessionId) this.selectedSessionId = runtime.sessionId;
    return runtime.service.sendMessage(message, messageId, images);
  }

  async wakeSession(sessionId: string): Promise<void> {
    const runtime = await this.ensureRuntimeForSession(sessionId);
    this.selectedSessionId = runtime.sessionId;
    this.emitSnapshot();
  }

  async abort(sessionId?: string): Promise<void> {
    await this.requireRuntime(sessionId).service.abort();
  }

  async compact(sessionId?: string): Promise<void> {
    await this.requireRuntime(sessionId).service.compact();
  }

  async getAvailableModels(sessionId: string): Promise<AvailableModelsResult> {
    const known = this.sessions.some((session) => session.id === sessionId) ||
      this.sessionCwds.has(sessionId) || this.savedSnapshots.has(sessionId);
    if (!known) throw new Error("That Pi session is no longer available; refresh the session list.");
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return {
        sessionId,
        hasRuntime: false,
        model: this.savedSnapshots.get(sessionId)?.model ?? null,
        models: [],
        canChange: false,
        message: "Activate this session before changing models.",
      };
    }
    const models = await runtime.service.getAvailableModels();
    const snapshot = runtime.service.snapshot();
    const canChange = runtime.service.canChangeModel;
    return {
      sessionId,
      hasRuntime: true,
      model: snapshot.model,
      models,
      canChange,
      ...(!canChange ? { message: "Model can be changed when the session is idle." } : {}),
    };
  }

  async changeModel(sessionId: string, provider: string, modelId: string): Promise<{
    sessionId: string;
    model: ActiveModel | null;
    context: PiVotSnapshot["context"];
  }> {
    const runtime = this.requireRuntime(sessionId);
    await runtime.service.changeModel(provider, modelId);
    const snapshot = runtime.service.snapshot();
    this.savedSnapshots.set(sessionId, snapshot);
    return { sessionId, model: snapshot.model, context: snapshot.context };
  }

  async releaseRuntime(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error("That session does not have an active Pi runtime.");
    const state = runtime.service.snapshot();
    if (state.state === "running" || state.state === "stopping" || state.isCompacting ||
      state.queuedMessages.length > 0) {
      throw new Error("Stop and wait for this Pi session to settle before closing its runtime.");
    }
    this.savedSnapshots.set(sessionId, state.state === "failed" ? state : {
      ...state,
      state: "idle",
      isCompacting: false,
      queuedMessages: [],
    });
    await runtime.service.stop();
    runtime.unsubscribe();
    this.runtimes.delete(sessionId);
    if (this.selectedSessionId === sessionId) this.selectedSessionId = sessionId;
    this.emitSnapshot();
  }

  async newSession(): Promise<void> {
    let runtime = this.selectedSessionId
      ? this.runtimes.get(this.selectedSessionId)
      : undefined;
    if (runtime?.cwd !== this.browsedProject) runtime = undefined;
    if (!runtime) {
      runtime = this.idleRuntimeForDirectory(this.browsedProject);
      if (!runtime) {
        runtime = await this.startRuntime(this.browsedProject, undefined, true);
        this.selectedSessionId = runtime.sessionId;
        await this.refreshPersistedState();
        return;
      }
    }
    const previous = runtime.sessionId;
    await runtime.service.newSession();
    this.reconcileRuntimeSession(runtime, previous, runtime.service.snapshot().activeSessionId);
    this.selectedSessionId = runtime.sessionId;
    await this.refreshPersistedState();
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const service = this.runtimes.get(sessionId)?.service ??
      await this.serviceForDirectory(this.sessionCwds.get(sessionId) ?? this.browsedProject);
    try {
      await service.renameSession(sessionId, name);
      this.sessions = sortSessions(await this.discoverPersistedSessions(), this.browsedProject);
      for (const session of this.sessions) this.sessionCwds.set(session.id, session.cwd);
      this.addKnownSessionsIfMissing();
      this.emitSnapshot();
    } finally {
      if (!this.isRegisteredService(service)) {
        this.temporaryServices.delete(service);
        await service.stop();
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.runtimes.has(sessionId)) {
      throw new Error("Close this session's runtime before deleting its persisted session.");
    }
    const service = await this.serviceForDirectory(this.sessionCwds.get(sessionId) ?? this.browsedProject);
    try {
      await service.deleteSession(sessionId);
      this.sessions = sortSessions(await this.discoverPersistedSessions(), this.browsedProject);
      if (this.selectedSessionId === sessionId) this.selectedSessionId = null;
      this.savedSnapshots.delete(sessionId);
      this.sessionCwds.delete(sessionId);
      this.addKnownSessionsIfMissing();
      this.emitSnapshot();
    } finally {
      if (!this.isRegisteredService(service)) {
        this.temporaryServices.delete(service);
        await service.stop();
      }
    }
  }

  async changeProjectDirectory(directory: string): Promise<void> {
    const nextDirectory = resolve(directory);
    const info = await stat(nextDirectory).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error("Select an existing project directory.");
    const sessions = await this.discoverPersistedSessions(nextDirectory);
    this.browsedProject = nextDirectory;
    this.sessions = sortSessions(sessions, nextDirectory);
    for (const session of this.sessions) this.sessionCwds.set(session.id, session.cwd);
    this.addKnownSessionsIfMissing();
    this.emitSnapshot();
  }

  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled([...this.activations.values()]);
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled([
      ...runtimes.map((runtime) => runtime.service.stop()),
      ...[...this.temporaryServices].map((service) => service.stop()),
    ]);
    for (const runtime of runtimes) runtime.unsubscribe();
    this.runtimes.clear();
    this.temporaryServices.clear();
  }

  private async activate(sessionId: string, cwd: string): Promise<Runtime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const pending = this.activations.get(sessionId);
    if (pending) return pending;
    const activation = this.startRuntime(cwd, sessionId);
    this.activations.set(sessionId, activation);
    try {
      return await activation;
    } finally {
      if (this.activations.get(sessionId) === activation) this.activations.delete(sessionId);
    }
  }

  private async ensureRuntimeForSession(sessionId: string): Promise<Runtime> {
    let session = this.sessions.find(({ id }) => id === sessionId);
    if (!session) {
      this.sessions = sortSessions(await this.discoverPersistedSessions(), this.browsedProject);
      for (const item of this.sessions) this.sessionCwds.set(item.id, item.cwd);
      session = this.sessions.find(({ id }) => id === sessionId);
    }
    if (!session) throw new Error("That Pi session is no longer available; refresh the session list.");

    let runtime = this.runtimes.get(sessionId);
    if (runtime?.service.state === "failed") {
      await this.releaseRuntime(sessionId);
      runtime = undefined;
    }
    return runtime ?? this.activate(sessionId, session.cwd);
  }

  private async startRuntime(cwd: string, sessionId?: string, createNewSession = false): Promise<Runtime> {
    if (this.closing) throw new Error("Pi-vot is shutting down.");
    if (this.liveRuntimeCount() + this.temporaryServices.size + this.starting >= MAX_ACTIVE_RUNTIMES) {
      throw new Error("Four Pi sessions are already active. Stop or release one before starting another.");
    }
    this.starting++;
    let service: PiService;
    try {
      service = this.createService(cwd);
    } catch (error) {
      this.starting--;
      throw error;
    }
    let runtime: Runtime | undefined;
    const unsubscribe = service.subscribe((event) => {
      if (!runtime) return;
      if (event.type === "session_snapshot") {
        const next = event.snapshot.activeSessionId;
        this.reconcileRuntimeSession(runtime, runtime.sessionId, next);
        this.savedSnapshots.set(runtime.sessionId, event.snapshot);
        this.sessions = mergeSessions(this.sessions, event.snapshot.sessions, this.browsedProject);
        this.sessionCwds.set(runtime.sessionId, runtime.cwd);
        this.addKnownSessionsIfMissing();
        this.emit({
          type: "session_snapshot",
          snapshot: {
            ...event.snapshot,
            projectDirectory: this.browsedProject,
            activeSessionId: runtime.sessionId,
            selectedSessionId: this.selectedSessionId,
            sessions: sortSessions(this.sessions.map((session) => ({
              ...session,
              cwd: session.cwd ?? this.sessionCwds.get(session.id) ?? this.browsedProject,
              active: this.runtimes.get(session.id)?.service.state !== "failed" && this.runtimes.has(session.id),
              hasRuntime: this.runtimes.has(session.id),
            })), this.browsedProject),
          },
          sessionId: runtime.sessionId,
        });
      } else {
        this.savedSnapshots.set(runtime.sessionId, service.snapshot());
        this.emit({ ...event, sessionId: runtime.sessionId });
        if (event.type === "state" && event.state === "failed") this.emitSnapshot();
      }
    });
    try {
      await service.initialize();
      if (createNewSession) await service.newSession();
      const initialId = service.snapshot().activeSessionId;
      if (!initialId) throw new Error("Pi did not provide a persisted session ID.");
      if (sessionId && sessionId !== initialId) await service.switchSession(sessionId);
      const currentId = service.snapshot().activeSessionId ?? initialId;
      runtime = { service, cwd, sessionId: currentId, unsubscribe };
      this.runtimes.set(currentId, runtime);
      this.sessionCwds.set(currentId, cwd);
      this.savedSnapshots.set(currentId, service.snapshot());
      this.sessions = mergeSessions(
        await this.discoverPersistedSessions(),
        service.snapshot().sessions,
        this.browsedProject,
      );
      this.addKnownSessionsIfMissing();
      this.emitSnapshot();
      return runtime;
    } catch (error) {
      unsubscribe();
      await service.stop();
      throw error;
    } finally {
      this.starting--;
    }
  }

  private async serviceForDirectory(cwd: string): Promise<PiService> {
    const idle = this.idleRuntimeForDirectory(cwd);
    if (idle) return idle.service;
    if (this.liveRuntimeCount() + this.temporaryServices.size + this.starting >= MAX_ACTIVE_RUNTIMES) {
      throw new Error("Four Pi sessions are already active. Stop or release one before retrying this session operation.");
    }
    const service = this.createService(cwd);
    this.temporaryServices.add(service);
    try {
      await service.initialize();
      return service;
    } catch (error) {
      this.temporaryServices.delete(service);
      await service.stop();
      throw error;
    }
  }

  private idleRuntimeForDirectory(cwd: string): Runtime | undefined {
    return [...this.runtimes.values()].find((runtime) => {
      if (runtime.cwd !== cwd) return false;
      const state = runtime.service.snapshot();
      return state.state === "idle" && !state.isCompacting && state.queuedMessages.length === 0;
    });
  }

  private isRegisteredService(service: PiService): boolean {
    return [...this.runtimes.values()].some((runtime) => runtime.service === service);
  }

  private liveRuntimeCount(): number {
    return [...this.runtimes.values()].filter((runtime) => runtime.service.state !== "failed").length;
  }

  private requireRuntime(sessionId?: string): Runtime {
    const target = sessionId || this.selectedSessionId;
    const runtime = target ? this.runtimes.get(target) : undefined;
    if (!runtime) throw new Error("That session does not have an active Pi runtime.");
    return runtime;
  }

  private reconcileRuntimeSession(runtime: Runtime, previousId: string, nextId: string | null): void {
    if (!nextId || previousId === nextId) return;
    if (this.runtimes.get(previousId) === runtime) this.runtimes.delete(previousId);
    runtime.sessionId = nextId;
    this.runtimes.set(nextId, runtime);
    this.sessionCwds.set(nextId, runtime.cwd);
    if (this.selectedSessionId === previousId) this.selectedSessionId = nextId;
  }

  private discoverPersistedSessions(projectDirectory = this.browsedProject): Promise<PiSession[]> {
    const runtimeSessions = [...this.runtimes.values()].flatMap((runtime) => runtime.service.snapshot().sessions);
    const knownSessions = [...this.sessions, ...runtimeSessions];
    const knownCwds = new Set([
      projectDirectory,
      ...this.sessionCwds.values(),
      ...[...this.runtimes.values()].map((runtime) => runtime.cwd),
      ...knownSessions.map((session) => session.cwd),
    ]);
    const sessionDirectories = new Set(knownSessions
      .filter((session) => session.id.endsWith(".jsonl"))
      .map((session) => dirname(session.id)));
    return discoverPiSessions(
      projectDirectory,
      this.discoveryContext.env,
      this.discoveryContext.home,
      [...sessionDirectories],
      [...knownCwds],
    );
  }

  private addKnownSessionsIfMissing(): void {
    for (const runtime of this.runtimes.values()) {
      this.sessions = mergeSessions(this.sessions, runtime.service.snapshot().sessions, this.browsedProject);
    }
    for (const [sessionId, runtime] of this.runtimes) {
      if (this.sessions.some((session) => session.id === sessionId)) continue;
      const current = runtime.service.snapshot();
      const saved = this.savedSnapshots.get(sessionId);
      this.sessions.push({
        id: sessionId,
        cwd: runtime.cwd,
        name: current.activeSessionId === sessionId
          ? current.activeSessionName
          : saved?.activeSessionName ?? null,
        preview: "Session outside the browsed project",
        updatedAt: new Date().toISOString(),
      });
    }
    if (this.selectedSessionId && !this.sessions.some((session) => session.id === this.selectedSessionId)) {
      const saved = this.savedSnapshots.get(this.selectedSessionId);
      this.sessions.push({
        id: this.selectedSessionId,
        cwd: this.sessionCwds.get(this.selectedSessionId) ?? this.browsedProject,
        name: saved?.activeSessionName ?? null,
        preview: "Session outside the browsed project",
        updatedAt: new Date().toISOString(),
      });
    }
    this.sessions = sortSessions(this.sessions, this.browsedProject);
  }

  private async hydrateInactiveSession(session: PiSession): Promise<void> {
    if (this.runtimes.has(session.id)) return;
    try {
      const hydrated = await hydratePiSession(session);
      this.sessionCwds.set(session.id, hydrated.session.cwd);
      this.sessions = this.sessions.map((item) =>
        item.id === session.id ? { ...hydrated.session, model: hydrated.model } : item,
      );
      this.savedSnapshots.set(session.id, {
        ...emptySnapshot(hydrated.session.cwd),
        activeSessionId: session.id,
        activeSessionName: hydrated.session.name,
        model: hydrated.model,
        sessions: this.sessions.map((item) => ({ ...item })),
        transcript: hydrated.transcript,
      });
    } catch {
      if (!this.savedSnapshots.has(session.id)) {
        this.savedSnapshots.set(session.id, {
          ...emptySnapshot(session.cwd),
          activeSessionId: session.id,
          activeSessionName: session.name,
          model: session.model ?? null,
        });
      }
    }
  }

  private emitSnapshot(): void {
    this.emit({ type: "session_snapshot", snapshot: this.snapshot() });
  }

  private emit(event: PiVotEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Pi-vot event listener failed:", error);
      }
    }
  }
}
