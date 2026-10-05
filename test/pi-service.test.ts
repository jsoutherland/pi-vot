import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  PiService,
  discoverPiSessions,
  hydratePiSession,
  piSessionDirectoryName,
  resolvePiSessionDirectory,
  type PiVotEvent,
} from "../src/pi-service.ts";

interface Command {
  id?: string;
  type?: string;
  [key: string]: unknown;
}

const testDiscoveryContext = {
  env: { PI_CODING_AGENT_DIR: join(tmpdir(), `pi-vot-test-agent-${process.pid}`) },
  home: join(tmpdir(), `pi-vot-test-home-${process.pid}`),
};

class FakePiProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly commands: Command[] = [];
  exitCode: number | null = null;
  killed = false;
  onCommand: (command: Command) => void = (command) => {
    this.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : undefined });
  };

  constructor() {
    super();
    this.stdin = new Writable({
      highWaterMark: 1,
      write: (chunk, _encoding, callback) => {
        setTimeout(() => {
          const command = JSON.parse(String(chunk).trim()) as Command;
          this.commands.push(command);
          this.onCommand(command);
          callback();
        }, 5);
      },
    });
    this.stdin.on("finish", () => this.close(0));
    setImmediate(() => this.emit("spawn"));
  }

  respond(command: Command, extra: Record<string, unknown> = {}): void {
    this.emitRecord({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...extra,
    });
  }

  emitRecord(record: unknown, split = false): void {
    const line = `${JSON.stringify(record)}\n`;
    if (split) {
      const middle = Math.floor(line.length / 2);
      this.stdout.write(line.slice(0, middle));
      this.stdout.write(line.slice(middle));
    } else {
      this.stdout.write(line);
    }
  }

  close(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }

  kill(): boolean {
    this.killed = true;
    this.close(1);
    return true;
  }
}

function setup(compactTimeoutMs = 120_000) {
  const child = new FakePiProcess();
  const service = new PiService(
    "/fake/project",
    () => child as unknown as ChildProcessWithoutNullStreams,
    compactTimeoutMs,
    testDiscoveryContext,
  );
  const events: PiVotEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { child, service, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the fake Pi state.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("RPC command IDs correlate concurrent commands regardless of response order", async () => {
  const { child, service } = setup();
  let promptFinished = false;
  let releasePrompt!: () => void;
  const delayedPrompt = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  child.onCommand = (command) => {
    if (command.type === "prompt") {
      child.emitRecord({ type: "agent_start" });
      void delayedPrompt.then(() => {
        child.respond(command, { data: { disposition: "started" } });
        promptFinished = true;
      });
    } else if (command.type === "abort") {
      child.emitRecord({ type: "agent_settled" });
      child.respond(command);
    } else {
      child.respond(command, { data: { disposition: "queued" } });
    }
  };

  const prompt = service.sendMessage("first");
  while (service.state !== "running") await new Promise((resolve) => setTimeout(resolve, 1));
  await service.abort();
  assert.equal(promptFinished, false);
  releasePrompt();
  assert.equal(await prompt, "started");
  assert.equal(service.state, "idle");

  child.onCommand = (command) => {
    if (command.type === "prompt") child.emitRecord({ type: "agent_start" });
    if (command.type === "abort") child.emitRecord({ type: "agent_settled" });
    child.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : { disposition: "queued" } });
  };
  assert.equal(await service.sendMessage("next"), "started");
  assert.equal(await service.sendMessage("steering"), "steered");
  assert.deepEqual(child.commands.map(({ type }) => type).filter((type) =>
    ["prompt", "abort", "steer", "compact"].includes(type ?? ""),
  ), ["prompt", "abort", "prompt", "steer"]);
  await service.stop();
});

test("native prompt and steer carry structured images only for models with image input", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: {
        model: { provider: "fake", id: "vision", name: "Vision", input: ["text", "image"] },
        isStreaming: false,
      } });
    }
    else if (command.type === "get_session_stats") child.respond(command, { data: { contextUsage: null } });
    else if (command.type === "prompt" || command.type === "steer") {
      child.respond(command, { data: { disposition: "started" } });
    }
    else child.respond(command);
  };
  const image = {
    mimeType: "image/png",
    data: "iVBORw0KGgo=",
    name: "screenshot.png",
    size: 8,
  };

  assert.equal(await service.sendMessage("describe", "prompt-image", [image]), "started");
  const prompt = child.commands.find((command) => command.type === "prompt");
  assert.deepEqual(prompt, {
    id: prompt?.id,
    type: "prompt",
    message: "describe",
    images: [{ type: "image", mimeType: "image/png", data: image.data }],
  });
  const firstMessage = service.snapshot().transcript[0];
  assert.equal(firstMessage?.type, "user");
  if (firstMessage?.type === "user")
    assert.equal(firstMessage.imageCount, 1);

  child.emitRecord({ type: "agent_start" });
  assert.equal(await service.sendMessage("also inspect", "steer-image", [image]), "steered");
  const steer = child.commands.find((command) => command.type === "steer");
  assert.deepEqual(steer && { type: steer.type, message: steer.message, images: steer.images }, {
    type: "steer",
    message: "also inspect",
    images: [{ type: "image", mimeType: "image/png", data: image.data }],
  });
  await service.stop();
});

test("non-image models reject image input and compaction queues retain image payloads in FIFO order", async () => {
  const unsupported = setup();
  unsupported.child.onCommand = (command) => {
    if (command.type === "get_state") {
      unsupported.child.respond(command, { data: {
        model: { provider: "fake", id: "text", name: "Text", input: ["text"] },
        isStreaming: false,
      } });
    }
    else unsupported.child.respond(command, { data: { contextUsage: null } });
  };
  const image = { mimeType: "image/png", data: "iVBORw0KGgo=", size: 8 };
  await assert.rejects(unsupported.service.sendMessage("blocked", "blocked-image", [image]), /does not support image input/);
  assert.equal(unsupported.child.commands.some((command) => command.type === "prompt"), false);
  await unsupported.service.stop();

  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: {
        model: { provider: "fake", id: "vision", name: "Vision", input: ["text", "image"] },
        isStreaming: false,
      } });
    }
    else if (command.type === "prompt") child.respond(command, { data: { disposition: "started" } });
    else child.respond(command, { data: { contextUsage: null } });
  };
  const internal = service as unknown as {
    compacting: boolean;
    drainQueuedMessages(): Promise<void>;
  };
  internal.compacting = true;
  assert.equal(await service.sendMessage("first", "queue-image-1", [image]), "queued");
  assert.equal(await service.sendMessage("second", "queue-image-2", [image, image]), "queued");
  assert.deepEqual(service.snapshot().queuedMessages, [
    { id: "queue-image-1", message: "first", imageCount: 1 },
    { id: "queue-image-2", message: "second", imageCount: 2 },
  ]);
  internal.compacting = false;
  await internal.drainQueuedMessages();
  assert.deepEqual(child.commands.filter((command) =>
    command.type === "prompt" || command.type === "steer",
  ).map((command) => ({
    type: command.type,
    message: command.message,
    count: Array.isArray(command.images) ? command.images.length : 0,
  })), [
    { type: "prompt", message: "first", count: 1 },
    { type: "steer", message: "second", count: 2 },
  ]);
  await service.stop();
});

test("assistant and thinking deltas stream, then canonical message_end content wins", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => {
    child.emitRecord({ type: "agent_start" });
    child.respond(command, { data: { disposition: "started" } });
  };
  await service.sendMessage("stream");
  child.emitRecord({ type: "message_start", message: { role: "assistant", content: [] } }, true);
  child.emitRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "approx " } }, true);
  child.emitRecord({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "reason " } });
  child.emitRecord({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "canonical reasoning" },
        { type: "text", text: "canonical answer" },
      ],
    },
  });
  child.emitRecord({ type: "agent_end", messages: [], willRetry: true });
  assert.equal(service.state, "running");
  assert.ok(service.snapshot().transcript.some((item) =>
    item.type === "assistant" && item.text === "canonical answer" && item.thinking === "canonical reasoning",
  ));
  child.emitRecord({ type: "agent_settled" });
  assert.equal(service.state, "idle");
  assert.ok(events.some((event) => event.type === "assistant_delta" && event.text === "approx "));
  assert.ok(events.some((event) => event.type === "thinking_delta" && event.text === "reason "));
  assert.ok(events.some((event) =>
    event.type === "assistant_end" &&
    event.text === "canonical answer" &&
    event.thinking === "canonical reasoning",
  ));
  await service.stop();
});

test("tool lifecycle remains correlated by tool call ID and preserves error results", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => {
    child.emitRecord({ type: "agent_start" });
    child.respond(command, { data: { disposition: "started" } });
  };
  await service.sendMessage("tools");
  child.emitRecord({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts" } });
  child.emitRecord({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "pwd" } });
  child.emitRecord({ type: "tool_execution_update", toolCallId: "b", partialResult: { content: [{ type: "text", text: "working" }] } });
  child.emitRecord({
    type: "tool_execution_end",
    toolCallId: "a",
    toolName: "read",
    result: { content: [{ type: "text", text: "File read successfully." }] },
    isError: false,
  });
  child.emitRecord({
    type: "tool_execution_end",
    toolCallId: "b",
    toolName: "bash",
    result: { content: [{ type: "text", text: "failed" }] },
    isError: true,
  });
  assert.ok(service.snapshot().transcript.some((item) =>
    item.type === "tool" && item.toolCallId === "a" && item.output === "File read successfully.",
  ));
  assert.ok(events.some((event) => event.type === "tool_start" && event.toolCallId === "a"));
  assert.ok(events.some((event) => event.type === "tool_start" && event.toolCallId === "b"));
  assert.ok(events.some((event) => event.type === "tool_update" && event.toolCallId === "b" && event.output === "working"));
  assert.ok(events.some((event) => event.type === "tool_end" && event.toolCallId === "a" && !event.isError));
  assert.ok(events.some((event) => event.type === "tool_end" && event.toolCallId === "b" && event.isError));
  await service.stop();
});

test("a handled prompt is not treated as a new assistant response", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => child.respond(command, { data: { disposition: "handled" } });
  assert.equal(await service.sendMessage("/extension-command"), "handled");
  assert.ok(events.some((event) => event.type === "input_disposition" && event.disposition === "handled"));
  assert.equal(events.some((event) => event.type === "assistant_end"), false);
  assert.deepEqual(child.commands.map(({ type }) => type).filter((type) => type === "prompt"), ["prompt"]);
  await service.stop();
});

test("agent_end does not settle; agent_settled does", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    child.emitRecord({ type: "agent_start" });
    child.respond(command, { data: { disposition: "started" } });
  };
  await service.sendMessage("lifecycle");
  child.emitRecord({ type: "agent_end", messages: [], willRetry: false });
  assert.equal(service.state, "running");
  child.emitRecord({ type: "agent_settled" });
  assert.equal(service.state, "idle");
  await service.stop();
});

test("a fast agent_settled event before the prompt response is not lost", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "prompt") {
      child.emitRecord({ type: "agent_start" });
      child.emitRecord({ type: "agent_settled" });
    }
    child.respond(command, { data: { disposition: "started" } });
  };
  await service.sendMessage("quick");
  assert.equal(service.state, "idle");
  await service.stop();
});

test("extension UI prompts are surfaced and safely cancelled with the RPC response", async () => {
  const { child, service, events } = setup();
  child.onCommand = (command) => child.respond(command, { data: { disposition: "handled" } });
  await service.sendMessage("invoke extension");
  child.emitRecord({ type: "extension_ui_request", id: "extension-1", method: "confirm", title: "Continue?", message: "Proceed?" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(events.some((event) => event.type === "notice" && event.message.includes("does not support yet")));
  assert.ok(child.commands.some((command) =>
    command.type === "extension_ui_response" && command.id === "extension-1" && command.cancelled === true,
  ));
  await service.stop();
});

test("RPC errors are useful, malformed records are ignored, and stdin backpressure drains", async () => {
  const { child, service } = setup();
  let drains = 0;
  child.stdin.on("drain", () => drains++);
  child.onCommand = (command) => {
    child.emitRecord({ type: "response", id: "unexpected", success: true });
    child.emitRecord("{ invalid json");
    child.respond(command, { success: false, error: "The selected model is unavailable." });
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(service.sendMessage("fail"), /selected model is unavailable/);
  } finally {
    console.error = originalError;
  }
  assert.ok(drains > 0);
  await service.stop();
});

test("child exit rejects pending commands and marks the service disconnected", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    child.emitRecord({ type: "agent_start" });
  };
  const sending = service.sendMessage("wait");
  while (service.state !== "running") await new Promise((resolve) => setTimeout(resolve, 1));
  child.close(9);
  await assert.rejects(sending, /Pi exited with code 9/);
  assert.equal(service.state, "failed");
  await service.stop();
});

test("abort settles the session and the same Pi process accepts another prompt", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "prompt") child.emitRecord({ type: "agent_start" });
    if (command.type === "abort") child.emitRecord({ type: "agent_settled" });
    child.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : undefined });
  };
  await service.sendMessage("first");
  await service.abort();
  assert.equal(service.state, "idle");
  assert.equal(await service.sendMessage("after abort"), "started");
  assert.deepEqual(child.commands.map(({ type }) => type).filter((type) =>
    ["prompt", "abort", "steer", "compact"].includes(type ?? ""),
  ), ["prompt", "abort", "prompt"]);
  await service.stop();
});

test("shutdown aborts active work, closes RPC input, and waits for the child", async () => {
  const { child, service } = setup();
  child.onCommand = (command) => {
    if (command.type === "prompt") child.emitRecord({ type: "agent_start" });
    if (command.type === "abort") child.emitRecord({ type: "agent_settled" });
    child.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : undefined });
  };
  await service.sendMessage("active");
  await service.stop();
  assert.deepEqual(child.commands.map(({ type }) => type).filter((type) =>
    ["prompt", "abort", "steer", "compact"].includes(type ?? ""),
  ), ["prompt", "abort"]);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.exitCode, 0);
});

test("initial context and model come from Pi and unavailable usage never falls back to cumulative tokens", async () => {
  const { child, service, events } = setup();
  let model = { provider: "test-provider", id: "model-one", name: "Model One", contextWindow: 200_000 };
  let usage: unknown = { tokens: 134_982, contextWindow: 200_000, percent: 67.49 };
  let statsCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { model, isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      statsCalls++;
      child.respond(command, {
        data: {
          tokens: { input: 999_000, output: 800_000, total: 1_799_000 },
          contextUsage: usage,
        },
      });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  assert.deepEqual(service.snapshot().model, {
    provider: "test-provider",
    id: "model-one",
    name: "Model One",
    contextWindow: 200_000,
  });
  assert.deepEqual(service.snapshot().context, {
    tokens: 134_982,
    contextWindow: 200_000,
    percent: 67.49,
  });

  model = { provider: "test-provider", id: "model-two", name: "Model Two", contextWindow: 256_000 };
  usage = { tokens: null, contextWindow: 190_000, percent: null };
  child.emitRecord({ type: "model_change", model });
  await waitFor(() => statsCalls >= 2 && service.snapshot().model?.id === "model-two");
  assert.deepEqual(service.snapshot().context, {
    tokens: null,
    contextWindow: 190_000,
    percent: null,
  });
  assert.equal(service.snapshot().model?.contextWindow, 256_000);
  assert.ok(events.some((event) => event.type === "context_update" && event.context.tokens === null));
  await service.stop();
});

test("model listing and switching use native Pi RPC and refresh model/context state", async () => {
  const { child, service } = setup();
  let model = { provider: "test", id: "first", name: "First", contextWindow: 100_000 };
  let usage: unknown = { tokens: 12_000, contextWindow: 100_000, percent: 12 };
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { model, isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: usage } });
    } else if (command.type === "get_available_models") {
      child.respond(command, { data: { models: [model, { provider: "other", id: "second", name: "Second" }] } });
    } else if (command.type === "set_model") {
      assert.deepEqual(
        { provider: command.provider, modelId: command.modelId },
        { provider: "other", modelId: "second" },
      );
      model = { provider: "other", id: "second", name: "Second", contextWindow: 256_000 };
      usage = { tokens: 12_000, contextWindow: 256_000, percent: 4.6875 };
      child.respond(command, { data: model });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  assert.deepEqual(await service.getAvailableModels(), [
    { provider: "test", id: "first", name: "First", contextWindow: 100_000 },
    { provider: "other", id: "second", name: "Second" },
  ]);
  await service.changeModel("other", "second");
  assert.deepEqual(service.snapshot().model, model);
  assert.deepEqual(service.snapshot().context, usage);
  assert.ok(child.commands.some((command) => command.type === "get_available_models"));
  assert.ok(child.commands.some((command) =>
    command.type === "set_model" && command.provider === "other" && command.modelId === "second",
  ));
  await service.stop();
});

test("failed or busy model changes do not overwrite Pi's current model", async () => {
  const { child, service } = setup();
  const original = { provider: "test", id: "unchanged", name: "Unchanged" };
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { model: original, isStreaming: false, isCompacting: false } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "set_model") {
      child.respond(command, { success: false, error: "Model unavailable." });
    } else {
      child.respond(command, { data: command.type === "prompt" ? { disposition: "started" } : undefined });
    }
  };
  await service.initialize();
  await assert.rejects(service.changeModel("other", "missing"), /Model unavailable/);
  assert.deepEqual(service.snapshot().model, original);
  assert.equal(await service.sendMessage("run"), "started");
  await assert.rejects(service.changeModel("other", "second"), /when the session is idle/);
  assert.equal(child.commands.some((command) => command.type === "set_model"), true);
  assert.equal(child.commands.filter((command) => command.type === "set_model").length, 1);
  await service.abort();
  await service.stop();
});

test("compact RPC timeout keeps messages queued until Pi confirms compaction has ended", async () => {
  const { child, service, events } = setup(20);
  let isCompacting = false;
  let compactCalls = 0;
  let stateCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      stateCalls++;
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "compact") {
      compactCalls++;
      isCompacting = true;
      child.emitRecord({ type: "compaction_start", reason: "manual" });
    } else if (command.type === "prompt") {
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  await service.compact();
  await waitFor(() => compactCalls === 1);
  await service.sendMessage("wait until Pi says ready", "timeout-queue");
  await waitFor(() => stateCalls >= 2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(service.snapshot().isCompacting, true);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id }) => id), ["timeout-queue"]);
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 0);
  assert.equal(events.some((event) => event.type === "queued_message_sent"), false);

  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "manual",
    result: { summary: "done", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
    aborted: false,
    willRetry: false,
  });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "timeout-queue",
  ));
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(events.filter((event) => event.type === "queued_message_sent" && event.id === "timeout-queue").length, 1);
  await service.stop();
});

test("a retrying compaction keeps the automatic-compaction queue until final completion", async () => {
  const { child, service, events } = setup();
  let isCompacting = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "prompt") {
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  await service.sendMessage("preserve through compaction retry", "retry-queue");
  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    errorMessage: "temporary summarization failure",
    willRetry: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(service.snapshot().isCompacting, true);
  assert.deepEqual(service.snapshot().queuedMessages.map(({ id }) => id), ["retry-queue"]);
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 0);
  assert.equal(events.some((event) => event.type === "queued_message_sent"), false);

  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "threshold",
    result: { summary: "success", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
    aborted: false,
    willRetry: false,
  });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "retry-queue",
  ));
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(events.filter((event) => event.type === "queued_message_sent" && event.id === "retry-queue").length, 1);
  await service.stop();
});

test("manual compaction uses Pi RPC and drains queued messages once, in FIFO order", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  let isCompacting = false;
  let tokenCount = 150_000;
  let compactCommand: Command | undefined;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, {
        data: {
          model: { provider: "test-provider", id: "model-one", name: "Model One" },
          isStreaming,
          isCompacting,
        },
      });
    } else if (command.type === "get_session_stats") {
      child.respond(command, {
        data: { contextUsage: { tokens: tokenCount, contextWindow: 200_000, percent: tokenCount / 2_000 } },
      });
    } else if (command.type === "compact") {
      compactCommand = command;
      isCompacting = true;
      child.emitRecord({ type: "compaction_start", reason: "manual" });
    } else if (command.type === "prompt") {
      isStreaming = true;
      child.emitRecord({ type: "agent_start" });
      child.respond(command, { data: { disposition: "started" } });
    } else if (command.type === "steer") {
      child.respond(command, { data: { disposition: "queued" } });
    } else if (command.type === "abort") {
      child.respond(command);
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  await service.compact();
  await waitFor(() => compactCommand !== undefined);
  assert.ok(child.commands.some((command) => command.type === "compact"));
  assert.equal(service.snapshot().isCompacting, true);
  await Promise.all([
    service.sendMessage("first queued message", "queue-1"),
    service.sendMessage("second queued message", "queue-2"),
  ]);
  assert.equal(service.snapshot().queuedMessages.map(({ id }) => id).join(","), "queue-1,queue-2");
  assert.equal(child.commands.some((command) => command.type === "prompt" || command.type === "steer"), false);
  await assert.rejects(service.abort(), /does not cancel compaction/);
  assert.equal(child.commands.some((command) => command.type === "abort"), false);

  isCompacting = false;
  tokenCount = 32_000;
  child.emitRecord({
    type: "compaction_end",
    reason: "manual",
    result: { tokensBefore: 150_000, estimatedTokensAfter: 30_000, summary: "not shown" },
    aborted: false,
    willRetry: false,
  });
  child.respond(compactCommand!, { data: { summary: "not shown" } });
  await waitFor(() => events.filter((event) => event.type === "queued_message_sent").length === 2);
  assert.deepEqual(child.commands
    .filter((command) => command.type === "prompt" || command.type === "steer")
    .map((command) => [command.type, command.message]), [
      ["prompt", "first queued message"],
      ["steer", "second queued message"],
    ]);
  assert.deepEqual(events.filter((event) => event.type === "queued_message_sent").map((event) => event.id), [
    "queue-1",
    "queue-2",
  ]);
  assert.equal(service.snapshot().context.tokens, 32_000);
  assert.equal(service.snapshot().isCompacting, false);
  await service.stop();
});

test("automatic compaction and failed or aborted endings clear state and retain usable queued messages", async () => {
  const { child, service, events } = setup();
  let isStreaming = false;
  let isCompacting = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } } });
    } else if (command.type === "prompt") {
      isStreaming = true;
      child.emitRecord({ type: "agent_start" });
      child.respond(command, { data: { disposition: "started" } });
    } else if (command.type === "steer") {
      child.respond(command, { data: { disposition: "queued" } });
    } else if (command.type === "abort") {
      child.respond(command);
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  assert.equal(service.snapshot().isCompacting, true);
  await service.sendMessage("survives automatic compaction", "auto-queue");
  isCompacting = false;
  child.emitRecord({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    errorMessage: "summary provider temporarily unavailable",
    willRetry: false,
  });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "auto-queue",
  ));
  assert.ok(events.some((event) =>
    event.type === "compaction_end" && !event.success && !event.aborted &&
    event.error?.includes("summary provider"),
  ));
  assert.ok(events.some((event) => event.type === "compaction_end" && event.error?.includes("summary provider") &&
    event.informational !== true));

  isStreaming = false;
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "overflow" });
  await service.sendMessage("survives aborted compaction", "abort-queue");
  isCompacting = false;
  child.emitRecord({ type: "compaction_end", reason: "overflow", aborted: true, willRetry: false });
  await waitFor(() => events.some((event) =>
    event.type === "queued_message_sent" && event.id === "abort-queue",
  ));
  assert.ok(events.some((event) => event.type === "compaction_end" && event.aborted));
  assert.equal(service.snapshot().isCompacting, false);
  await service.stop();
});

test("Pi's session-too-small compaction result is informational and leaves the session usable", async () => {
  const { child, service, events } = setup();
  let isCompacting = false;
  let compactCalls = 0;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: { tokens: 12_000, contextWindow: 200_000, percent: 6 } } });
    } else if (command.type === "compact") {
      compactCalls++;
      isCompacting = true;
      child.emitRecord({ type: "compaction_start", reason: "manual" });
      isCompacting = false;
      child.emitRecord({
        type: "compaction_end",
        reason: "manual",
        errorMessage: "Nothing to compact (session too small)",
        aborted: false,
        willRetry: false,
      });
      child.respond(command);
    } else if (command.type === "prompt") {
      child.respond(command, { data: { disposition: "started" } });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  await service.compact();
  await waitFor(() => events.some((event) => event.type === "compaction_end"));

  const end = events.find((event) => event.type === "compaction_end");
  assert.ok(end?.type === "compaction_end");
  assert.equal(end.success, false);
  assert.equal(end.informational, true);
  assert.equal(end.error, "Nothing to compact (session too small)");
  assert.equal(service.snapshot().isCompacting, false);
  assert.equal(service.state, "idle");
  assert.deepEqual(service.snapshot().context, { tokens: 12_000, contextWindow: 200_000, percent: 6 });
  assert.equal(compactCalls, 1);

  assert.equal(await service.sendMessage("session remains usable"), "started");
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(compactCalls, 1);
  await service.stop();
});

test("failed submission of a queued message is reported and removed without being retried", async () => {
  const { child, service, events } = setup();
  let isCompacting = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, { data: { isStreaming: false, isCompacting } });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "prompt") {
      child.respond(command, { success: false, error: "Pi rejected the queued prompt." });
    } else {
      child.respond(command);
    }
  };

  await service.initialize();
  isCompacting = true;
  child.emitRecord({ type: "compaction_start", reason: "threshold" });
  await service.sendMessage("keep me", "failed-queue");
  isCompacting = false;
  child.emitRecord({ type: "compaction_end", reason: "threshold", result: { summary: "done" }, aborted: false });
  await waitFor(() => events.some((event) => event.type === "queued_message_failed"));
  assert.ok(events.some((event) =>
    event.type === "queued_message_failed" &&
    event.id === "failed-queue" &&
    event.error.includes("rejected the queued prompt"),
  ));
  assert.equal(child.commands.filter((command) => command.type === "prompt").length, 1);
  assert.equal(service.snapshot().queuedMessages.length, 0);
  await service.stop();
});

test("Pi session discovery, transcript hydration, native new/rename/delete, and branch-safe switching", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-vot-sessions-"));
  const project = join(temporary, "project");
  const sessionDirectory = join(temporary, "pi-sessions");
  await mkdir(sessionDirectory, { recursive: true });
  const namedSession = join(sessionDirectory, "named.jsonl");
  const unnamedSession = join(sessionDirectory, "unnamed.jsonl");
  const unrelatedSession = join(sessionDirectory, "other-project.jsonl");
  const toolCallId = "tool-call-1";
  const userMessage = { role: "user", content: "Continue with the persisted session.", timestamp: 1 };
  const assistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Inspecting the stored transcript." },
      { type: "text", text: "The old assistant response." },
      { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "notes.md" } },
    ],
    provider: "test-provider",
    model: "old-model",
    timestamp: 2,
  };
  const toolResult = {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "Stored tool output." }],
    isError: false,
    timestamp: 3,
  };
  const writeSession = async (
    file: string,
    cwd: string,
    id: string,
    entries: unknown[] = [],
  ) => {
    const header = { type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd };
    await writeFile(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  };
  await writeSession(namedSession, project, "named-id", [
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: userMessage },
    { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-10-01T00:00:02.000Z", message: assistantMessage },
    { type: "message", id: "tool-1", parentId: "assistant-1", timestamp: "2026-10-01T00:00:03.000Z", message: toolResult },
    { type: "session_info", id: "name-1", parentId: "tool-1", timestamp: "2026-10-01T00:00:04.000Z", name: "Stored Pi name" },
  ]);
  await writeSession(unnamedSession, project, "unnamed-id", [
    { type: "message", id: "user-2", parentId: null, timestamp: "2026-10-01T00:00:05.000Z", message: { role: "user", content: "Fallback title from the first message.", timestamp: 5 } },
  ]);
  await writeSession(unrelatedSession, join(temporary, "elsewhere"), "unrelated-id", [
    { type: "message", id: "other-user", parentId: null, timestamp: "2026-10-01T00:00:06.000Z", message: { role: "user", content: "Must not leak.", timestamp: 6 } },
  ]);

  const child = new FakePiProcess();
  let currentFile = namedSession;
  let currentName: string | null = "Stored Pi name";
  let messages: unknown[] = [userMessage, assistantMessage, toolResult];
  let createdSessionCount = 0;
  child.onCommand = (command) => {
    void (async () => {
      if (command.type === "get_state") {
        child.respond(command, { data: {
          model: { provider: "test-provider", id: "current-model", name: "Current model", contextWindow: 128_000 },
          isStreaming: false,
          isCompacting: false,
          sessionFile: currentFile,
          sessionId: currentFile,
          sessionName: currentName,
        } });
      } else if (command.type === "get_session_stats") {
        child.respond(command, { data: { contextUsage: { tokens: 100, contextWindow: 128_000, percent: 1 } } });
      } else if (command.type === "get_messages") {
        child.respond(command, { data: { messages } });
      } else if (command.type === "switch_session") {
        currentFile = String(command.sessionPath);
        messages = currentFile === namedSession ? [userMessage, assistantMessage, toolResult] :
          currentFile === unnamedSession ? [{ role: "user", content: "Fallback title from the first message.", timestamp: 5 }] : [];
        currentName = currentFile === namedSession ? "Stored Pi name" : null;
        child.respond(command, { data: { cancelled: false } });
      } else if (command.type === "new_session") {
        currentFile = join(sessionDirectory, `created-${++createdSessionCount}.jsonl`);
        currentName = null;
        messages = [];
        await writeSession(currentFile, project, `created-${createdSessionCount}`);
        child.respond(command, { data: { cancelled: false } });
      } else if (command.type === "set_session_name") {
        currentName = String(command.name);
        await appendFile(currentFile, `${JSON.stringify({
          type: "session_info",
          id: `name-${createdSessionCount + 2}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          name: currentName,
        })}\n`);
        child.respond(command);
      } else {
        child.respond(command);
      }
    })();
  };
  const service = new PiService(
    project,
    () => child as unknown as ChildProcessWithoutNullStreams,
    undefined,
    { env: { PI_CODING_AGENT_DIR: join(temporary, "agent") }, home: join(temporary, "home") },
  );
  try {
    await service.initialize();
    let snapshot = service.snapshot();
    assert.equal(snapshot.activeSessionId, namedSession);
    assert.equal(snapshot.activeSessionName, "Stored Pi name");
    assert.ok(snapshot.sessions.some((session) => session.id === namedSession && session.name === "Stored Pi name"));
    assert.equal(snapshot.sessions.find((session) => session.id === namedSession)?.cwd, project);
    assert.ok(snapshot.sessions.some((session) =>
      session.id === unnamedSession && session.name === null && session.preview === "Fallback title from the first message.",
    ));
    assert.equal(snapshot.sessions.some((session) => session.id === unrelatedSession), true);
    assert.deepEqual(snapshot.transcript.map((item) => item.type), ["user", "assistant", "tool"]);
    assert.deepEqual(snapshot.transcript[1], {
      id: "history-1",
      type: "assistant",
      text: "The old assistant response.",
      thinking: "Inspecting the stored transcript.",
    });
    assert.equal(snapshot.transcript[2]?.type, "tool");
    if (snapshot.transcript[2]?.type === "tool") {
      assert.equal(snapshot.transcript[2].toolName, "read");
      assert.equal(snapshot.transcript[2].output, "Stored tool output.");
    }

    await service.switchSession(unnamedSession);
    snapshot = service.snapshot();
    assert.equal(snapshot.activeSessionId, unnamedSession);
    assert.equal(snapshot.transcript[0]?.type, "user");

    await service.newSession();
    snapshot = service.snapshot();
    const createdSession = snapshot.activeSessionId!;
    assert.equal(snapshot.transcript.length, 0);
    assert.equal(snapshot.model?.id, "current-model");
    assert.equal(snapshot.context.tokens, 100);
    assert.ok(snapshot.sessions.some((session) => session.id === createdSession));

    await service.renameSession(namedSession, "Renamed in Pi");
    assert.equal(service.snapshot().activeSessionId, createdSession);
    assert.equal(service.snapshot().sessions.find((session) => session.id === namedSession)?.name, "Renamed in Pi");
    assert.match(await readFile(namedSession, "utf8"), /"name":"Renamed in Pi"/);

    await service.deleteSession(unnamedSession);
    assert.equal(service.snapshot().sessions.some((session) => session.id === unnamedSession), false);
    await service.deleteSession(createdSession);
    assert.notEqual(service.snapshot().activeSessionId, createdSession);
    assert.equal(service.snapshot().sessions.some((session) => session.id === createdSession), false);
    assert.equal(service.snapshot().sessions.some((session) => session.id === namedSession), true);
    assert.ok(child.commands.some((command) => command.type === "new_session"));
    assert.ok(child.commands.some((command) => command.type === "switch_session" && command.sessionPath === unnamedSession));
    assert.ok(child.commands.some((command) => command.type === "set_session_name" && command.name === "Renamed in Pi"));
    assert.equal(child.commands.filter((command) => command.type === "new_session").length, 2);
    await stat(unnamedSession).then(
      () => assert.fail("The selected session file should have been removed."),
      () => undefined,
    );
    await stat(namedSession);
    await service.stop();
  } finally {
    await service.stop();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Pi session and project switching is blocked during active, compacting, and queued work", async () => {
  const { child, service } = setup();
  await service.initialize();
  const internalQueue = service as unknown as { queuedMessages: Array<{ id: string; message: string }> };
  internalQueue.queuedMessages.push({ id: "pending-after-compaction", message: "preserve me" });
  await assert.rejects(service.switchSession("/unused"), /queued post-compaction messages/);
  internalQueue.queuedMessages.length = 0;
  child.emitRecord({ type: "agent_start" });
  await assert.rejects(service.switchSession("/unused"), /Finish or stop/);
  await assert.rejects(service.changeProjectDirectory("/unused"), /Finish or stop/);
  child.emitRecord({ type: "agent_settled" });
  await waitFor(() => service.state === "idle");

  child.emitRecord({ type: "compaction_start", reason: "manual" });
  await assert.rejects(service.switchSession("/unused"), /Finish or stop/);
  await assert.rejects(service.changeProjectDirectory("/unused"), /Finish or stop/);
  await service.stop();
});

test("project changes restart one idle Pi runtime and discover only the new project's sessions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-vot-projects-"));
  const firstProject = join(temporary, "first");
  const secondProject = join(temporary, "second");
  const firstSession = join(firstProject, "sessions", "first.jsonl");
  const secondSession = join(secondProject, "sessions", "second.jsonl");
  const discoveryContext = {
    env: { PI_CODING_AGENT_DIR: join(temporary, "agent") },
    home: join(temporary, "home"),
  };
  await mkdir(join(firstProject, "sessions"), { recursive: true });
  await mkdir(join(secondProject, "sessions"), { recursive: true });
  const makeFile = async (file: string, cwd: string, id: string) => {
    await writeFile(file, `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-10-01T00:00:00.000Z",
      cwd,
    })}\n`);
  };
  await makeFile(firstSession, firstProject, "first-session");
  await makeFile(secondSession, secondProject, "second-session");
  const children: Array<{ cwd: string; child: FakePiProcess }> = [];
  const service = new PiService(firstProject, (cwd) => {
    const child = new FakePiProcess();
    children.push({ cwd, child });
    const activeFile = cwd === firstProject ? firstSession : secondSession;
    child.onCommand = (command) => {
      if (command.type === "get_state") {
        child.respond(command, { data: {
          isStreaming: false,
          isCompacting: false,
          sessionFile: activeFile,
          sessionId: activeFile,
        } });
      } else if (command.type === "get_session_stats") {
        child.respond(command, { data: { contextUsage: null } });
      } else if (command.type === "get_messages") {
        child.respond(command, { data: { messages: [] } });
      } else {
        child.respond(command);
      }
    };
    return child as unknown as ChildProcessWithoutNullStreams;
  }, undefined, discoveryContext);

  try {
    await service.initialize();
    assert.equal(children.length, 1);
    assert.equal(children[0]?.cwd, firstProject);
    assert.deepEqual(service.snapshot().sessions.map(({ id }) => id), [firstSession]);
    await service.changeProjectDirectory(secondProject);
    assert.equal(children.length, 2);
    assert.equal(children[0]?.child.exitCode, 0);
    assert.equal(children[1]?.cwd, secondProject);
    assert.equal(service.snapshot().projectDirectory, secondProject);
    assert.equal(service.snapshot().activeSessionId, secondSession);
    assert.deepEqual(service.snapshot().sessions.map(({ id }) => id), [secondSession]);
    assert.equal((await readFile(firstSession, "utf8")).includes("first-session"), true);
    await service.stop();
  } finally {
    await service.stop();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Pi session directory names preserve Windows drive and Unix path conventions", () => {
  assert.equal(piSessionDirectoryName("C:\\Users\\Alice\\repo"), "--C--Users-Alice-repo--");
  assert.equal(piSessionDirectoryName("C:\\Users\\Alice\\My Project"), "--C--Users-Alice-My Project--");
  assert.equal(piSessionDirectoryName("/home/alice/repo"), "--home-alice-repo--");
  assert.equal(piSessionDirectoryName("/home/alice/my project"), "--home-alice-my project--");
  assert.equal(piSessionDirectoryName("D:/src/repo"), "--D--src-repo--");
  assert.equal(piSessionDirectoryName("D:/src/My Project"), "--D--src-My Project--");
});

test("Pi session directory fallback follows environment and settings precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-dir-"));
  const cwd = join(root, "My Project");
  const home = join(root, "home");
  const agentDir = join(root, "custom-agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });

  try {
    assert.equal(
      await resolvePiSessionDirectory(cwd, {}, home),
      join(home, ".pi", "agent", "sessions", piSessionDirectoryName(cwd)),
    );
    assert.equal(
      await resolvePiSessionDirectory(cwd, { PI_CODING_AGENT_DIR: agentDir }, home),
      join(agentDir, "sessions", piSessionDirectoryName(cwd)),
    );

    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: join(root, "global-sessions") }),
    );
    assert.equal(
      await resolvePiSessionDirectory(cwd, { PI_CODING_AGENT_DIR: agentDir }, home),
      join(root, "global-sessions"),
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ sessionDir: "relative sessions" }),
    );
    assert.equal(
      await resolvePiSessionDirectory(cwd, { PI_CODING_AGENT_DIR: agentDir }, home),
      join(cwd, "relative sessions"),
    );
    assert.equal(
      await resolvePiSessionDirectory(
        cwd,
        {
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: "~/environment sessions",
        },
        home,
      ),
      join(home, "environment sessions"),
    );
    assert.equal(
      await resolvePiSessionDirectory(
        cwd,
        { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(root, "env-sessions") },
        home,
      ),
      join(root, "env-sessions"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi discovers sessions from configured storage before the active session has a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-discovery-"));
  const cwd = join(root, "project");
  const configuredDirectory = join(root, "configured-sessions");
  const authoritativeDirectory = join(root, "actual-sessions");
  const discoveredSession = join(configuredDirectory, "existing.jsonl");
  const authoritativeSession = join(authoritativeDirectory, "actual.jsonl");
  await mkdir(configuredDirectory, { recursive: true });
  await mkdir(authoritativeDirectory, { recursive: true });
  await writeFile(
    discoveredSession,
    `${JSON.stringify({ type: "session", id: "existing", cwd })}\n${JSON.stringify({
      type: "message",
      message: { role: "user", content: "Stored in custom session directory" },
    })}\n`,
  );
  await writeFile(
    authoritativeSession,
    `${JSON.stringify({ type: "session", id: "actual", cwd })}\n${JSON.stringify({
      type: "message",
      message: { role: "user", content: "Actual RPC session file directory" },
    })}\n`,
  );
  const discoveryContext = {
    env: {
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_CODING_AGENT_SESSION_DIR: configuredDirectory,
    },
    home: join(root, "home"),
  };
  const child = new FakePiProcess();
  let exposeSessionFile = false;
  child.onCommand = (command) => {
    if (command.type === "get_state") {
      child.respond(command, {
        data: {
          isStreaming: false,
          sessionId: "new-empty-session",
          ...(exposeSessionFile ? { sessionFile: authoritativeSession } : {}),
        },
      });
    } else if (command.type === "get_session_stats") {
      child.respond(command, { data: { contextUsage: null } });
    } else if (command.type === "get_messages") {
      child.respond(command, { data: { messages: [] } });
    } else {
      child.respond(command);
    }
  };
  const service = new PiService(
    cwd,
    () => child as unknown as ChildProcessWithoutNullStreams,
    undefined,
    discoveryContext,
  );

  try {
    discoveryContext.env.PI_CODING_AGENT_SESSION_DIR = join(root, "changed-after-construction");
    await service.initialize();
    assert.deepEqual(service.snapshot().sessions.map(({ id }) => id), [discoveredSession]);
    exposeSessionFile = true;
    await service.refreshPersistedState();
    assert.deepEqual(
      new Set(service.snapshot().sessions.map(({ id }) => id)),
      new Set([discoveredSession, authoritativeSession]),
    );
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("all-project discovery honors native roots, header cwd, bounded metadata, and corrupt entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-all-projects-"));
  const agentDirectory = join(root, "agent");
  const defaultSessions = join(agentDirectory, "sessions");
  const sharedSessions = join(root, "shared");
  const globalSessions = join(root, "global");
  const projectSessions = join(root, "project-specific");
  const knownCustomSessions = join(root, "known-custom-session-store");
  const currentCwd = join(root, "current");
  const otherCwd = join(root, "other");
  const knownCustomCwd = join(root, "known-custom-project");
  const thirdCwd = join(root, "third");
  await Promise.all([
    mkdir(defaultSessions, { recursive: true }),
    mkdir(sharedSessions, { recursive: true }),
    mkdir(globalSessions, { recursive: true }),
    mkdir(knownCustomSessions, { recursive: true }),
    mkdir(currentCwd, { recursive: true }),
    mkdir(otherCwd, { recursive: true }),
    mkdir(knownCustomCwd, { recursive: true }),
    mkdir(thirdCwd, { recursive: true }),
  ]);
  const writeSession = async (directory: string, filename: string, cwd: string, name?: string) => {
    await mkdir(directory, { recursive: true });
    const file = join(directory, filename);
    await writeFile(file, [
      JSON.stringify({ type: "session", id: filename, cwd }),
      ...(name ? [JSON.stringify({ type: "session_info", name })] : []),
      JSON.stringify({
        type: "message",
        id: `${filename}-user`,
        message: { role: "user", content: "Persisted project history" },
      }),
      JSON.stringify({
        type: "message",
        id: `${filename}-assistant`,
        message: {
          role: "assistant",
          provider: "stored-provider",
          model: "stored-model",
          content: [
            { type: "thinking", thinking: "Stored reasoning" },
            { type: "text", text: "Stored Markdown **answer**" },
          ],
        },
      }),
    ].join("\n") + "\n");
    return file;
  };
  const misleadingPath = join(defaultSessions, piSessionDirectoryName(otherCwd));
  const defaultSession = await writeSession(misleadingPath, "default.jsonl", currentCwd, "Default session");
  const sharedCurrent = await writeSession(sharedSessions, "shared-current.jsonl", currentCwd);
  const sharedOther = await writeSession(sharedSessions, "shared-other.jsonl", otherCwd);
  const knownCustomSession = await writeSession(knownCustomSessions, "custom-only.jsonl", knownCustomCwd);
  const globalSession = await writeSession(globalSessions, "global.jsonl", thirdCwd);
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({ sessionDir: globalSessions }));
  await mkdir(join(currentCwd, ".pi"), { recursive: true });
  await writeFile(join(currentCwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: projectSessions }));
  await mkdir(join(knownCustomCwd, ".pi"), { recursive: true });
  await writeFile(join(knownCustomCwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: knownCustomSessions }));
  const projectSession = await writeSession(projectSessions, "project-specific.jsonl", currentCwd);
  await writeFile(join(sharedSessions, "corrupt.jsonl"), "{not-json}\n");
  try {
    const sessions = await discoverPiSessions(currentCwd, {
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_CODING_AGENT_SESSION_DIR: sharedSessions,
    }, root, [], [knownCustomCwd]);
    assert.deepEqual(new Set(sessions.map(({ id }) => id)), new Set([
      defaultSession,
      sharedCurrent,
      sharedOther,
      knownCustomSession,
      globalSession,
      projectSession,
    ]));
    assert.equal(sessions.find(({ id }) => id === defaultSession)?.cwd, currentCwd);
    assert.equal(sessions.find(({ id }) => id === sharedOther)?.cwd, otherCwd);
    const history = await hydratePiSession(sessions.find(({ id }) => id === sharedOther)!);
    assert.equal(history.session.cwd, otherCwd);
    assert.equal(history.model?.id, "stored-model");
    assert.deepEqual(history.transcript.map(({ type }) => type), ["user", "assistant"]);
    assert.equal(history.transcript[1]?.type, "assistant");
    if (history.transcript[1]?.type === "assistant") {
      assert.equal(history.transcript[1].thinking, "Stored reasoning");
      assert.equal(history.transcript[1].text, "Stored Markdown **answer**");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
