import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createPaneServer, DEFAULT_PORT, listenLocal, resolvePort } from "../src/server.ts";
import type { PiVotEvent, PiVotSnapshot } from "../src/pi-service.ts";

class FakeService {
  state = "idle";
  messages: string[] = [];
  imageRequests: Array<{ message: string; images: Array<{ mimeType: string; data: string; name?: string }> }> = [];
  messageModes: Array<"send" | "queue" | "steer" | undefined> = [];
  aborts = 0;
  browserTestResets = 0;
  messageTargets: Array<string | undefined> = [];
  queuedIds = ["queued-a", "queued-b"];
  newSessionMessages: Array<{ directory: string; sessionId: string | undefined }> = [];
  abortTargets: Array<string | undefined> = [];
  compactions = 0;
  modelListTargets: string[] = [];
  promptTemplateTargets: string[] = [];
  modelChanges: Array<{ sessionId: string; provider: string; modelId: string }> = [];
  projectModelRequests: Array<{ directory: string; provider?: string; modelId?: string }> = [];
  historyRequests: Array<{ sessionId: string; beforeId: string; revision: string }> = [];
  sessionActions: string[] = [];
  wakeTargets: string[] = [];
  wakeError?: string;
  projectDirectory = "/fake/project";
  listeners = new Set<(event: PiVotEvent) => void>();

  subscribe(listener: (event: PiVotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resetForBrowserTest(): void {
    this.browserTestResets++;
  }

  async sendMessage(
    message: string,
    _messageId?: string,
    sessionId?: string,
    images: Array<{ mimeType: string; data: string; name?: string }> = [],
    mode?: "send" | "queue" | "steer",
  ): Promise<string> {
    this.messages.push(message);
    this.imageRequests.push({
      message,
      images: images.map(({ mimeType, data, name }) => ({ mimeType, data, ...(name ? { name } : {}) })),
    });
    this.messageTargets.push(sessionId);
    this.messageModes.push(mode);
    return this.state === "running" ? "steered" : "started";
  }

  async sendNewSessionMessage(
    message: string,
    messageId: string,
    sessionId: string | undefined,
    images: Array<{ mimeType: string; data: string; name?: string }>,
    mode: "send" | "queue" | "steer" | undefined,
    directory: string,
  ): Promise<{ disposition: string; sessionId: string }> {
    const target = sessionId ?? `${directory}/deferred.jsonl`;
    this.newSessionMessages.push({ directory, sessionId });
    const disposition = await this.sendMessage(message, messageId, target, images, mode);
    return { disposition, sessionId: target };
  }

  snapshot(): PiVotSnapshot {
    return {
      state: this.state as PiVotSnapshot["state"],
      isCompacting: false,
      context: { tokens: null, contextWindow: null, percent: null },
      model: null,
      queuedMessages: [],
      projectDirectory: this.projectDirectory,
      activeSessionId: null,
      activeSessionName: null,
      sessions: [],
      transcript: [],
    };
  }

  async abort(sessionId?: string): Promise<void> {
    this.aborts++;
    this.abortTargets.push(sessionId);
  }

  async cancelQueuedMessage(messageId: string, sessionId?: string): Promise<boolean> {
    this.messageTargets.push(sessionId);
    const index = this.queuedIds.indexOf(messageId);
    if (index < 0) return false;
    this.queuedIds.splice(index, 1);
    this.emit({ type: "queued_message_cancelled", id: messageId, sessionId });
    return true;
  }

  async clearQueuedMessages(sessionId?: string): Promise<string[]> {
    const cancelledIds = [...this.queuedIds];
    this.queuedIds = [];
    for (const id of cancelledIds)
      this.emit({ type: "queued_message_cancelled", id, sessionId });
    return cancelledIds;
  }

  async compact(): Promise<void> {
    this.compactions++;
  }

  async getAvailableModels(sessionId: string) {
    this.modelListTargets.push(sessionId);
    return {
      sessionId,
      hasRuntime: true,
      model: { provider: "test", id: "current", name: "Current" },
      models: [{ provider: "test", id: "next", name: "Next" }],
      canChange: true,
    };
  }

  async getPromptTemplates(sessionId: string) {
    this.promptTemplateTargets.push(sessionId);
    return {
      sessionId,
      hasRuntime: true,
      commands: [{ name: "review", description: "Review the requested changes." }],
    };
  }

  async getProjectAvailableModels(directory: string) {
    this.projectModelRequests.push({ directory });
    return { projectDirectory: directory, sessionId: "", hasRuntime: true,
      model: { provider: "test", id: "next", name: "Next" },
      models: [{ provider: "test", id: "next", name: "Next" }], canChange: true };
  }

  async changeProjectModel(directory: string, provider: string, modelId: string) {
    this.projectModelRequests.push({ directory, provider, modelId });
    return { projectDirectory: directory, model: { provider, id: modelId, name: modelId } };
  }

  async getOlderTranscriptPage(sessionId: string, beforeId: string, revision: string) {
    this.historyRequests.push({ sessionId, beforeId, revision });
    return {
      sessionId,
      historyRevision: revision,
      items: [{ id: "older-1", type: "user" as const, text: "Earlier message" }],
      hasOlder: false,
    };
  }

  async changeModel(sessionId: string, provider: string, modelId: string) {
    this.modelChanges.push({ sessionId, provider, modelId });
    return {
      sessionId,
      model: { provider, id: modelId, name: modelId },
      context: { tokens: null, contextWindow: 256_000, percent: null },
    };
  }

  async refreshPersistedState(): Promise<void> {
    this.sessionActions.push("refresh");
  }

  async switchSession(sessionId: string): Promise<void> {
    this.sessionActions.push(`switch:${sessionId}`);
  }

  async wakeSession(sessionId: string): Promise<void> {
    this.wakeTargets.push(sessionId);
    this.sessionActions.push(`wake:${sessionId}`);
    if (this.wakeError) throw new Error(this.wakeError);
  }

  async newSession(): Promise<void> {
    this.sessionActions.push("new");
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    this.sessionActions.push(`rename:${sessionId}:${name}`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessionActions.push(`delete:${sessionId}`);
  }

  async releaseRuntime(sessionId: string): Promise<void> {
    this.sessionActions.push(`release:${sessionId}`);
  }

  async changeProjectDirectory(directory: string): Promise<void> {
    this.projectDirectory = directory;
    this.sessionActions.push(`project:${directory}`);
  }

  emit(event: PiVotEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

async function withServer(callback: (url: string, service: FakeService) => Promise<void>): Promise<void> {
  const service = new FakeService();
  const app = createPaneServer(service);
  await new Promise<void>((resolve) => listenLocal(app.server, 0, resolve));
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  try {
    await callback(`http://127.0.0.1:${address.port}`, service);
  } finally {
    app.closeEvents();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
}

test("browser test reset requests are handled by one server route", async () => {
  await withServer(async (url, service) => {
    const response = await fetch(`${url}/__test__/reset`, { method: "POST" });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(service.browserTestResets, 1);
  });
});

function postWithHost(url: string, host: string, body: string, origin?: string): Promise<number> {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      host,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    if (origin) headers.origin = origin;
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/api/message",
      method: "POST",
      headers,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function getWithHost(url: string, path: string, host: string): Promise<number> {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      method: "GET",
      headers: { host },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      response.destroy();
    });
    request.once("error", reject);
    request.end();
  });
}

test("HTTP commands validate input, route sends and stop separately, and report state", async () => {
  await withServer(async (url, service) => {
    const invalid = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });

    assert.equal(invalid.status, 400);

    service.state = "running";
    const sent = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "redirect this run", sessionId: "/project/session-a.jsonl", mode: "steer" }),
    });
    assert.equal(sent.status, 202);
    const sendResult = await sent.json();
    assert.equal(sendResult.disposition, "steered");
    assert.match(sendResult.messageId, /^[\da-f-]{36}$/i);
    assert.deepEqual(service.messages, ["redirect this run"]);
    assert.deepEqual(service.messageTargets, ["/project/session-a.jsonl"]);
    assert.deepEqual(service.messageModes, ["steer"]);

    const pending = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "start in chosen project",
        projectDirectory: "/project/chosen",
      }),
    });
    assert.equal(pending.status, 202);
    const pendingResult = await pending.json();
    assert.equal(pendingResult.sessionId, "/project/chosen/deferred.jsonl");
    assert.deepEqual(service.newSessionMessages, [{
      directory: "/project/chosen",
      sessionId: undefined,
    }]);
    assert.deepEqual(service.messageTargets.at(-1), "/project/chosen/deferred.jsonl");

    const stopped = await fetch(`${url}/api/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "/project/session-a.jsonl" }),
    });
    assert.equal(stopped.status, 202);
    assert.equal(service.aborts, 1);
    assert.deepEqual(service.abortTargets, ["/project/session-a.jsonl"]);
    const compacted = await fetch(`${url}/api/compact`, { method: "POST" });
    assert.equal(compacted.status, 202);
    assert.deepEqual(await compacted.json(), { ok: true });
    assert.equal(service.compactions, 1);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.state, "running");
    assert.equal(health.isCompacting, false);
  });
});

test("HTTP queue controls cancel one message or clear the waiting group", async () => {
  await withServer(async (url, service) => {
    const one = await fetch(`${url}/api/queue/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "queued-a", sessionId: "/project/session-a.jsonl" }),
    });
    assert.equal(one.status, 200);
    assert.deepEqual((await one.json()).cancelledIds, ["queued-a"]);
    assert.deepEqual(service.queuedIds, ["queued-b"]);

    const all = await fetch(`${url}/api/queue/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "/project/session-a.jsonl" }),
    });
    assert.equal(all.status, 200);
    assert.deepEqual((await all.json()).cancelledIds, ["queued-b"]);
    assert.deepEqual(service.queuedIds, []);
  });
});

test("model routes require protected JSON and target the requested runtime", async () => {
  await withServer(async (url, service) => {
    const models = await fetch(`${url}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "/project/session-a.jsonl" }),
    });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).models[0].id, "next");
    assert.deepEqual(service.modelListTargets, ["/project/session-a.jsonl"]);

    const changed = await fetch(`${url}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "/project/session-a.jsonl", provider: "test", modelId: "next" }),
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).context.contextWindow, 256_000);
    assert.deepEqual(service.modelChanges, [{
      sessionId: "/project/session-a.jsonl",
      provider: "test",
      modelId: "next",
    }]);

    const unsupported = await fetch(`${url}/api/models`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(unsupported.status, 415);
  });
});

test("prompt template discovery requires a protected request and targets the selected runtime", async () => {
  await withServer(async (url, service) => {
    const response = await fetch(`${url}/api/prompt-templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "/project/session-a.jsonl" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).commands, [
      { name: "review", description: "Review the requested changes." },
    ]);
    assert.deepEqual(service.promptTemplateTargets, ["/project/session-a.jsonl"]);

    const invalid = await fetch(`${url}/api/prompt-templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(invalid.status, 400);
  });
});

test("model routes support a project target when directory browsing has no selected session", async () => {
  await withServer(async (url, service) => {
    const models = await fetch(`${url}/api/models`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDirectory: "/fake/other" }),
    });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).models[0].id, "next");
    assert.deepEqual(service.projectModelRequests, [{ directory: "/fake/other" }]);
    const changed = await fetch(`${url}/api/model`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDirectory: "/fake/other", provider: "test", modelId: "next" }),
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(service.projectModelRequests[1], {
      directory: "/fake/other", provider: "test", modelId: "next",
    });
  });
});

test("history route requires a session-bound stable cursor and returns only the requested page", async () => {
  await withServer(async (url, service) => {
    const query = new URLSearchParams({
      sessionId: "/project/session-a.jsonl",
      beforeId: "message-100",
      revision: "history-v1",
    });
    const response = await fetch(`${url}/api/history?${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: "/project/session-a.jsonl",
      historyRevision: "history-v1",
      items: [{ id: "older-1", type: "user", text: "Earlier message" }],
      hasOlder: false,
    });
    assert.deepEqual(service.historyRequests, [{
      sessionId: "/project/session-a.jsonl",
      beforeId: "message-100",
      revision: "history-v1",
    }]);

    const missingCursor = await fetch(`${url}/api/history?sessionId=%2Fproject%2Fsession-a.jsonl`);
    assert.equal(missingCursor.status, 400);
  });
});

test("message route validates image data and forwards supported image payloads", async () => {
  await withServer(async (url, service) => {
    const post = (value: unknown) => fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const unsupported = await post({
      message: "reject",
      images: [{ mimeType: "application/pdf", data: "JVBERi0=" }],
    });
    assert.equal(unsupported.status, 400);
    assert.match((await unsupported.json()).error, /Unsupported image type/);
    assert.deepEqual(service.messages, []);

    const malformed = await post({
      message: "reject",
      images: [{ mimeType: "image/png", data: "not base64!" }],
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /malformed/);

    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const accepted = await post({
      message: "describe",
      images: [{ mimeType: "image/png", data: image, name: "screen.png" }],
      sessionId: "/project/session-a.jsonl",
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(service.imageRequests, [{
      message: "describe",
      images: [{ mimeType: "image/png", data: image, name: "screen.png" }],
    }]);

    const imageOnly = await post({ images: [{ mimeType: "image/png", data: image }] });
    assert.equal(imageOnly.status, 202);
    assert.equal(service.messages.at(-1), "");
  });
});

test("static browser assets are served from the explicit asset list only", async () => {
  await withServer(async (url) => {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(page.headers.get("content-security-policy"),
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("permissions-policy"),
      "clipboard-read=(self), clipboard-write=(self), camera=(), microphone=(), geolocation=()");
    const html = await page.text();
    assert.match(html, /href="\/style\.css"/);
    assert.match(html, /accept="image\/\*" multiple/);
    const main = await fetch(`${url}/main.js`);
    assert.match(main.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(await main.text(), /new EventSource\("\/api\/events"\)/);
    const css = await fetch(`${url}/style.css`);
    assert.match(css.headers.get("x-content-type-options") ?? "", /nosniff/);
    assert.match(await css.text(), /#app-shell/);
    const marked = await fetch(`${url}/vendor/marked.umd.js`);
    assert.match(marked.headers.get("referrer-policy") ?? "", /no-referrer/);
    assert.match(await marked.text(), /marked/);
    assert.match((await (await fetch(`${url}/vendor/highlight.min.js`)).text()).slice(0, 100), /highlight\.js/i);
    assert.match((await (await fetch(`${url}/markdown-security.js`)).text()), /safeMarkdownHref/);
    const help = await fetch(`${url}/help.md`);
    assert.match(help.headers.get("content-type") ?? "", /^text\/markdown/);
    assert.match(await help.text(), /Send, Steer, and Queue/);
    const health = await fetch(`${url}/api/health`);
    assert.match(health.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);

    for (const path of ["/package.json", "/src/server.ts", "/..%2fsrc%2fserver.ts", "/vendor/../package.json"]) {
      assert.equal((await fetch(`${url}${path}`)).status, 404);
    }
  });
});

test("mutation endpoints require a local Host and reject foreign Origins", async () => {
  await withServer(async (url, service) => {
    const port = new URL(url).port;
    const body = JSON.stringify({ message: "safe local request" });
    const accepted = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        origin: `http://127.0.0.1:${port}`,
      },
      body,
    });

    assert.equal(accepted.status, 202);

    assert.equal(
      await postWithHost(url, `localhost:${port}`, body, `http://localhost:${port}`),
      202,
    );

    const noOrigin = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(noOrigin.status, 202);

    const foreignOrigin = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://malicious.example",
      },
      body,
    });
    assert.equal(foreignOrigin.status, 403);
    assert.match((await foreignOrigin.json()).error, /local origin/);

    assert.equal(await postWithHost(url, `malicious.example:${port}`, body), 403);
    assert.equal(await postWithHost(url, `127.0.0.1:${port + 1}`, body), 403);
    assert.equal(service.messages.length, 3);

    const deniedStop = await fetch(`${url}/api/stop`, {
      method: "POST",
      headers: { origin: `http://localhost:${Number(port) + 1}` },
    });
    assert.equal(deniedStop.status, 403);
    assert.equal(service.aborts, 0);
  });
});

test("API reads require the exact local Host authority", async () => {
  await withServer(async (url) => {
    const port = Number(new URL(url).port);
    for (const path of ["/api/health", "/api/events"]) {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
        assert.equal(await getWithHost(url, path, host), 200, `${path} rejected Host ${host}`);
      }
    }
    for (const path of ["/api/health", "/api/events"]) {
      for (const host of [
        `malicious.example:${port}`,
        `127.0.0.1:${port + 1}`,
      ]) {
        assert.equal(await getWithHost(url, path, host), 403, `${path} accepted Host ${host}`);
      }
    }
  });
});

test("PI_VOT_PORT is the only port override and preserves numeric conversion behavior", () => {
  assert.equal(DEFAULT_PORT, 17_361);
  assert.equal(resolvePort({}), DEFAULT_PORT);
  assert.equal(resolvePort({ PI_VOT_PORT: "18000" }), 18_000);
  assert.equal(resolvePort({ PORT: "18000" }), DEFAULT_PORT);
  assert.equal(resolvePort({ PI_PANE_PORT: "18000" }), DEFAULT_PORT);
  assert.equal(resolvePort({ PORT: "17000", PI_VOT_PORT: "18000" }), 18_000);
  assert.equal(resolvePort({ PORT: "17000", PI_PANE_PORT: "18000" }), DEFAULT_PORT);
  assert.ok(Number.isNaN(resolvePort({ PI_VOT_PORT: "invalid" })));
  assert.equal(resolvePort({ PI_VOT_PORT: "" }), 0);
});

test("message mutation requires JSON content type before parsing", async () => {
  await withServer(async (url, service) => {
    const unsupported = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"message":"not accepted"}',
    });
    assert.equal(unsupported.status, 415);
    assert.equal(service.messages.length, 0);

    const accepted = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ message: "valid JSON" }),
    });
    assert.equal(accepted.status, 202);
  });
});

test("session and project routes validate their payloads and invoke the service boundary", async () => {
  await withServer(async (url, service) => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await post("/api/sessions/switch", { sessionId: "/project/session.jsonl" })).status, 200);
    const wake = await post("/api/sessions/wake", { sessionId: "/project/explicit-target.jsonl" });
    assert.equal(wake.status, 200);
    assert.equal((await wake.json()).state, "idle");
    assert.deepEqual(service.wakeTargets, ["/project/explicit-target.jsonl"]);
    assert.equal((await post("/api/sessions/new", {})).status, 200);
    assert.equal((await post("/api/sessions/rename", { sessionId: "/project/session.jsonl", name: "renamed" })).status, 200);
    assert.equal((await post("/api/sessions/delete", { sessionId: "/project/session.jsonl" })).status, 200);
    assert.equal((await post("/api/sessions/release", { sessionId: "/project/session.jsonl" })).status, 200);
    assert.equal((await post("/api/sessions/refresh", {})).status, 200);
    assert.equal((await post("/api/project/select", { directory: "/fake/new-project" })).status, 200);
    assert.deepEqual(service.sessionActions, [
      "switch:/project/session.jsonl",
      "wake:/project/explicit-target.jsonl",
      "new",
      "rename:/project/session.jsonl:renamed",
      "delete:/project/session.jsonl",
      "release:/project/session.jsonl",
      "refresh",
      "project:/fake/new-project",
    ]);

    const missingId = await post("/api/sessions/switch", {});
    assert.equal(missingId.status, 400);
    assert.equal((await post("/api/sessions/wake", { sessionId: "   " })).status, 400);
    service.wakeError = "Four Pi sessions are already active. Stop or release one before starting another.";
    const atCapacity = await post("/api/sessions/wake", { sessionId: "/project/capacity.jsonl" });
    assert.equal(atCapacity.status, 409);
    assert.match((await atCapacity.json()).error, /Four Pi sessions are already active/);
    service.wakeError = undefined;
    const unsupportedWakeType = await fetch(`${url}/api/sessions/wake`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(unsupportedWakeType.status, 415);
    const foreign = await post("/api/sessions/delete", { sessionId: "/project/session.jsonl" }, {
      origin: "https://malicious.example",
    });
    assert.equal(foreign.status, 403);
    const foreignWake = await post("/api/sessions/wake", { sessionId: "/project/foreign.jsonl" }, {
      origin: "https://malicious.example",
    });
    assert.equal(foreignWake.status, 403);
    assert.deepEqual(service.wakeTargets, [
      "/project/explicit-target.jsonl",
      "/project/capacity.jsonl",
    ]);
    assert.equal(service.sessionActions.length, 9);
  });
});

test("SSE streams normalized application events and sends a state snapshot", async () => {
  await withServer(async (url, service) => {
    const response = await fetch(`${url}/api/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const readUntil = async (pattern: RegExp): Promise<string> => {
      while (!pattern.test(buffered)) {
        const next = await reader.read();
        assert.equal(next.done, false, "SSE stream ended before the expected event arrived");
        buffered += decoder.decode(next.value, { stream: true });
      }
      const text = buffered;
      buffered = "";
      return text;
    };
    const snapshot = await readUntil(/"type":"snapshot","state":"idle"/);
    assert.match(snapshot, /"type":"snapshot","state":"idle"/);

    service.emit({ type: "assistant_delta", messageId: "assistant-1", text: "live" });
    const update = await readUntil(/"type":"assistant_delta"/);
    assert.match(update, /"type":"assistant_delta"/);
    assert.match(update, /"text":"live"/);
    await reader.cancel();
  });
});
