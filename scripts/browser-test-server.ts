import { createPaneServer } from "../src/server.ts";
import { randomUUID } from "node:crypto";
import type { PiVotEvent, PiVotSnapshot, TranscriptItem } from "../src/pi-service.ts";
import type { ImageAttachment } from "../src/request.ts";

const fakeModels = [
  { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] },
  { provider: "fake-provider", id: "model-next", name: "model-next", contextWindow: 256_000, input: ["text", "image"] },
  { provider: "fake-provider", id: "fail-model", name: "fail-model", contextWindow: 128_000, input: ["text"] },
  ...Array.from({ length: 14 }, (_, index) => ({
    provider: index % 2 ? "local" : "another-provider",
    id: `available-${index}`,
    name: index === 13 ? `very-long-model-name-${"x".repeat(90)}` : `available-model-${index}`,
    contextWindow: 128_000 + index * 1_000,
    input: index % 2 ? ["text"] : ["text", "image"],
  })),
];

class FakePiService {
  private listeners = new Set<(event: PiVotEvent) => void>();
  private timer?: NodeJS.Timeout;
  state = "idle";
  isCompacting = false;
  context: PiVotSnapshot["context"] = { tokens: 134_982, contextWindow: 200_000, percent: 67.5 };
  model: PiVotSnapshot["model"] = { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] };
  private queue: Array<{ id: string; message: string; images: ImageAttachment[] }> = [];
  private followUps: Array<{ id: string; message: string; images: ImageAttachment[] }> = [];
  private messageId = 0;
  private nextCompactionError?: string;
  private nextCompactionDuration?: number;
  private externalSessionCount = 0;
  private projectDirectory = "/fake/project";
  private activeSessionId = "/fake/project/current.jsonl";
  private selectedSessionId: string | null = this.activeSessionId;
  private activeSessionName: string | null = "Current session";
  private sessions: Array<{ id: string; cwd: string; name: string | null; preview: string; updatedAt: string }> = [];
  private readonly persistedProjectSessions = new Map<string, typeof this.sessions>();
  private transcripts = new Map<string, TranscriptItem[]>();
  private readonly activeSessions = new Set<string>();
  private readonly runtimeSessions = new Set<string>();
  private readonly sessionStates = new Map<string, {
    state: string;
    isCompacting: boolean;
    context: PiVotSnapshot["context"];
    model: PiVotSnapshot["model"];
    queue: Array<{ id: string; message: string; images: ImageAttachment[] }>;
    status?: PiVotSnapshot["status"];
  }>();
  private readonly backgroundTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.resetSessionState();
  }

  private resetSessionState(): void {
    this.projectDirectory = "/fake/project";
    this.activeSessionId = "/fake/project/current.jsonl";
    this.selectedSessionId = this.activeSessionId;
    this.activeSessionName = "Current session";
    this.state = "idle";
    this.isCompacting = false;
    this.queue = [];
    this.followUps = [];
    this.messageId = 0;
    this.nextCompactionError = undefined;
    this.nextCompactionDuration = undefined;
    this.context = { tokens: 134_982, contextWindow: 200_000, percent: 67.5 };
    this.model = { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] };
    this.externalSessionCount = 0;
    const updatedAt = new Date().toISOString();
    const historicalId = `${this.projectDirectory}/history-hydration.jsonl`;
    const unnamedId = `${this.projectDirectory}/unnamed.jsonl`;
    const toolCallId = "historical-tool-1";
    this.sessions = [
      { id: this.activeSessionId, cwd: this.projectDirectory, name: this.activeSessionName, preview: "Current session", updatedAt },
      { id: historicalId, cwd: this.projectDirectory, name: "HDF5 debugging", preview: "Investigate persisted sessions", updatedAt },
      { id: unnamedId, cwd: this.projectDirectory, name: null, preview: "Find a parser regression", updatedAt },
    ];
    this.persistedProjectSessions.clear();
    for (const [directory, name] of [
      ["/fake/other-project", "Current session"],
      ["/fake/project-b", "Current session"],
      ["/fake/project-c", "Current session"],
    ]) {
      const id = `${directory}/current.jsonl`;
      this.persistedProjectSessions.set(directory, [{
        id,
        cwd: directory,
        name,
        preview: name,
        updatedAt,
      }]);
    }
    this.activeSessions.clear();
    this.activeSessions.add(this.activeSessionId);
    this.runtimeSessions.clear();
    this.runtimeSessions.add(this.activeSessionId);
    this.sessionStates.clear();
    for (const session of this.sessions) {
      this.sessionStates.set(session.id, {
        state: session.id === this.activeSessionId ? "idle" : "idle",
        isCompacting: false,
        context: session.id === this.activeSessionId
          ? { tokens: 134_982, contextWindow: 200_000, percent: 67.5 }
          : { tokens: 80_000, contextWindow: 200_000, percent: 40 },
        model: { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] },
        queue: [],
      });
    }
    this.transcripts.clear();
    this.transcripts.set(historicalId, [
      { id: "history-user-1", type: "user", text: "Investigate persisted sessions", createdAt: "2026-10-06T16:18:00.000Z", imageCount: 1 },
      { id: "history-assistant-1", type: "assistant", text: "I will inspect the saved history.", createdAt: "2026-10-06T16:19:00.000Z", thinking: "Reviewing the selected Pi session." },
      {
        id: `tool-${toolCallId}`,
        type: "tool",
        toolCallId,
        toolName: "read",
        input: '{"path":"session.jsonl"}',
        output: "Stored session message.",
        isError: false,
      },
      { id: "history-user-2", type: "user", text: "Continue from the stored transcript." },
      {
        id: "history-assistant-2",
        type: "assistant",
        text: "## Persisted heading\n\nHydrated **rich** response.\n\n```typescript\nconst hydrated: string = \"Pi\";\n```",
      },
    ]);
    this.transcripts.set(unnamedId, [
      { id: "unnamed-user", type: "user", text: "Find a parser regression" },
      { id: "unnamed-assistant", type: "assistant", text: "This session has no stored name." },
    ]);
    this.transcripts.set(this.activeSessionId, []);
    for (const projectSessions of this.persistedProjectSessions.values()) {
      for (const session of projectSessions) {
        this.transcripts.set(session.id, []);
        this.sessionStates.set(session.id, {
          state: "idle",
          isCompacting: false,
          context: { tokens: 80_000, contextWindow: 200_000, percent: 40 },
          model: { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] },
          queue: [],
        });
      }
    }
  }

  resetForBrowserTest(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const timer of this.backgroundTimers.values()) clearInterval(timer);
    this.backgroundTimers.clear();
    this.resetSessionState();
    this.emitSnapshot();
  }

  subscribe(listener: (event: PiVotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PiVotSnapshot {
    const sessions = this.sessions.map((session) => ({
      ...session,
      active: this.activeSessions.has(session.id),
      hasRuntime: this.runtimeSessions.has(session.id),
    })).sort((left, right) => {
      if (left.cwd === this.projectDirectory && right.cwd !== this.projectDirectory) return -1;
      if (right.cwd === this.projectDirectory && left.cwd !== this.projectDirectory) return 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    const transcript = (this.selectedSessionId ? this.transcripts.get(this.selectedSessionId) ?? [] : []);
    const transcriptStart = Math.max(0, transcript.length - 100);
    const currentTranscriptPage = transcript.slice(transcriptStart).map((item) => ({ ...item }));
    return {
      state: this.state as PiVotSnapshot["state"],
      isCompacting: this.isCompacting,
      context: { ...this.context },
      model: this.model ? { ...this.model } : null,
      queuedMessages: [...this.queue, ...this.followUps].map(({ id, message, images }) => ({
        id,
        message,
        ...(images.length ? { imageCount: images.length } : {}),
      })),
      projectDirectory: this.projectDirectory,
      activeSessionId: this.selectedSessionId,
      selectedSessionId: this.selectedSessionId,
      historyRevision: "browser-fixture",
      activeSessionName: this.selectedSessionId ? this.activeSessionName : null,
      sessions,
      transcript: currentTranscriptPage,
      transcriptHasOlder: transcriptStart > 0,
      ...(transcriptStart > 0 ? { transcriptBeforeId: currentTranscriptPage[0]?.id } : {}),
      bigPi: this.selectedSessionId === `${this.projectDirectory}/current.jsonl`
        ? {
            storagePresent: true,
            diskUsageBytes: 0,
            manifestStatus: "valid",
            totalChunks: 0,
            tiers: { t1: 0, t2: 0, t3: 0 },
          }
        : this.selectedSessionId === `${this.projectDirectory}/history-hydration.jsonl`
        ? {
            storagePresent: true,
            diskUsageBytes: 1536,
            manifestStatus: "valid",
            totalChunks: 10,
            tiers: { t1: 7, t2: 2, t3: 1 },
          }
        : this.selectedSessionId === `${this.projectDirectory}/unnamed.jsonl`
          ? {
              storagePresent: true,
              diskUsageBytes: 512,
              manifestStatus: "valid",
              totalChunks: 4,
              tiers: { t1: 2, t2: 1, t3: 1 },
            }
        : null,
      billionContextPi: this.selectedSessionId === `${this.projectDirectory}/current.jsonl`
        ? {
            detected: true,
            sidecarPresent: true,
            manifestStatus: "valid",
            totalBlocks: 0,
            tiers: { t1: 0, t2: 0, t3: 0 },
          }
        : this.selectedSessionId === `${this.projectDirectory}/history-hydration.jsonl`
        ? {
            detected: true,
            sidecarPresent: true,
            manifestStatus: "valid",
            totalBlocks: 6,
            tiers: { t1: 3, t2: 2, t3: 1 },
          }
        : null,
      status: this.selectedSessionId
        ? this.sessionStates.get(this.selectedSessionId)?.status ?? null
        : null,
    };
  }

  async getOlderTranscriptPage(sessionId: string, beforeId: string, revision: string) {
    if (sessionId !== this.selectedSessionId) throw new Error("The selected session changed.");
    const transcript = this.transcripts.get(sessionId) ?? [];
    const cursor = transcript.findIndex((item) => item.id === beforeId);
    if (cursor < 0) throw new Error("The history cursor is no longer valid.");
    const start = Math.max(0, cursor - 100);
    const items = transcript.slice(start, cursor).map((item) => ({ ...item }));
    return {
      sessionId,
      historyRevision: revision,
      items,
      hasOlder: start > 0,
      ...(start > 0 ? { beforeId: items[0]?.id } : {}),
    };
  }

  async refreshPersistedState(): Promise<void> {
    if (this.externalSessionCount < 2) {
      const id = `${this.projectDirectory}/terminal-created-${++this.externalSessionCount}.jsonl`;
      this.sessions.unshift({
        id,
        cwd: this.projectDirectory,
        name: `Created in terminal Pi ${this.externalSessionCount}`,
        preview: "A session created outside Pi-vot",
        updatedAt: new Date().toISOString(),
      });
      this.transcripts.set(id, []);
      this.sessionStates.set(id, {
        state: "idle",
        isCompacting: false,
        context: { tokens: 90_000, contextWindow: 200_000, percent: 45 },
        model: { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] },
        queue: [],
      });
    }
    this.emitSnapshot();
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!this.sessions.some((session) => session.id === sessionId)) throw new Error("That Pi session is no longer available.");
    if (this.runtimeSessions.has(this.activeSessionId)) this.saveCurrentRuntimeState();
    this.activeSessionId = sessionId;
    this.selectedSessionId = sessionId;
    this.activeSessionName = this.sessions.find((session) => session.id === sessionId)?.name ?? null;
    this.loadRuntimeState(sessionId);
    if (!this.runtimeSessions.has(sessionId)) {
      this.state = "idle";
      this.isCompacting = false;
      this.context = { tokens: null, contextWindow: null, percent: null };
      this.queue = [];
    }
    this.emitSnapshot();
  }

  async wakeSession(sessionId: string): Promise<void> {
    if (!this.sessions.some((session) => session.id === sessionId))
      throw new Error("That Pi session is no longer available.");
    if (!this.runtimeSessions.has(sessionId) && this.runtimeSessions.size >= 4)
      throw new Error("Four Pi sessions are already active. Stop or release one before starting another.");
    if (this.runtimeSessions.has(this.activeSessionId)) this.saveCurrentRuntimeState();
    this.runtimeSessions.add(sessionId);
    this.activeSessions.add(sessionId);
    this.activeSessionId = sessionId;
    this.selectedSessionId = sessionId;
    this.activeSessionName = this.sessions.find((session) => session.id === sessionId)?.name ?? null;
    this.loadRuntimeState(sessionId);
    this.emitSnapshot();
  }

  async newSession(): Promise<void> {
    const projectHasBusyRuntime = this.sessions.some((session) => {
      if (session.cwd !== this.projectDirectory || !this.runtimeSessions.has(session.id)) return false;
      const state = this.sessionStates.get(session.id);
      return state?.state === "running" || state?.state === "stopping" || state?.isCompacting === true ||
        (state?.queue.length ?? 0) > 0;
    });
    if (projectHasBusyRuntime) {
      if (this.runtimeSessions.has(this.activeSessionId)) this.saveCurrentRuntimeState();
    } else {
      this.assertSessionSwitchSafe();
      this.activeSessions.delete(this.activeSessionId);
      this.runtimeSessions.delete(this.activeSessionId);
    }
    this.activeSessionId = `${this.projectDirectory}/new-${++this.messageId}.jsonl`;
    this.selectedSessionId = this.activeSessionId;
    this.activeSessions.add(this.activeSessionId);
    this.runtimeSessions.add(this.activeSessionId);
    this.activeSessionName = null;
    this.transcripts.set(this.activeSessionId, []);
    this.sessionStates.set(this.activeSessionId, {
      state: "idle",
      isCompacting: false,
      context: { tokens: null, contextWindow: null, percent: null },
      model: { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] },
      queue: [],
    });
    this.state = "idle";
    this.isCompacting = false;
    this.queue = [];
    this.sessions.unshift({
      id: this.activeSessionId,
      cwd: this.projectDirectory,
      name: null,
      preview: "New session",
      updatedAt: new Date().toISOString(),
    });
    this.context = { tokens: null, contextWindow: null, percent: null };
    this.emitSnapshot();
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    this.assertSessionSwitchSafe();
    const selected = this.sessions.find((session) => session.id === sessionId);
    if (!selected) throw new Error("That Pi session is no longer available.");
    selected.name = name.trim();
    if (this.activeSessionId === sessionId) this.activeSessionName = selected.name;
    this.emitSnapshot();
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.sessions.some((session) => session.id === sessionId)) throw new Error("That Pi session is no longer available.");
    this.runtimeSessions.delete(sessionId);
    this.activeSessions.delete(sessionId);
    const timer = this.backgroundTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.backgroundTimers.delete(sessionId);
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    this.transcripts.delete(sessionId);
    this.sessionStates.delete(sessionId);
    if (sessionId === this.activeSessionId) {
      this.activeSessionId = "";
      this.activeSessionName = null;
      this.state = "idle";
      this.isCompacting = false;
      this.context = { tokens: null, contextWindow: null, percent: null };
      this.model = null;
    }
    this.emitSnapshot();
  }

  async changeProjectDirectory(directory: string): Promise<void> {
    this.projectDirectory = directory;
    this.selectedSessionId = null;
    this.activeSessionName = null;
    const knownSessions = this.persistedProjectSessions.get(directory) ?? [];
    this.sessions = [
      ...this.sessions,
      ...knownSessions.filter(({ id }) => !this.sessions.some((session) => session.id === id)),
    ];
    this.state = "idle";
    this.isCompacting = false;
    this.context = { tokens: null, contextWindow: null, percent: null };
    this.model = null;
    this.queue = [];
    this.emitSnapshot();
  }

  async sendNewSessionMessage(
    message: string,
    messageId: string,
    sessionId: string | undefined,
    images: ImageAttachment[],
    mode: "send" | "queue" | "steer" | undefined,
    directory: string,
  ): Promise<{ disposition: string; sessionId: string }> {
    const selectOnCompletion = this.projectDirectory === directory && this.selectedSessionId === null;
    let target = sessionId;
    if (!target) {
      if (this.runtimeSessions.size >= 4)
        throw new Error("Four Pi sessions are already active. Stop or release one before starting another.");
      target = `${directory}/deferred-${++this.messageId}.jsonl`;
      const created = {
        id: target,
        cwd: directory,
        name: null,
        preview: message.slice(0, 80) || "New session",
        updatedAt: new Date().toISOString(),
      };
      this.sessions.unshift(created);
      this.transcripts.set(target, []);
      this.sessionStates.set(target, {
        state: "idle",
        isCompacting: false,
        context: { tokens: null, contextWindow: null, percent: null },
        model: { ...fakeModels[0]! },
        queue: [],
      });
    }
    else if (!this.sessions.some((session) => session.id === target)) {
      throw new Error("That Pi session is no longer available.");
    }
    if (!this.runtimeSessions.has(target) && this.runtimeSessions.size >= 4)
      throw new Error("Four Pi sessions are already active. Stop or release one before starting another.");
    this.activeSessionId = target;
    if (selectOnCompletion) this.projectDirectory = directory;
    this.runtimeSessions.add(target);
    this.activeSessions.add(target);
    this.activeSessionName = this.sessions.find((session) => session.id === target)?.name ?? null;
    this.loadRuntimeState(target);
    try {
      const disposition = await this.sendMessage(message, messageId, undefined, images, mode);
      if (disposition === "started") {
        await new Promise((resolve) => setTimeout(resolve, 650));
        const transcript = this.transcripts.get(target) ?? [];
        const createdAt = new Date().toISOString();
        transcript.push({
          id: messageId,
          type: "user",
          text: message,
          ...(images.length ? { imageCount: images.length } : {}),
          createdAt,
        });
        transcript.push({
          id: `deferred-assistant-${randomUUID()}`,
          type: "assistant",
          text: "Canonical final answer.",
          createdAt,
        });
        this.transcripts.set(target, transcript);
      }
      if (selectOnCompletion) {
        this.selectedSessionId = target;
        this.emitSnapshot();
      }
      return { disposition, sessionId: target };
    }
    catch (error) {
      this.selectedSessionId = null;
      if (error instanceof Error) Object.assign(error, { sessionId: target });
      throw error;
    }
  }

  private assertSessionSwitchSafe(): void {
    if (this.state !== "idle" || this.isCompacting || this.queue.length > 0) {
      throw new Error("Finish or stop the active Pi operation before switching sessions or projects.");
    }
  }

  async sendMessage(
    message: string,
    queueId: string = randomUUID(),
    targetSessionId?: string,
    images: ImageAttachment[] = [],
    mode?: "send" | "queue" | "steer",
  ): Promise<string> {
    if (targetSessionId && targetSessionId !== this.activeSessionId) {
      if (!this.activeSessions.has(targetSessionId) && this.activeSessions.size >= 4) {
        throw new Error("Four Pi sessions are already active. Stop or release one before starting another.");
      }
      this.activeSessions.add(targetSessionId);
      this.runtimeSessions.add(targetSessionId);
      if (message === "background crash") return this.sendBackgroundCrash(targetSessionId, queueId);
      return this.sendBackgroundMessage(targetSessionId, message, queueId);
    }
    if (targetSessionId && !this.runtimeSessions.has(targetSessionId)) {
      if (this.activeSessions.size >= 4) {
        throw new Error("Four Pi sessions are already active. Stop or release one before starting another.");
      }
      this.activeSessions.add(targetSessionId);
      this.runtimeSessions.add(targetSessionId);
      this.loadRuntimeState(targetSessionId);
      this.emitSnapshot();
    }
    if (mode) {
      if (this.isCompacting) throw new Error("Pi is compacting; wait for compaction to finish before sending.");
      if (mode === "send" && this.state !== "idle") {
        throw new Error("Pi is already responding; choose Queue or Steer.");
      }
      if ((mode === "queue" || mode === "steer") && this.state !== "running") {
        throw new Error("Pi is not running; choose Send after it becomes idle.");
      }
    }
    if (message === "background stream") return this.sendBackgroundMessage(this.activeSessionId, message, queueId);
    if (message === "background crash") return this.sendBackgroundCrash(this.activeSessionId, queueId);
    if (message === "show one MCP warning") {
      this.emit({
        type: "notice",
        message: "MCP: Failed to connect to eclipse_coder: fetch failed — Nothing is listening at http://localhost:8124/mcp/eclipse-coder. Start the app or local process that serves this MCP server.",
      });
      return "handled";
    }
    if (message === "show MCP warnings") {
      this.emit({ type: "notice", message: "MCP: Failed to connect to eclipse_coder: fetch failed." });
      this.emit({ type: "notice", message: "MCP: The local browser tools server is unavailable." });
      return "handled";
    }
    if (message === "arm no-op compaction") {
      this.nextCompactionError = "Nothing to compact (session too small)";
      return "handled";
    }
    if (message === "arm slow compaction") {
      this.nextCompactionDuration = 2_000;
      return "handled";
    }
    if (message === "arm navigation compaction") {
      this.nextCompactionDuration = 6_000;
      return "handled";
    }
    if (message === "tool-only activity") {
      this.emit({ type: "thinking_delta", messageId: "tool-only", text: "Still thinking." });
      this.emit({ type: "tool_start", toolCallId: "tool-only-call", toolName: "read", input: "{}" });
      this.emit({ type: "tool_update", toolCallId: "tool-only-call", output: "Updated." });
      this.emit({ type: "tool_end", toolCallId: "tool-only-call", toolName: "read", output: "Done.", isError: false });
      this.emit({ type: "context_update", context: { tokens: 42_000, contextWindow: 200_000, percent: 21 } });
      this.emit({ type: "model_update", model: this.model });
      this.setState("running");
      this.setState("idle");
      return "handled";
    }
    if (message === "assistant delta only") {
      this.emit({ type: "assistant_delta", messageId: "orphan-delta", text: "Transport update only." });
      return "handled";
    }
    if (message === "assistant-only response") {
      const id = `fake-${++this.messageId}`;
      const createdAt = new Date().toISOString();
      this.emit({ type: "assistant_start", messageId: id, createdAt });
      this.emit({ type: "assistant_end", messageId: id, text: "Assistant follow-up.", thinking: "", createdAt });
      return "handled";
    }
    if (message === "show unavailable context") {
      this.emit({ type: "context_update", context: { tokens: null, contextWindow: null, percent: null } });
      return "handled";
    }
    if (message === "show small context") {
      this.emit({ type: "context_update", context: { tokens: 19_999, contextWindow: 200_000, percent: 10 } });
      return "handled";
    }
    if (message === "show incomplete context") {
      this.emit({ type: "context_update", context: { tokens: 100, contextWindow: null, percent: 10 } });
      return "handled";
    }
    const model = this.sessionStates.get(this.activeSessionId)?.model ?? this.model;
    if (images.length && !model?.input?.includes("image"))
      throw new Error("The selected model does not support image input.");
    if (message === "fail message")
      throw new Error("Fake Pi rejected the prompt.");
    if (message === "fail queued image" && !this.isCompacting)
      throw new Error("Fake Pi rejected the queued image.");
    if (this.isCompacting) {
      if (mode) throw new Error("Pi is compacting; wait for compaction to finish before sending.");
      this.queue.push({ id: queueId, message, images });
      this.emit({ type: "queued_message", id: queueId, message, ...(images.length ? { imageCount: images.length } : {}) });
      return "queued";
    }
    if (this.state === "running") {
      if (mode === "queue") {
        this.followUps.push({ id: queueId, message, images });
        this.emit({ type: "input_disposition", disposition: "queued" });
        return "queued";
      }
      this.emit({ type: "user_message", messageId: queueId, createdAt: new Date().toISOString() });
      this.emit({ type: "input_disposition", disposition: "steered" });
      return "steered";
    }

    const userCreatedAt = new Date().toISOString();
    this.emit({ type: "user_message", messageId: queueId, createdAt: userCreatedAt });
    if (message === "accepted user delayed assistant") {
      this.setState("running");
      setTimeout(() => {
        const assistantId = `fake-${++this.messageId}`;
        const createdAt = new Date().toISOString();
        this.emit({ type: "assistant_start", messageId: assistantId, createdAt });
        this.emit({ type: "assistant_end", messageId: assistantId, text: "Delayed assistant.", thinking: "", createdAt });
        this.setState("idle");
      }, 500);
      return "started";
    }
    if (message === "trigger automatic compaction") {
      this.setState("running");
      this.beginCompaction("threshold");
      return "started";
    }
    if (message === "trigger compaction with streamed agent output") {
      this.setState("running");
      this.beginCompaction("threshold", true, undefined, 1_500);
      const messageId = `fake-compaction-agent-${++this.messageId}`;
      const createdAt = new Date().toISOString();
      setTimeout(() => {
        this.emit({ type: "assistant_start", messageId, createdAt });
        this.emit({ type: "thinking_delta", messageId, text: "Thinking during compaction." });
        this.emit({ type: "assistant_delta", messageId, text: "Response during compaction." });
        this.emit({ type: "tool_start", toolCallId: `${messageId}-tool`, toolName: "read", input: '{"path":"src/example.ts"}' });
        this.emit({ type: "tool_update", toolCallId: `${messageId}-tool`, output: "Tool output during compaction." });
        this.emit({ type: "tool_end", toolCallId: `${messageId}-tool`, toolName: "read", output: "Tool completed during compaction.", isError: false });
        this.emit({ type: "assistant_end", messageId, text: "Response during compaction.", thinking: "Thinking during compaction.", createdAt });
      }, 150);
      return "started";
    }
    if (message === "recover stale compaction") {
      this.setState("running");
      this.isCompacting = true;
      const runtimeState = this.sessionStates.get(this.activeSessionId);
      if (runtimeState) runtimeState.isCompacting = true;
      this.emit({ type: "compaction_start", reason: "threshold" });
      this.timer = setTimeout(() => {
        this.isCompacting = false;
        if (runtimeState) runtimeState.isCompacting = false;
        this.setState("idle");
        this.emit({ type: "compaction_end", success: false, aborted: false });
        void this.deliverQueued();
      }, 250);
      return "started";
    }
    if (message === "trigger failed compaction") {
      this.setState("running");
      this.beginCompaction("overflow", false);
      return "started";
    }

    const id = `fake-${++this.messageId}`;
    const assistantCreatedAt = new Date().toISOString();
    this.setState("running");
    this.emit({ type: "assistant_start", messageId: id, createdAt: assistantCreatedAt });
    if (message === "thinking preview" || message === "thinking session switch") {
      const sessionId = this.activeSessionId;
      const longLine = `Long thinking line ${"overflow ".repeat(32)}`;
      const thinking = `First line\n\n${longLine}\n\nCurrent unfinished line`;
      this.emitFor(sessionId, { type: "thinking_delta", messageId: id, text: "First line\n\n" });
      this.timer = setTimeout(() => {
        this.emitFor(sessionId, { type: "thinking_delta", messageId: id, text: longLine });
      }, 800);
      this.timer = setTimeout(() => {
        this.emitFor(sessionId, { type: "thinking_delta", messageId: id, text: "\n\nCurrent unfinished line" });
      }, 2_800);
      this.timer = setTimeout(() => {
        const transcript = this.transcripts.get(sessionId) ?? [];
        transcript.push({
          id,
          type: "assistant",
          text: "Thinking preview complete.",
          thinking,
          createdAt: assistantCreatedAt,
        });
        this.transcripts.set(sessionId, transcript);
        this.emitFor(sessionId, {
          type: "assistant_end",
          messageId: id,
          text: "Thinking preview complete.",
          thinking,
        });
        const state = this.sessionStates.get(sessionId);
        if (state) state.state = "idle";
        if (this.activeSessionId === sessionId) this.setState("idle");
        else this.emitFor(sessionId, { type: "state", state: "idle" });
      }, 4_300);
      return "started";
    }
    if (message === "markdown response") {
      this.emit({ type: "assistant_delta", messageId: id, text: "**" });
      this.emit({ type: "assistant_delta", messageId: id, text: "\n\n```python\ndef f(" });
      this.timer = setTimeout(() => {
        this.emit({ type: "assistant_delta", messageId: id, text: "x):\n    return 42\n```\n\nInterim text." });
        this.timer = setTimeout(() => {
          this.emit({
            type: "assistant_end",
            messageId: id,
            text: [
              "# Canonical heading",
              "",
              "A paragraph with *emphasis*, **strong text**, and `inline <code>`.",
              "",
              "1. First item",
              "2. Second item",
              "   - Nested item",
              "",
              "> A quoted line.",
              "",
              "---",
              "",
              "[Secure link](https://example.com/path) and [unsafe link](javascript:alert(1)).",
              "",
              "| Name | Value |",
              "| --- | ---: |",
              "| answer | 42 |",
              "",
              "```javascript",
              "const count = 42;",
              "```",
              "",
              "```python",
              "def add(a, b):",
              "    return a + b",
              "```",
              "",
              "```json",
              "{\"valid\": true}",
              "```",
              "",
              "```not-a-real-language",
              "  <tag> & exact text",
              "```",
              "",
              "```",
              "unlabelled",
              "```",
            ].join("\n"),
            thinking: "",
          });
          this.setState("idle");
        }, 100);
      }, 100);
      return "started";
    }
    if (message === "rapid deltas") {
      const text = Array.from({ length: 1_000 }, (_, index) => `token-${index}|`).join("");
      for (let index = 0; index < 1_000; index++) {
        this.emit({ type: "thinking_delta", messageId: id, text: `think-${index}|` });
        this.emit({ type: "assistant_delta", messageId: id, text: `token-${index}|` });
      }
      this.emit({ type: "assistant_end", messageId: id, text, thinking: "Canonical thinking." });
      this.setState("idle");
      return "started";
    }
    if (message === "markdown security") {
      this.timer = setTimeout(() => {
        this.emit({
          type: "assistant_end",
          messageId: id,
          text: [
            "<script>window.__modelScriptRan = true</script>",
            '<img src="x" onerror="window.__modelEventRan = true">',
            '<iframe srcdoc="<script>window.__modelFrameRan = true</script>"></iframe>',
            '[Unsafe](javascript:alert(1)) [Data](data:text/html,hello) [Safe](https://example.com/)',
          ].join("\n\n"),
          thinking: "",
        });
        this.setState("idle");
      }, 50);
      return "started";
    }
    if (message === "long transcript") {
      let index = 0;
      let transcript = "";
      this.timer = setInterval(() => {
        if (this.state !== "running") {
          clearInterval(this.timer);
          return;
        }
        const delta = `\nLine ${index++}: ${"streamed content ".repeat(4)}`;
        transcript += delta;
        this.emit({ type: "assistant_delta", messageId: id, text: delta });
        if (index === 120) {
          clearInterval(this.timer);
          this.emit({ type: "assistant_end", messageId: id, text: transcript, thinking: "" });
          this.setState("idle");
        }
      }, 35);
      return "started";
    }
    if (message === "tool error") {
      this.emit({ type: "tool_start", toolCallId: `${id}-tool`, toolName: "bash", input: '{"command":"false"}' });
      this.emit({
        type: "tool_end",
        toolCallId: `${id}-tool`,
        toolName: "bash",
        output: "Command failed.",
        isError: true,
      });
      this.timer = setTimeout(() => {
        this.emit({ type: "assistant_end", messageId: id, text: "The tool failed.", thinking: "" });
        this.setState("idle");
      }, 100);
      return "started";
    }
    this.emit({ type: "thinking_delta", messageId: id, text: "I will inspect the request first." });
    this.emit({ type: "assistant_delta", messageId: id, text: "Streaming response " });
    this.emit({ type: "tool_start", toolCallId: `${id}-tool`, toolName: "read", input: '{"path":"src/example.ts"}' });
    this.emit({ type: "tool_update", toolCallId: `${id}-tool`, output: "Reading the requested file…" });

    this.timer = setTimeout(() => {
      this.emit({
        type: "tool_end",
        toolCallId: `${id}-tool`,
        toolName: "read",
        output: "File read successfully.",
        isError: false,
      });
      this.emit({
        type: "assistant_end",
        messageId: id,
        text: "Canonical final answer.",
        thinking: "I will inspect the request first.",
      });
      this.setState("idle");
    }, message === "long run" ? 60_000 : 500);
    return "started";
  }

  async abort(sessionId?: string): Promise<void> {
    if (sessionId && sessionId !== this.activeSessionId) {
      const state = this.sessionStates.get(sessionId);
      if (state) state.state = "idle";
      const timer = this.backgroundTimers.get(sessionId);
      if (timer) clearInterval(timer);
      this.backgroundTimers.delete(sessionId);
      this.emitFor(sessionId, { type: "state", state: "idle" });
      return;
    }
    if (this.isCompacting) throw new Error("Pi is compacting; Stop does not cancel compaction.");
    const wasRunning = this.state === "running" || this.state === "stopping";
    if (this.timer) clearTimeout(this.timer);
    this.setState("idle");
    if (!wasRunning) this.resetSessionState();
  }

  async cancelQueuedMessage(messageId: string, sessionId?: string): Promise<boolean> {
    if (sessionId && sessionId !== this.activeSessionId) return false;
    const queuedIndex = this.queue.findIndex((message) => message.id === messageId);
    const followUpIndex = this.followUps.findIndex((message) => message.id === messageId);
    if (queuedIndex < 0 && followUpIndex < 0) return false;
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    if (followUpIndex >= 0) this.followUps.splice(followUpIndex, 1);
    this.emit({ type: "queued_message_cancelled", id: messageId });
    return true;
  }

  async clearQueuedMessages(sessionId?: string): Promise<string[]> {
    if (sessionId && sessionId !== this.activeSessionId) return [];
    const ids = [...this.queue, ...this.followUps].map((message) => message.id);
    this.queue = [];
    this.followUps = [];
    for (const id of ids) this.emit({ type: "queued_message_cancelled", id });
    return ids;
  }

  async compact(): Promise<void> {
    if (this.isCompacting) throw new Error("Pi is already compacting.");
    const error = this.nextCompactionError;
    this.nextCompactionError = undefined;
    const duration = this.nextCompactionDuration ?? 600;
    this.nextCompactionDuration = undefined;
    this.beginCompaction("manual", !error, error, duration);
  }

  async getAvailableModels(sessionId: string) {
    const state = this.sessionStates.get(sessionId);
    if (!state) throw new Error("That Pi session is no longer available.");
    if (!this.runtimeSessions.has(sessionId)) {
      return {
        sessionId,
        hasRuntime: false,
        model: state.model,
        models: [],
        canChange: false,
        message: "Activate this session before changing models.",
      };
    }
    const canChange = state.state === "idle" && !state.isCompacting && state.queue.length === 0;
    return {
      sessionId,
      hasRuntime: true,
      model: state.model,
      models: fakeModels.map((model) => ({ ...model })),
      canChange,
      ...(!canChange ? { message: "Model can be changed when the session is idle." } : {}),
    };
  }

  async getPromptTemplates(sessionId: string) {
    if (!this.runtimeSessions.has(sessionId)) {
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
      commands: [
        { name: "review", description: "Review the requested changes." },
        { name: "summarize", description: "Summarize the selected work." },
      ],
    };
  }

  async changeModel(sessionId: string, provider: string, modelId: string) {
    const state = this.sessionStates.get(sessionId);
    if (!state || !this.runtimeSessions.has(sessionId)) throw new Error("That session does not have an active Pi runtime.");
    if (state.state !== "idle" || state.isCompacting || state.queue.length > 0) {
      throw new Error("Model can be changed when the session is idle.");
    }
    if (modelId === "fail-model") throw new Error("Fake model switch failed.");
    const selected = fakeModels.find((model) => model.provider === provider && model.id === modelId);
    if (!selected) throw new Error("Model not found.");
    state.model = { ...selected };
    state.context = {
      tokens: state.context.tokens,
      contextWindow: selected.contextWindow,
      percent: state.context.tokens === null ? null : state.context.tokens / selected.contextWindow * 100,
    };
    if (sessionId === this.activeSessionId) {
      this.model = { ...state.model };
      this.context = { ...state.context };
    }
    this.emitFor(sessionId, { type: "model_update", model: state.model });
    this.emitFor(sessionId, { type: "context_update", context: state.context });
    return { sessionId, model: { ...state.model }, context: { ...state.context } };
  }

  private beginCompaction(reason: string, success = true, error?: string, duration = 600): void {
    this.isCompacting = true;
    const runtimeState = this.sessionStates.get(this.activeSessionId);
    if (runtimeState) runtimeState.isCompacting = true;
    this.emit({ type: "compaction_start", reason });
    this.timer = setTimeout(() => {
      this.isCompacting = false;
      if (runtimeState) runtimeState.isCompacting = false;
      if (success) {
        this.context = { tokens: 31_000, contextWindow: 200_000, percent: 15.5 };
        this.emit({ type: "context_update", context: { ...this.context } });
      }
      const entry = success
        ? { id: `compaction-${randomUUID()}`, type: "compaction" as const, createdAt: new Date().toISOString() }
        : undefined;
      if (entry) this.transcripts.get(this.activeSessionId)?.push(entry);
      this.emit({
        type: "compaction_end",
        success,
        aborted: false,
        ...(entry ? { entry } : {}),
        ...(!success ? { error: error ?? "Fake compaction failed safely." } : {}),
        ...(error === "Nothing to compact (session too small)" ? { informational: true } : {}),
      });
      if (this.state === "running") this.setState("idle");
      void this.deliverQueued();
    }, duration);
  }

  private async deliverQueued(): Promise<void> {
    while (!this.isCompacting && this.queue.length) {
      const queued = this.queue[0]!;
      this.queue.shift();
      try {
        const disposition = await this.sendMessage(queued.message, queued.id, undefined, queued.images);
        if (disposition === "queued") break;
        this.emit({ type: "queued_message_sent", id: queued.id, disposition: disposition as "started" | "queued" | "handled" | "steered" });
      } catch (error) {
        this.emit({
          type: "queued_message_failed",
          id: queued.id,
          error: error instanceof Error ? error.message : "Fake Pi rejected the queued message.",
        });
      }
    }
  }

  private setState(state: string): void {
    this.state = state;
    const runtimeState = this.sessionStates.get(this.activeSessionId);
    if (runtimeState) runtimeState.state = state;
    this.emit({ type: "state", state: state as "idle" | "running" });
    if (state === "idle" && this.followUps.length > 0) {
      queueMicrotask(() => {
        if (this.state !== "idle" || this.isCompacting) return;
        const queued = this.followUps.shift();
        if (!queued) return;
        this.emit({ type: "user_message", messageId: queued.id, createdAt: new Date().toISOString() });
      });
    }
  }

  private emitSnapshot(): void {
    const event = { type: "session_snapshot" as const, snapshot: this.snapshot() };
    for (const listener of this.listeners) listener(event);
  }

  private emit(event: PiVotEvent): void {
    this.emitFor(this.activeSessionId, event);
  }

  private emitFor(sessionId: string, event: PiVotEvent): void {
    if (event.type === "notice" || event.type === "error") {
      const state = this.sessionStates.get(sessionId);
      if (state) state.status = { kind: event.type, message: event.message };
    }
    for (const listener of this.listeners) listener({ ...event, sessionId });
  }

  private saveCurrentRuntimeState(): void {
    this.sessionStates.set(this.activeSessionId, {
      state: this.state,
      isCompacting: this.isCompacting,
      context: { ...this.context },
      model: this.model ? { ...this.model } : null,
      queue: this.queue.map((item) => ({ ...item, images: [...item.images] })),
    });
  }

  private loadRuntimeState(sessionId: string): void {
    const state = this.sessionStates.get(sessionId) ?? {
      state: "idle",
      isCompacting: false,
      context: { tokens: 80_000, contextWindow: 200_000, percent: 40 },
      model: { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] },
      queue: [],
    };
    this.sessionStates.set(sessionId, state);
    this.state = state.state;
    this.isCompacting = state.isCompacting;
    this.context = { ...state.context };
    this.model = state.model ? { ...state.model } : null;
    this.queue = state.queue.map((item) => ({ ...item, images: [...item.images] }));
  }

  private sendBackgroundMessage(sessionId: string, message: string, queueId: string): string {
    const state = this.sessionStates.get(sessionId) ?? {
      state: "idle",
      isCompacting: false,
      context: { tokens: 80_000, contextWindow: 200_000, percent: 40 },
      model: { provider: "fake-provider", id: "fake-model", name: "fake-model", contextWindow: 200_000, input: ["text", "image"] },
      queue: [],
    };
    this.sessionStates.set(sessionId, state);
    state.state = "running";
    if (sessionId === this.activeSessionId) this.state = "running";
    this.transcripts.get(sessionId)?.push({ id: queueId, type: "user", text: message });
    const assistantId = `background-${++this.messageId}`;
    this.emitFor(sessionId, { type: "state", state: "running" });
    this.emitFor(sessionId, { type: "assistant_start", messageId: assistantId });
    this.emitFor(sessionId, { type: "thinking_delta", messageId: assistantId, text: "Thinking for session A." });
    this.emitFor(sessionId, {
      type: "tool_start",
      toolCallId: `${assistantId}-tool`,
      toolName: "read",
      input: '{"session":"A"}',
    });
    let count = 0;
    const timer = setInterval(() => {
      count++;
      const text = ` background chunk ${count}`;
      this.emitFor(sessionId, { type: "assistant_delta", messageId: assistantId, text });
      if (count >= 24) {
        clearInterval(timer);
        this.backgroundTimers.delete(sessionId);
        this.emitFor(sessionId, {
          type: "tool_end",
          toolCallId: `${assistantId}-tool`,
          toolName: "read",
          output: "Session A tool result",
          isError: false,
        });
        this.emitFor(sessionId, {
          type: "assistant_end",
          messageId: assistantId,
          text: "Background response from A.",
          thinking: "Thinking for session A.",
        });
        this.transcripts.get(sessionId)?.push({
          id: assistantId,
          type: "assistant",
          text: "Background response from A.",
          thinking: "Thinking for session A.",
        });
        this.transcripts.get(sessionId)?.push({
          id: `${assistantId}-tool`,
          type: "tool",
          toolCallId: `${assistantId}-tool`,
          toolName: "read",
          input: '{"session":"A"}',
          output: "Session A tool result",
          isError: false,
        });
        const currentState = this.sessionStates.get(sessionId) ?? state;
        currentState.state = "idle";
        currentState.context = { tokens: 81_000, contextWindow: 200_000, percent: 40.5 };
        if (sessionId === this.activeSessionId) {
          this.state = "idle";
          this.context = { ...currentState.context };
        }

        this.emitFor(sessionId, { type: "context_update", context: currentState.context });
        this.emitFor(sessionId, { type: "state", state: "idle" });
      }
    }, 80);
    this.backgroundTimers.set(sessionId, timer);
    return "started";
  }

  private sendBackgroundCrash(sessionId: string, queueId: string): string {
    const state = this.sessionStates.get(sessionId)!;
    state.state = "running";
    if (sessionId === this.activeSessionId) this.state = "running";
    this.transcripts.get(sessionId)?.push({ id: queueId, type: "user", text: "background crash" });
    this.emitFor(sessionId, { type: "state", state: "running" });
    const timer = setTimeout(() => {
      const current = this.sessionStates.get(sessionId)!;
      current.state = "failed";
      current.status = { kind: "error", message: "Fake Pi process crashed." };
      if (sessionId === this.activeSessionId) this.state = "failed";
      this.activeSessions.delete(sessionId);
      this.backgroundTimers.delete(sessionId);
      this.emitFor(sessionId, { type: "state", state: "failed", error: current.status.message });
      this.emitFor(sessionId, { type: "error", message: current.status.message });
      this.emitSnapshot();
    }, 350);
    this.backgroundTimers.set(sessionId, timer);
    return "started";
  }

  async releaseRuntime(sessionId: string): Promise<void> {
    const state = this.sessionStates.get(sessionId);
    if (state?.state === "running" || state?.isCompacting || state?.queue.length) {
      throw new Error("Stop and wait for this Pi session to settle before closing its runtime.");
    }
    this.activeSessions.delete(sessionId);
    this.runtimeSessions.delete(sessionId);
    this.emitSnapshot();
  }
}

const fakePiService = new FakePiService();
const app = createPaneServer(fakePiService);
app.server.listen(4174, "127.0.0.1");

async function close(): Promise<void> {
  app.closeEvents();
  await new Promise<void>((resolveClose) => app.server.close(() => resolveClose()));
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
