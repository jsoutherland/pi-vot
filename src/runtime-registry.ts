import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readBigPiSummary, type BigPiSummary } from "./big-pi.ts";
import { readBillionContextPiSummary, type BillionContextPiSummary } from "./billion-context-pi.ts";
import {
  PiService,
  capturePiDiscoveryContext,
  deletePiSessionFiles,
  discoverPiSessions,
  hydratePiSession,
  type ActiveModel,
  type AvailableModelsResult,
  type PiDiscoveryContext,
  type PromptTemplateCommandsResult,
  type PiVotEvent,
  type PiVotSnapshot,
  type PiSession,
  type TranscriptItem,
} from "./pi-service.ts";
import type { ImageAttachment } from "./request.ts";

export const MAX_ACTIVE_RUNTIMES = 4;
export const HISTORY_PAGE_SIZE = 100;
const HISTORY_PAGE_BYTE_LIMIT = 1_048_576;
const HISTORY_CACHE_BYTE_LIMIT = 64 * 1_048_576;
const HISTORY_CACHE_ENTRY_LIMIT = 8;

interface CachedHistory {
  items: TranscriptItem[];
  bytes: number;
  revision: string;
  fileFingerprint: string | null;
}

export interface TranscriptHistoryPage {
  sessionId: string;
  historyRevision: string;
  items: TranscriptItem[];
  hasOlder: boolean;
  beforeId?: string;
}

export class DeferredSessionSendError extends Error {
  readonly sessionId: string;

  constructor(message: string, sessionId: string) {
    super(message);
    this.name = "DeferredSessionSendError";
    this.sessionId = sessionId;
  }
}

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
  historyRevision: "empty",
  bigPi: null,
  billionContextPi: null,
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

function latestHistoryPage(items: TranscriptItem[]): { start: number; items: TranscriptItem[] } {
  let start = items.length;
  let count = 0;
  let bytes = 0;
  while (start > 0 && count < HISTORY_PAGE_SIZE) {
    const itemBytes = Buffer.byteLength(JSON.stringify(items[start - 1]));
    if (count > 0 && bytes + itemBytes > HISTORY_PAGE_BYTE_LIMIT) break;
    bytes += itemBytes;
    count++;
    start--;
  }
  return { start, items: items.slice(start) };
}

async function historyFileFingerprint(sessionId: string): Promise<string> {
  const fingerprint = async (path: string): Promise<string> => {
    try {
      const file = await stat(path, { bigint: true });
      return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
    } catch {
      return "missing";
    }
  }
  return `transcript=${await fingerprint(sessionId)};metadata=${await fingerprint(`${sessionId}.pi-vot.jsonl`)}`;
}

function transcriptSignature(items: TranscriptItem[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

type HistoryHydration = Awaited<ReturnType<typeof hydratePiSession>>;
type HistoryFingerprint = (sessionId: string) => Promise<string>;
type HistoryReader = (session: PiSession) => Promise<HistoryHydration>;
type StableHistoryLoader = typeof hydrateStablePiSession;

export async function hydrateStablePiSession(
  session: PiSession,
  read: HistoryReader = hydratePiSession,
  fingerprint: HistoryFingerprint = historyFileFingerprint,
): Promise<{ hydrated: HistoryHydration; fingerprint: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fingerprint(session.id);
    const hydrated = await read(session);
    const after = await fingerprint(session.id);
    if (before === after) return { hydrated, fingerprint: after };
  }
  throw new Error("The Pi transcript kept changing while its history was being read.");
}

export class PiRuntimeRegistry {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly activations = new Map<string, Promise<Runtime>>();
  private readonly runtimeRefreshes = new Map<Runtime, Promise<void>>();
  private readonly listeners = new Set<(event: PiVotEvent) => void>();
  private readonly savedSnapshots = new Map<string, PiVotSnapshot>();
  private readonly historyCache = new Map<string, CachedHistory>();
  private readonly historyRevisions = new Map<string, string>();
  private readonly historySignatures = new Map<string, string>();
  private historyCacheBytes = 0;
  private readonly bigPiBySession = new Map<string, BigPiSummary | null>();
  private readonly billionContextPiBySession = new Map<string, BillionContextPiSummary | null>();
  private readonly bigPiRefreshes = new Map<string, {
    promise: Promise<void>;
    refreshAgain: boolean;
    publish: boolean;
  }>();
  private readonly bigPiGenerations = new Map<string, number>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly historyCacheByteLimit: number;
  private readonly deletingSessionIds = new Set<string>();
  private readonly deletedSessionIds = new Set<string>();
  private readonly temporaryServices = new Set<PiService>();
  private readonly pendingSessionIds = new Map<string, string>();
  private readonly pendingSessionStarts = new Map<string, Promise<Runtime>>();
  private readonly projectModels = new Map<string, ActiveModel>();
  private previousProjectModel: ActiveModel | null = null;
  private browsedProject: string;
  private readonly createService: (directory: string, initialSessionId?: string) => PiService;
  private readonly discoveryContext: PiDiscoveryContext;
  private readonly hydrateHistory: StableHistoryLoader;
  private readonly readBigPi: typeof readBigPiSummary;
  private readonly readBillionContextPi: typeof readBillionContextPiSummary;
  private selectedSessionId: string | null = null;
  private navigationVersion = 0;
  private sessions: PiSession[] = [];
  private starting = 0;
  private closing = false;

  constructor(
    cwd = process.cwd(),
    createService?: (directory: string, initialSessionId?: string) => PiService,
    discoveryContext?: PiDiscoveryContext,
    historyCacheByteLimit = HISTORY_CACHE_BYTE_LIMIT,
    hydrateHistory: StableHistoryLoader = hydrateStablePiSession,
    readBigPi: typeof readBigPiSummary = readBigPiSummary,
    readBillionContextPi: typeof readBillionContextPiSummary = readBillionContextPiSummary,
  ) {
    this.browsedProject = resolve(cwd);
    this.historyCacheByteLimit = historyCacheByteLimit;
    this.hydrateHistory = hydrateHistory;
    this.readBigPi = readBigPi;
    this.readBillionContextPi = readBillionContextPi;
    this.discoveryContext = capturePiDiscoveryContext(
      discoveryContext?.env,
      discoveryContext?.home,
    );
    this.createService = createService ??
      ((directory, initialSessionId) => new PiService(directory, undefined, undefined, this.discoveryContext, initialSessionId));
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
    const base = runtime?.service.snapshot(HISTORY_PAGE_SIZE) ??
      (this.selectedSessionId ? this.savedSnapshots.get(this.selectedSessionId) : undefined) ??
      emptySnapshot(this.browsedProject);
    if (!this.selectedSessionId) {
      base.model = this.projectModels.get(this.browsedProject) ?? this.previousProjectModel;
    }
    const browserBase = this.snapshotForBrowser(base);
    const bigPi = this.selectedSessionId ? this.bigPiBySession.get(this.selectedSessionId) ?? null : null;
    const billionContextPi = this.selectedSessionId
      ? this.billionContextPiBySession.get(this.selectedSessionId) ?? null
      : null;
    const active = new Set([...this.runtimes.entries()]
      .filter(([, runtime]) => runtime.service.state !== "failed")
      .map(([sessionId]) => sessionId));
    return {
      ...browserBase,
      historyRevision: browserBase.historyRevision ?? this.historyRevisions.get(this.selectedSessionId ?? "") ?? "empty",
      projectDirectory: this.browsedProject,
      activeSessionId: this.selectedSessionId,
      selectedSessionId: this.selectedSessionId,
      sessions: sortSessions(this.sessions.map((session) => ({
        ...session,
        cwd: session.cwd ?? this.sessionCwds.get(session.id) ?? this.browsedProject,
        active: active.has(session.id),
        hasRuntime: this.runtimes.has(session.id),
      })), this.browsedProject),
      transcript: browserBase.transcript.map((item) => ({ ...item })),
      queuedMessages: browserBase.queuedMessages.map((item) => ({ ...item })),
      bigPi,
      billionContextPi,
    };
  }

  async getOlderTranscriptPage(
    sessionId: string,
    beforeId: string,
    expectedRevision: string,
  ): Promise<TranscriptHistoryPage> {
    if (!sessionId || sessionId !== this.selectedSessionId) {
      throw new Error("The selected session changed before older history could be loaded.");
    }
    if (this.deletingSessionIds.has(sessionId)) throw new Error("This Pi session is being deleted.");

    const runtime = this.runtimes.get(sessionId);
    let items: readonly TranscriptItem[];
    let historyRevision: string;
    if (runtime) {
      const runtimeSnapshot = runtime.service.snapshot();
      historyRevision = runtimeSnapshot.historyRevision ??
        this.historyRevisions.get(sessionId) ?? "empty";
      if (historyRevision !== expectedRevision) {
        this.emitSnapshot();
        throw Object.assign(new Error("The session history changed; its latest page has been refreshed."), { historyRevision });
      }
      items = runtimeSnapshot.transcript;
    } else {
      let cached = this.historyCache.get(sessionId);
      const fileFingerprint = await historyFileFingerprint(sessionId);
      if (cached && cached.fileFingerprint !== fileFingerprint) {
        this.removeHistoryCache(sessionId);
        cached = undefined;
      }
      if (cached) {
        this.historyCache.delete(sessionId);
        this.historyCache.set(sessionId, cached);
        items = cached.items;
        historyRevision = cached.revision;
      } else {
        const session = this.sessions.find(({ id }) => id === sessionId);
        if (!session) throw new Error("That Pi session is no longer available.");
        const hydratedItems = await this.hydrateInactiveSession(session);
        if (sessionId !== this.selectedSessionId) {
          throw new Error("The selected session changed before older history could be loaded.");
        }
        const refreshed = this.savedSnapshots.get(sessionId);
        historyRevision = refreshed?.historyRevision ?? "";
        if (!hydratedItems) {
          this.emitSnapshot();
          throw new Error("Earlier history could not be read. The last available conversation is unchanged; try again.");
        }
        items = this.historyCache.get(sessionId)?.items ?? hydratedItems;
      }
    }

    if (!historyRevision || historyRevision !== expectedRevision) {
      this.emitSnapshot();
      throw Object.assign(new Error("The session history changed; its latest page has been refreshed."), {
        historyRevision,
      });
    }
    const cursorIndex = items.findIndex((item) => item.id === beforeId);
    if (cursorIndex < 0) {
      this.emitSnapshot();
      throw Object.assign(new Error("The history cursor is no longer valid; the latest page has been refreshed."), {
        historyRevision,
      });
    }
    let start = cursorIndex;
    let bytes = 0;
    while (start > 0 && cursorIndex - start < HISTORY_PAGE_SIZE) {
      const itemBytes = Buffer.byteLength(JSON.stringify(items[start - 1]));
      if (start < cursorIndex && bytes + itemBytes > HISTORY_PAGE_BYTE_LIMIT) break;
      bytes += itemBytes;
      start--;
    }
    const page = items.slice(start, cursorIndex).map((item) => ({ ...item }));
    const hasOlder = start > 0;
    return {
      sessionId,
      historyRevision,
      items: page,
      hasOlder,
      ...(hasOlder && page[0] ? { beforeId: page[0].id } : {}),
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
      await this.refreshBigPiSummary(selectedRuntime.sessionId, false);
    } else if (this.selectedSessionId) {
      const selected = this.sessions.find(({ id }) => id === this.selectedSessionId);
      if (selected) await this.hydrateInactiveSession(selected);
    }
    this.addKnownSessionsIfMissing();
    this.emitSnapshot();
  }

  async switchSession(sessionId: string): Promise<void> {
    if (this.deletingSessionIds.has(sessionId)) {
      throw new Error("This Pi session is being deleted.");
    }
    if (!this.sessions.some(({ id }) => id === sessionId)) {
      this.sessions = sortSessions(await this.discoverPersistedSessions(), this.browsedProject);
      for (const session of this.sessions) this.sessionCwds.set(session.id, session.cwd);
    }
    const session = this.sessions.find(({ id }) => id === sessionId);
    if (!session) throw new Error("That Pi session is no longer available; refresh the session list.");
    this.navigationVersion++;
    this.selectedSessionId = sessionId;
    this.addKnownSessionsIfMissing();
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      this.savedSnapshots.set(sessionId, runtime.service.snapshot());
      this.emitSnapshot();
      if (!runtime.service.canChangeModel) void this.refreshBigPiSummary(sessionId);
      if (runtime.service.canChangeModel) {
        void this.refreshRuntimeInBackground(sessionId, runtime);
      }
    } else {
      if (!this.savedSnapshots.has(sessionId)) {
        this.savedSnapshots.set(sessionId, {
          ...emptySnapshot(session.cwd),
          activeSessionId: sessionId,
          activeSessionName: session.name,
          model: session.model ?? null,
        });
      }
      this.emitSnapshot();
      void this.hydrateSelectedSession(sessionId, session);
    }
  }

  async sendMessage(
    message: string,
    messageId?: string,
    sessionId?: string,
    images: ImageAttachment[] = [],
    mode?: "send" | "queue" | "steer",
  ): Promise<string> {
    const target = sessionId || this.selectedSessionId;
    if (!target) {
      const runtime = await this.startRuntime(this.browsedProject);
      this.selectedSessionId = runtime.sessionId;
      return runtime.service.sendMessage(message, messageId, images, mode);
    }
    const runtime = await this.ensureRuntimeForSession(target);
    if (!sessionId || target === this.selectedSessionId) this.selectedSessionId = runtime.sessionId;
    if (this.selectedSessionId === runtime.sessionId) void this.refreshBigPiSummary(runtime.sessionId);
    return runtime.service.sendMessage(message, messageId, images, mode);
  }

  async cancelQueuedMessage(messageId: string, sessionId?: string): Promise<boolean> {
    return this.requireRuntime(sessionId).service.cancelQueuedMessage(messageId);
  }

  async clearQueuedMessages(sessionId?: string): Promise<string[]> {
    return this.requireRuntime(sessionId).service.clearQueuedMessages();
  }

  async sendNewSessionMessage(
    message: string,
    messageId: string | undefined,
    sessionId: string | undefined,
    images: ImageAttachment[],
    mode: "send" | "queue" | "steer" | undefined,
    directory: string,
  ): Promise<{ disposition: string; sessionId: string }> {
    const cwd = resolve(directory);
    const navigationVersion = this.navigationVersion;
    const selectOnCompletion = this.browsedProject === cwd && this.selectedSessionId === null;
    const pendingKey = `${navigationVersion}\0${cwd}`;
    let runtime: Runtime;
    if (sessionId) {
      runtime = await this.ensureRuntimeForSession(sessionId);
      if (runtime.cwd !== cwd) {
        throw new Error("The pending session does not belong to the selected project.");
      }
    } else {
      let pendingId = this.pendingSessionIds.get(pendingKey);
      if (pendingId) {
        runtime = await this.ensureRuntimeForSession(pendingId);
      } else {
        let start = this.pendingSessionStarts.get(pendingKey);
        if (!start) {
          start = this.startRuntime(cwd, undefined, true);
          this.pendingSessionStarts.set(pendingKey, start);
        }
        try {
          runtime = await start;
          this.pendingSessionIds.set(pendingKey, runtime.sessionId);
        } finally {
          if (this.pendingSessionStarts.get(pendingKey) === start) {
            this.pendingSessionStarts.delete(pendingKey);
          }
        }
      }
    }

    try {
      const disposition = await runtime.service.sendMessage(message, messageId, images, mode);
      if (selectOnCompletion && navigationVersion === this.navigationVersion &&
        this.browsedProject === cwd && this.selectedSessionId === null) {
        this.selectedSessionId = runtime.sessionId;
        this.emitSnapshot();
      }
      return { disposition, sessionId: runtime.sessionId };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Pi could not process the message.";
      throw new DeferredSessionSendError(messageText, runtime.sessionId);
    }
  }

  async wakeSession(sessionId: string): Promise<void> {
    const runtime = await this.ensureRuntimeForSession(sessionId);
    this.navigationVersion++;
    this.selectedSessionId = runtime.sessionId;
    void this.refreshBigPiSummary(runtime.sessionId);
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

  async getPromptTemplates(sessionId: string): Promise<PromptTemplateCommandsResult> {
    const known = this.sessions.some((session) => session.id === sessionId) ||
      this.sessionCwds.has(sessionId) || this.savedSnapshots.has(sessionId);
    if (!known) throw new Error("That Pi session is no longer available; refresh the session list.");
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return {
        sessionId,
        hasRuntime: false,
        commands: [],
        message: "Activate this session before loading its prompt templates.",
      };
    }
    return {
      sessionId,
      hasRuntime: true,
      commands: await runtime.service.getPromptTemplates(),
    };
  }

  async getProjectAvailableModels(directory: string): Promise<AvailableModelsResult & { projectDirectory: string }> {
    const cwd = resolve(directory);
    if (cwd !== this.browsedProject) throw new Error("The selected project directory has changed.");
    const runtime = [...this.runtimes.values()].find((candidate) => candidate.cwd === cwd) ??
      [...this.runtimes.values()].at(-1);
    if (!runtime) {
      return { projectDirectory: cwd, sessionId: "", hasRuntime: false,
        model: this.projectModels.get(cwd) ?? this.previousProjectModel, models: [], canChange: false,
        message: "Start a Pi session before choosing a model." };
    }
    const models = await runtime.service.getAvailableModels();
    const current = runtime.service.snapshot().model;
    const preferred = this.projectModels.get(cwd) ?? current ?? this.previousProjectModel;
    const model = models.find((item) => item.provider === preferred?.provider && item.id === preferred?.id) ?? models[0] ?? null;
    return { projectDirectory: cwd, sessionId: "", hasRuntime: true, model, models,
      canChange: true };
  }

  async changeProjectModel(directory: string, provider: string, modelId: string): Promise<{ projectDirectory: string; model: ActiveModel }> {
    const result = await this.getProjectAvailableModels(directory);
    const model = result.models.find((item) => item.provider === provider && item.id === modelId);
    if (!model) throw new Error("That model is no longer available. Refresh the model list.");
    this.projectModels.set(result.projectDirectory, model);
    this.previousProjectModel = model;
    this.emitSnapshot();
    return { projectDirectory: result.projectDirectory, model };
  }

  async changeModel(sessionId: string, provider: string, modelId: string): Promise<{
    sessionId: string;
    model: ActiveModel | null;
    context: PiVotSnapshot["context"];
  }> {
    const runtime = this.requireRuntime(sessionId);
    await runtime.service.changeModel(provider, modelId);
    const snapshot = runtime.service.snapshot();
    if (snapshot.model) {
      this.previousProjectModel = snapshot.model;
    }
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
    this.savedSnapshots.set(sessionId, this.snapshotForBrowser(state.state === "failed" ? state : {
      ...state,
      state: "idle",
      isCompacting: false,
      queuedMessages: [],
    }));
    await runtime.service.stop();
    const fileFingerprint = await historyFileFingerprint(sessionId);
    const historyRevision = state.historyRevision ?? this.historyRevisions.get(sessionId) ?? randomUUID();
    this.historyRevisions.set(sessionId, historyRevision);
    this.historySignatures.set(sessionId, transcriptSignature(state.transcript));
    this.cacheHistory(sessionId, state.transcript, historyRevision, fileFingerprint);
    runtime.unsubscribe();
    this.runtimes.delete(sessionId);
    if (this.selectedSessionId === sessionId) this.selectedSessionId = sessionId;
    this.emitSnapshot();
  }

  async newSession(): Promise<void> {
    const selectedDirectory = this.selectedSessionId
      ? this.sessionCwds.get(this.selectedSessionId) ??
        this.sessions.find(({ id }) => id === this.selectedSessionId)?.cwd
      : undefined;
    const targetDirectory = selectedDirectory ?? this.browsedProject;
    let runtime = this.selectedSessionId
      ? this.runtimes.get(this.selectedSessionId)
      : undefined;
    if (runtime?.cwd !== targetDirectory) runtime = undefined;
    // If any session in this project is busy, create the new session in a
    // separate RPC process with its own session ID. This also covers the case
    // where the selected session is idle but another session in the project
    // is still running (Pi 0.99.2 can otherwise reject `new_session` on an
    // existing process while that project has active work).
    const projectHasBusyRuntime = [...this.runtimes.values()].some((candidate) =>
      candidate.cwd === targetDirectory && !this.isRuntimeIdleForNewSession(candidate));
    // A fresh Pi process starts with Pi's default model. When New Session is
    // launched from an awake session, carry that session's model into it.
    const sourceModel = (runtime?.cwd === targetDirectory ? runtime.service.snapshot().model : null) ??
      [...this.runtimes.values()].find((candidate) => candidate.cwd === targetDirectory)?.service.snapshot().model ??
      null;
    if (projectHasBusyRuntime) runtime = undefined;
    if (runtime && !this.isRuntimeIdleForNewSession(runtime)) runtime = undefined;
    if (!runtime) {
      runtime = projectHasBusyRuntime ? undefined : this.idleRuntimeForDirectory(targetDirectory);
      if (!runtime) {
        runtime = await this.startRuntime(targetDirectory, undefined, true, sourceModel);
        this.selectedSessionId = runtime.sessionId;
        await this.refreshPersistedState();
        return;
      }
    }
    const previous = runtime.sessionId;
    try {
      await runtime.service.newSession();
    } catch (error) {
      const state = runtime.service.snapshot();
      if (state.state !== "idle" || state.isCompacting || state.queuedMessages.length > 0) {
        runtime = await this.startRuntime(targetDirectory, undefined, true, sourceModel);
        this.selectedSessionId = runtime.sessionId;
        await this.refreshPersistedState();
        return;
      }
      throw error;
    }
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
    if (this.deletingSessionIds.has(sessionId)) {
      throw new Error("This session is already being deleted.");
    }
    const session = this.sessions.find(({ id }) => id === sessionId);
    if (!session) throw new Error("That Pi session is no longer available; refresh the session list.");
    this.deletingSessionIds.add(sessionId);
    this.bigPiGenerations.set(sessionId, (this.bigPiGenerations.get(sessionId) ?? 0) + 1);
    this.bigPiBySession.delete(sessionId);
    this.billionContextPiBySession.delete(sessionId);
    const runtime = this.runtimes.get(sessionId);
    try {
      if (runtime) {
        if (!runtime.service.snapshot().sessions.some(({ id }) => id === session.id)) {
          throw new Error("That Pi session is no longer available; refresh the session list.");
        }
        try {
          await runtime.service.deleteSession(session.id);
        } finally {
          const state = runtime.service.snapshot();
          this.savedSnapshots.set(sessionId, state.state === "failed" ? state : {
            ...state,
            state: "idle",
            isCompacting: false,
            queuedMessages: [],
          });
          runtime.unsubscribe();
          this.runtimes.delete(sessionId);
          this.emitSnapshot();
        }
      } else {
        await deletePiSessionFiles(session.id);
      }
      this.deletedSessionIds.add(session.id);
      this.sessions = sortSessions(
        (await this.discoverPersistedSessions()).filter(({ id }) => id !== session.id),
        this.browsedProject,
      );
      if (this.selectedSessionId === session.id) this.selectedSessionId = null;
      this.savedSnapshots.delete(sessionId);
      this.removeHistoryCache(sessionId);
      this.historyRevisions.delete(sessionId);
      this.historySignatures.delete(sessionId);
      this.bigPiBySession.delete(sessionId);
      this.billionContextPiBySession.delete(sessionId);
      this.bigPiGenerations.delete(sessionId);
      this.sessionCwds.delete(sessionId);
      this.addKnownSessionsIfMissing();
      this.emitSnapshot();
    } finally {
      this.deletingSessionIds.delete(sessionId);
    }
  }

  async changeProjectDirectory(directory: string): Promise<void> {
    const nextDirectory = resolve(directory);
    const info = await stat(nextDirectory).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error("Select an existing project directory.");
    const sessions = await this.discoverPersistedSessions(nextDirectory);
    if (this.selectedSessionId) {
      const current = this.runtimes.get(this.selectedSessionId)?.service.snapshot().model ??
        this.savedSnapshots.get(this.selectedSessionId)?.model;
      if (current) this.previousProjectModel = current;
    }
    this.navigationVersion++;
    this.browsedProject = nextDirectory;
    this.selectedSessionId = null;
    this.sessions = sortSessions(sessions, nextDirectory);
    for (const session of this.sessions) this.sessionCwds.set(session.id, session.cwd);
    this.addKnownSessionsIfMissing();
    this.emitSnapshot();
    if (this.selectedSessionId) void this.refreshBigPiSummary(this.selectedSessionId);
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
    this.removeHistoryCache(sessionId);
    const activation = this.startRuntime(cwd, sessionId);
    this.activations.set(sessionId, activation);
    try {
      return await activation;
    } finally {
      if (this.activations.get(sessionId) === activation) this.activations.delete(sessionId);
    }
  }

  private async ensureRuntimeForSession(sessionId: string): Promise<Runtime> {
    if (this.deletingSessionIds.has(sessionId)) {
      throw new Error("This Pi session is being deleted.");
    }
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

  private refreshRuntimeInBackground(sessionId: string, runtime: Runtime): void {
    if (this.runtimeRefreshes.has(runtime)) return;
    const refresh = Promise.resolve()
      .then(() => runtime.service.refreshPersistedState())
      .then(() => {
        if (this.runtimes.get(sessionId) !== runtime) return;
        this.savedSnapshots.set(sessionId, runtime.service.snapshot());
        return this.refreshBigPiSummary(sessionId, false);
      })
      .then(() => {
        if (this.selectedSessionId === sessionId) this.emitSnapshot();
      })
      .catch(() => {
        // A refresh is advisory; selecting a live session must not depend on Pi responsiveness.
      })
      .finally(() => {
        if (this.runtimeRefreshes.get(runtime) === refresh) this.runtimeRefreshes.delete(runtime);
      });
    this.runtimeRefreshes.set(runtime, refresh);
  }

  private async hydrateSelectedSession(sessionId: string, session: PiSession): Promise<void> {
    await this.hydrateInactiveSession(session);
    if (this.selectedSessionId === sessionId) this.emitSnapshot();
  }

  private async startRuntime(
    cwd: string,
    sessionId?: string,
    createNewSession = false,
    preferredSessionModel?: ActiveModel | null,
  ): Promise<Runtime> {
    if (this.closing) throw new Error("Pi-vot is shutting down.");
    if (this.liveRuntimeCount() + this.temporaryServices.size + this.starting >= MAX_ACTIVE_RUNTIMES) {
      throw new Error("Four Pi sessions are already active. Stop or release one before starting another.");
    }
    this.starting++;
    let service: PiService;
    try {
      service = this.createService(cwd, createNewSession ? randomUUID() : undefined);
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
        if (typeof event.snapshot.historyRevision === "string")
          this.historyRevisions.set(runtime.sessionId, event.snapshot.historyRevision);
        this.removeHistoryCache(runtime.sessionId);
        this.savedSnapshots.set(runtime.sessionId, event.snapshot);
        this.sessions = mergeSessions(this.sessions, event.snapshot.sessions, this.browsedProject);
        this.sessionCwds.set(runtime.sessionId, runtime.cwd);
        this.addKnownSessionsIfMissing();
        const browserSnapshot = this.snapshotForBrowser({
          ...event.snapshot,
          projectDirectory: this.browsedProject,
          activeSessionId: runtime.sessionId,
          selectedSessionId: this.selectedSessionId,
        });
        this.emit({
          type: "session_snapshot",
          snapshot: {
            ...browserSnapshot,
            sessions: sortSessions(this.sessions.map((session) => ({
              ...session,
              cwd: session.cwd ?? this.sessionCwds.get(session.id) ?? this.browsedProject,
              active: this.runtimes.get(session.id)?.service.state !== "failed" && this.runtimes.has(session.id),
              hasRuntime: this.runtimes.has(session.id),
            })), this.browsedProject),
            bigPi: this.selectedSessionId ? this.bigPiBySession.get(this.selectedSessionId) ?? null : null,
            billionContextPi: this.selectedSessionId
              ? this.billionContextPiBySession.get(this.selectedSessionId) ?? null
              : null,
          },
          sessionId: runtime.sessionId,
        });
        if (this.selectedSessionId === runtime.sessionId) {
          void this.refreshBigPiSummary(runtime.sessionId);
        }
      } else {
        this.emit({ ...event, sessionId: runtime.sessionId });
        // Big Pi and Billion Context Pi persist their sidecar state before
        // their compression tool returns. Refresh both summaries here because
        // either tool can compress without a Pi-native compaction event.
        if (event.type === "tool_end" &&
          (event.toolName === "big_pi_compress" || event.toolName === "compress") && !event.isError) {
          void this.refreshBigPiSummary(runtime.sessionId);
        }
        if (event.type === "compaction_end" && this.selectedSessionId === runtime.sessionId) {
          void this.refreshBigPiSummary(runtime.sessionId);
        }
        if (event.type === "state" && event.state === "failed") this.emitSnapshot();
      }
    });
    try {
      await service.initialize();
      const preferredModel = preferredSessionModel ?? this.projectModels.get(cwd);
      if (preferredModel) {
        const available = await service.getAvailableModels();
        if (available.some(({ provider, id }) => provider === preferredModel.provider && id === preferredModel.id) &&
          (service.snapshot().model?.provider !== preferredModel.provider || service.snapshot().model?.id !== preferredModel.id)) {
          await service.changeModel(preferredModel.provider, preferredModel.id);
        }
      }
      const initialId = service.snapshot().activeSessionId;
      if (!initialId) throw new Error("Pi did not provide a persisted session ID.");
      if (sessionId && sessionId !== initialId) await service.switchSession(sessionId);
      const currentId = service.snapshot().activeSessionId ?? initialId;
      runtime = { service, cwd, sessionId: currentId, unsubscribe };
      this.runtimes.set(currentId, runtime);
      this.historyRevisions.set(currentId, service.snapshot().historyRevision ?? randomUUID());
      this.removeHistoryCache(currentId);
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

  private isRuntimeIdleForNewSession(runtime: Runtime): boolean {
    const state = runtime.service.snapshot();
    return state.state === "idle" && !state.isCompacting && state.queuedMessages.length === 0;
  }

  private isRegisteredService(service: PiService): boolean {
    return [...this.runtimes.values()].some((runtime) => runtime.service === service);
  }

  private liveRuntimeCount(): number {
    return [...this.runtimes.values()].filter((runtime) => runtime.service.state !== "failed").length;
  }

  private requireRuntime(sessionId?: string): Runtime {
    const target = sessionId || this.selectedSessionId;
    if (target && this.deletingSessionIds.has(target)) {
      throw new Error("This Pi session is being deleted.");
    }
    const runtime = target ? this.runtimes.get(target) : undefined;
    if (!runtime) throw new Error("That session does not have an active Pi runtime.");
    return runtime;
  }

  private reconcileRuntimeSession(runtime: Runtime, previousId: string, nextId: string | null): void {
    if (!nextId || previousId === nextId) return;
    this.removeHistoryCache(previousId);
    this.removeHistoryCache(nextId);
    if (this.runtimes.get(previousId) === runtime) this.runtimes.delete(previousId);
    runtime.sessionId = nextId;
    this.runtimes.set(nextId, runtime);
    this.sessionCwds.set(nextId, runtime.cwd);
    this.historyRevisions.delete(previousId);
    if (this.selectedSessionId === previousId) this.selectedSessionId = nextId;
  }

  private discoverPersistedSessions(projectDirectory = this.browsedProject): Promise<PiSession[]> {
    const runtimeSessions = [...this.runtimes.values()]
      .flatMap((runtime) => runtime.service.snapshot().sessions)
      .filter(({ id }) => !this.deletedSessionIds.has(id));
    const knownSessions = [...this.sessions, ...runtimeSessions]
      .filter(({ id }) => !this.deletedSessionIds.has(id));
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
    this.sessions = this.sessions.filter(({ id }) => !this.deletedSessionIds.has(id));
    for (const runtime of this.runtimes.values()) {
      this.sessions = mergeSessions(
        this.sessions,
        runtime.service.snapshot().sessions.filter(({ id }) => !this.deletedSessionIds.has(id)),
        this.browsedProject,
      );
    }
    for (const [sessionId, runtime] of this.runtimes) {
      if (this.deletedSessionIds.has(sessionId)) continue;
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
    if (this.selectedSessionId && !this.deletedSessionIds.has(this.selectedSessionId) &&
      !this.sessions.some((session) => session.id === this.selectedSessionId)) {
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

  private async hydrateInactiveSession(session: PiSession): Promise<TranscriptItem[] | undefined> {
    if (this.runtimes.has(session.id)) return undefined;
    const fileFingerprint = await historyFileFingerprint(session.id);
    const cached = this.historyCache.get(session.id);
    if (cached && cached.fileFingerprint === fileFingerprint) {
      this.historyCache.delete(session.id);
      this.historyCache.set(session.id, cached);
      return cached.items;
    }
    const previousSnapshot = this.savedSnapshots.get(session.id);
    await this.refreshBigPiSummary(session.id, false);
    try {
      const { hydrated, fingerprint: afterFingerprint } = await this.hydrateHistory(session);
      if (this.runtimes.has(session.id)) return undefined;
      const signature = transcriptSignature(hydrated.transcript);
      const historyRevision = this.historySignatures.get(session.id) === signature
        ? this.historyRevisions.get(session.id) ?? previousSnapshot?.historyRevision ?? randomUUID()
        : randomUUID();
      this.removeHistoryCache(session.id);
      this.historyRevisions.set(session.id, historyRevision);
      this.historySignatures.set(session.id, signature);
      this.cacheHistory(session.id, hydrated.transcript, historyRevision, afterFingerprint);
      const transcriptPage = latestHistoryPage(hydrated.transcript);
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
        transcript: transcriptPage.items,
        historyRevision,
        status: null,
        transcriptHasOlder: transcriptPage.start > 0,
        ...(transcriptPage.start > 0
          ? { transcriptBeforeId: transcriptPage.items[0]?.id }
          : {}),
      });
      return hydrated.transcript;
    } catch {
      if (!this.savedSnapshots.has(session.id)) {
        this.savedSnapshots.set(session.id, {
          ...emptySnapshot(session.cwd),
          activeSessionId: session.id,
          activeSessionName: session.name,
          model: session.model ?? null,
          historyRevision: this.historyRevisions.get(session.id) ?? randomUUID(),
          status: { kind: "error", message: "Could not load conversation history. Retry by refreshing this session." },
        });
      } else {
        const snapshot = this.savedSnapshots.get(session.id)!;
        snapshot.status = { kind: "error", message: "Could not load conversation history. The last available history is unchanged; retry by refreshing this session." };
      }
      return undefined;
    }
  }

  private refreshBigPiSummary(sessionId: string, publish = true): Promise<void> {
    if (this.deletingSessionIds.has(sessionId) || this.deletedSessionIds.has(sessionId)) {
      return Promise.resolve();
    }
    const existing = this.bigPiRefreshes.get(sessionId);
    if (existing) {
      existing.refreshAgain = true;
      existing.publish ||= publish;
      return existing.promise;
    }

    const refresh = { promise: Promise.resolve(), refreshAgain: false, publish };
    refresh.promise = (async () => {
      do {
        refresh.refreshAgain = false;
        const generation = this.bigPiGenerations.get(sessionId) ?? 0;
        const [summary, billionContextPi] = await Promise.all([
          this.readBigPi(sessionId),
          this.readBillionContextPi(sessionId),
        ]);
        if (generation !== (this.bigPiGenerations.get(sessionId) ?? 0) ||
          this.deletingSessionIds.has(sessionId) || this.deletedSessionIds.has(sessionId)) break;
        this.bigPiBySession.set(sessionId, summary);
        this.billionContextPiBySession.set(sessionId, billionContextPi);
        if (refresh.publish && this.selectedSessionId === sessionId) this.emitSnapshot();
      } while (refresh.refreshAgain &&
        !this.deletingSessionIds.has(sessionId) && !this.deletedSessionIds.has(sessionId));
    })().finally(() => {
      if (this.bigPiRefreshes.get(sessionId) === refresh) this.bigPiRefreshes.delete(sessionId);
    });
    this.bigPiRefreshes.set(sessionId, refresh);
    return refresh.promise;
  }

  private emitSnapshot(): void {
    this.emit({ type: "session_snapshot", snapshot: this.snapshot() });
  }

  private snapshotForBrowser(snapshot: PiVotSnapshot): PiVotSnapshot {
    const page = latestHistoryPage(snapshot.transcript);
    const start = page.start;
    const transcript = page.items;
    return {
      ...snapshot,
      transcript,
      transcriptHasOlder: start > 0 || snapshot.transcriptHasOlder === true,
      ...(transcript.length && (start > 0 || snapshot.transcriptBeforeId)
        ? { transcriptBeforeId: transcript[0]!.id }
        : {}),
    };
  }

  private cacheHistory(
    sessionId: string,
    items: TranscriptItem[],
    revision: string,
    fileFingerprint: string | null,
  ): void {
    const bytes = Buffer.byteLength(JSON.stringify(items));
    if (bytes > this.historyCacheByteLimit) return;
    const previous = this.historyCache.get(sessionId);
    if (previous) this.historyCacheBytes -= previous.bytes;
    this.historyCache.delete(sessionId);
    this.historyCache.set(sessionId, { items, bytes, revision, fileFingerprint });
    this.historyCacheBytes += bytes;
    while (this.historyCache.size > HISTORY_CACHE_ENTRY_LIMIT ||
      this.historyCacheBytes > this.historyCacheByteLimit) {
      const oldest = this.historyCache.keys().next().value as string | undefined;
      if (!oldest) break;
      const evicted = this.historyCache.get(oldest);
      this.historyCache.delete(oldest);
      if (evicted) this.historyCacheBytes -= evicted.bytes;
    }
  }

  private removeHistoryCache(sessionId: string): void {
    const cached = this.historyCache.get(sessionId);
    if (!cached) return;
    this.historyCache.delete(sessionId);
    this.historyCacheBytes -= cached.bytes;
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
