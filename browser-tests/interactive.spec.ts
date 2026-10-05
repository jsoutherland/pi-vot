import { expect, test } from "@playwright/test";

const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/BkAAAAASUVORK5CYII=",
  "base64",
);

function imageFile(name: string) {
  return { name, mimeType: "image/png", buffer: TEST_PNG };
}

test("migrates legacy browser preferences to canonical Pi-vot storage keys", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pi-pane-collapsed-session-groups", JSON.stringify(["/fake/project"]));
    localStorage.setItem("pi-pane-composer-height", "180");
  });
  await page.goto("/");

  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-vot-collapsed-session-groups")))
    .toBe(JSON.stringify(["/fake/project"]));
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-vot-composer-height"))).toBe("180");
  expect(await page.evaluate(() => localStorage.getItem("pi-pane-collapsed-session-groups"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("pi-pane-composer-height"))).toBeNull();
});

test.afterEach(async ({ page }) => {
  if (page.url()) await page.request.post("/api/stop");
});

test("the sidebar permits four active runtimes and reports the fifth activation limit", async ({ page }) => {
  await page.goto("/");
  const refresh = page.getByRole("button", { name: "Refresh sessions" });
  await refresh.click();
  await refresh.click();
  await expect(page.locator(".session-row")).toHaveCount(5);

  const input = page.getByLabel("Message Pi");
  for (const title of ["HDF5 debugging", "Created in terminal Pi 1", "Created in terminal Pi 2"]) {
    const row = page.locator(".session-row").filter({ hasText: title });
    await row.locator(".session-switch").click();
    await expect(row.locator(".session-active-dot")).toBeHidden();
    await input.fill(`activate ${title}`);
    await input.press("Enter");
    await expect(row.locator(".session-active-dot")).toBeVisible();
  }
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(4);

  const fifth = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  await fifth.locator(".session-switch").click();
  await expect(fifth.locator(".session-active-dot")).toBeHidden();
  await page.locator("#image-picker").setInputFiles(imageFile("capacity.png"));
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  await input.fill("preserve at capacity");
  await input.press("Enter");
  await expect(page.locator("#status")).toContainText("Four Pi sessions are already active");
  await expect(input).toHaveValue("preserve at capacity");
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(4);
});

test("inactive history can be browsed without activating it", async ({ page }) => {
  await page.goto("/");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.locator(".message.user").first().locator(".image-message-placeholder")).toHaveText("[Image attachment]");
  await expect(page.locator(".message.user").first().locator(".image-message-attachments img")).toHaveCount(0);
  await expect(page.locator(".assistant-text h2")).toHaveText("Persisted heading");
  await expect(historical.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(1);
  await expect(page.locator("#context-value")).toContainText("Context unavailable");
  await page.locator(".session-row").filter({ hasText: "Find a parser regression" }).locator(".session-switch").click();
  await expect(page.locator(".session-active-dot:visible")).toHaveCount(1);
  await expect(page.locator(".message.user").first()).toContainText("Find a parser regression");
});

test("Wake activates selected history without sending, adding transcript, or clearing attachments", async ({ page }) => {
  await page.goto("/");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compact" })).toBeDisabled();
  await expect(page.locator("#context-value")).toContainText("Context unavailable");

  await page.locator("#image-picker").setInputFiles(imageFile("wake-keeps-image.png"));
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  const messagesBefore = await page.locator("#conversation .message").count();
  await page.getByRole("button", { name: "Wake", exact: true }).click();

  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled();
  await expect(historical.locator(".session-active-dot")).toBeVisible();
  await expect(page.locator("#context-value")).toHaveText("80,000 / 200,000");
  await expect(page.locator("#context-percent")).toHaveText("40%");
  await expect(page.getByRole("button", { name: /Current model: fake-provider \/ fake-model/ })).toBeEnabled();
  await expect(page.locator(".image-attachment")).toHaveCount(1);
  await expect(page.locator("#conversation .message")).toHaveCount(messagesBefore);
});

test("session menu Wake uses runtime activation and disappears once live", async ({ page }) => {
  await page.goto("/");
  const historical = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historical.locator(".session-switch").click();
  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeVisible();
  await historical.locator(".session-actions summary").click();
  await historical.getByRole("button", { name: "Wake session HDF5 debugging" }).click();

  await expect(historical.locator(".session-active-dot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Wake", exact: true })).toBeHidden();
  await historical.locator(".session-actions summary").click();
  await expect(historical.getByRole("button", { name: "Wake session HDF5 debugging" })).toHaveCount(0);
  await expect(page.locator("#conversation .message.user")).toHaveCount(2);
});

test("composer stays viewport-safe with stable splitter sizing and bottom-aligned actions", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto("/");
  const splitter = page.getByRole("separator", { name: "Resize message composer" });
  const form = page.locator("#message-form");
  const textarea = page.getByLabel("Message Pi");
  const send = page.getByRole("button", { name: "Send" });
  await expect(splitter).toHaveAttribute("aria-orientation", "horizontal");
  const initialLayout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      viewport: window.innerHeight,
      document: document.documentElement.scrollHeight,
      model: bounds("#model-trigger"),
      context: bounds("#context-panel"),
      splitter: bounds("#composer-splitter"),
      composer: bounds("#message-form"),
      conversation: bounds("#conversation"),
      send: bounds("#send"),
    };
  });
  expect(initialLayout.document).toBeLessThanOrEqual(initialLayout.viewport + 1);
  for (const element of [initialLayout.model, initialLayout.context, initialLayout.splitter, initialLayout.composer, initialLayout.send]) {
    expect(element.bottom).toBeLessThanOrEqual(initialLayout.viewport + 1);
  }
  expect(initialLayout.send.top).toBeGreaterThanOrEqual(initialLayout.splitter.bottom);
  expect(Math.abs(initialLayout.send.bottom - initialLayout.composer.bottom)).toBeLessThan(2);
  const initial = await form.boundingBox();
  const initialInput = await textarea.boundingBox();
  const initialConversation = await page.locator("#conversation").boundingBox();
  const handle = await splitter.boundingBox();
  expect(initial).not.toBeNull();
  expect(initialConversation).not.toBeNull();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y - 80);
  await page.mouse.up();
  await expect.poll(async () => (await form.boundingBox())!.height).toBeGreaterThan(initial!.height + 50);
  const resized = await form.boundingBox();
  const inputBounds = await textarea.boundingBox();
  const resizedConversation = await page.locator("#conversation").boundingBox();
  expect(resized!.height).toBeGreaterThan(initial!.height + 50);
  expect(inputBounds!.height).toBeGreaterThan(initialInput!.height + 50);
  expect(resizedConversation!.height).toBeLessThan(initialConversation!.height - 50);
  const settledHeight = resized!.height;
  await page.waitForTimeout(100);
  expect((await form.boundingBox())!.height).toBeCloseTo(settledHeight, 0);
  await expect(textarea).toHaveCSS("resize", "none");
  await expect(textarea).toHaveCSS("overflow-y", "auto");
  const resizedActionBounds = await send.boundingBox();
  expect(resizedActionBounds!.height).toBeLessThan(50);
  expect(Math.abs(resizedActionBounds!.y + resizedActionBounds!.height - resized!.y - resized!.height)).toBeLessThan(2);

  const resizedHandle = await splitter.boundingBox();
  await page.mouse.move(resizedHandle!.x + resizedHandle!.width / 2, resizedHandle!.y + resizedHandle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizedHandle!.x + resizedHandle!.width / 2, resizedHandle!.y + 60);
  await page.mouse.up();
  await expect.poll(async () => (await form.boundingBox())!.height).toBeLessThan(settledHeight - 30);

  await textarea.fill("overflow line\n".repeat(120));
  expect(await textarea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await textarea.fill("long run");
  await textarea.press("Enter");
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  const stopBounds = await stop.boundingBox();
  const sendBounds = await send.boundingBox();
  const formBounds = await form.boundingBox();
  const splitterBounds = await splitter.boundingBox();
  expect(stopBounds!.y).toBeGreaterThanOrEqual(splitterBounds!.y + splitterBounds!.height);
  expect(sendBounds!.y).toBeGreaterThanOrEqual(splitterBounds!.y + splitterBounds!.height);
  expect(stopBounds!.height).toBeLessThan(50);
  expect(sendBounds!.height).toBeLessThan(50);
  expect(Math.abs(stopBounds!.y + stopBounds!.height - formBounds!.y - formBounds!.height)).toBeLessThan(2);
  expect(Math.abs(sendBounds!.y + sendBounds!.height - stopBounds!.y + 6)).toBeLessThan(2);
  expect(stopBounds!.y + stopBounds!.height).toBeLessThanOrEqual(850);

  await splitter.focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => (await form.boundingBox())!.height).toBeGreaterThanOrEqual(96);
  const minimumLayout = await page.evaluate(() => ({
    composer: document.querySelector("#message-form")!.getBoundingClientRect(),
    conversation: document.querySelector("#conversation")!.getBoundingClientRect(),
    maximum: Number(document.querySelector("#composer-splitter")!.getAttribute("aria-valuemax")),
  }));
  expect(minimumLayout.composer.height).toBeGreaterThanOrEqual(96);
  expect(minimumLayout.conversation.height).toBeGreaterThanOrEqual(96);
  expect(minimumLayout.composer.height).toBeLessThanOrEqual(minimumLayout.maximum + 1);
  await page.keyboard.press("End");
  const maximumLayout = await page.evaluate(() => ({
    viewport: window.innerHeight,
    document: document.documentElement.scrollHeight,
    conversation: document.querySelector("#conversation")!.getBoundingClientRect(),
    splitter: document.querySelector("#composer-splitter")!.getBoundingClientRect(),
    form: document.querySelector("#message-form")!.getBoundingClientRect(),
    send: document.querySelector("#send")!.getBoundingClientRect(),
    stop: document.querySelector("#stop")!.getBoundingClientRect(),
  }));
  expect(maximumLayout.document).toBeLessThanOrEqual(maximumLayout.viewport + 1);
  expect(maximumLayout.conversation.height).toBeGreaterThanOrEqual(96);
  expect(maximumLayout.send.height).toBeLessThan(50);
  expect(maximumLayout.stop.height).toBeLessThan(50);
  expect(maximumLayout.send.top).toBeGreaterThanOrEqual(maximumLayout.splitter.bottom);
  expect(maximumLayout.stop.top).toBeGreaterThanOrEqual(maximumLayout.splitter.bottom);
  expect(maximumLayout.send.bottom).toBeLessThanOrEqual(maximumLayout.viewport);
  expect(maximumLayout.stop.bottom).toBeLessThanOrEqual(maximumLayout.viewport);
  expect(Math.abs(maximumLayout.stop.bottom - maximumLayout.form.bottom)).toBeLessThan(2);
  const savedHeight = await page.evaluate(() => localStorage.getItem("pi-vot-composer-height"));
  await page.reload();
  await expect.poll(async () => page.locator("#message-form").evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(Number(savedHeight));
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => page.locator("#message-form").evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(Number(savedHeight));
  await page.evaluate(() => localStorage.setItem("pi-vot-composer-height", "10000"));
  await page.setViewportSize({ width: 500, height: 420 });
  await page.reload();
  await expect.poll(async () => page.locator("#composer-splitter").getAttribute("aria-valuenow")).not.toBe("10000");
  const compactViewport = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    app: document.querySelector("#app-shell")!.getBoundingClientRect(),
    form: document.querySelector("#message-form")!.getBoundingClientRect(),
    send: document.querySelector("#send")!.getBoundingClientRect(),
    pane: document.querySelector("#conversation")!.getBoundingClientRect(),
    maximum: Number(document.querySelector("#composer-splitter")!.getAttribute("aria-valuemax")),
  }));
  expect(compactViewport.documentHeight).toBeLessThanOrEqual(compactViewport.viewportHeight + 1);
  expect(compactViewport.app.bottom).toBeLessThanOrEqual(compactViewport.viewportHeight + 1);
  expect(compactViewport.form.bottom).toBeLessThanOrEqual(compactViewport.viewportHeight + 1);
  expect(compactViewport.send.bottom).toBeLessThanOrEqual(compactViewport.viewportHeight + 1);
  expect(compactViewport.form.height).toBeLessThanOrEqual(compactViewport.maximum + 1);
  expect(compactViewport.pane.height).toBeGreaterThanOrEqual(0);
});
test("tab title follows only the selected session's ready, running, and error status", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("pi - Ready");
  await page.getByLabel("Message Pi").fill("long run");
  await page.getByLabel("Message Pi").press("Enter");
  await expect(page).toHaveTitle("pi - Running");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page).toHaveTitle("pi - Ready");

  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await sessionB.locator(".session-switch").click();
  await expect(page).toHaveTitle("pi - Ready");
  await page.request.post("/api/message", {
    data: { message: "background stream", sessionId: "/fake/project/current.jsonl" },
  });
  await expect(sessionA).toHaveAttribute("data-runtime-state", "running");
  await expect(sessionA).toHaveAttribute("data-runtime-state", "idle", { timeout: 5_000 });
  await expect(page).toHaveTitle("pi - Ready");
  await page.request.post("/api/message", {
    data: { message: "background crash", sessionId: "/fake/project/current.jsonl" },
  });
  await expect(sessionA).toHaveAttribute("data-runtime-state", "failed", { timeout: 5_000 });
  await expect(page).toHaveTitle("pi - Ready");
  await sessionA.locator(".session-switch").click();
  await expect(page).toHaveTitle("Pi - Error");
  await sessionB.locator(".session-switch").click();
  await expect(page).toHaveTitle("pi - Ready");
  expect(await page.title()).not.toMatch(/[✓●✕]/);
  expect(await page.title()).not.toContain("Pi-vot");
});

test("model picker is session-specific, scrollable, viewport-safe, accessible, and failure-safe", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 520 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Current model:/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const picker = page.locator("#model-picker");
  const options = picker.getByRole("option");
  await expect(picker).toBeVisible();
  await expect(options).toHaveCount(17);
  await expect(picker.locator('[data-model-id="fake-model"]')).toHaveAttribute("aria-selected", "true");
  await expect(picker.locator('[data-model-id="fake-model"]')).toContainText("✓");
  await expect.poll(() => page.locator("#model-options").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(picker.locator('[data-model-id="fake-model"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(picker.locator('[data-model-id="model-next"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await trigger.click();
  const bounds = await page.evaluate(() => {
    const panel = document.querySelector("#model-picker")!.getBoundingClientRect();
    return {
      left: panel.left,
      right: panel.right,
      top: panel.top,
      bottom: panel.bottom,
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      sidebarWidth: document.querySelector("#session-sidebar")!.scrollWidth,
      sidebarClientWidth: document.querySelector("#session-sidebar")!.clientWidth,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(700);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(520);
  expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
  expect(bounds.sidebarWidth).toBeLessThanOrEqual(bounds.sidebarClientWidth);

  await picker.locator('[data-model-id="model-next"]').click();
  await expect(page.locator("#model-name")).toHaveText("fake-provider / model-next");
  await expect(page.locator("#context-value")).toHaveText("134,982 / 256,000");
  await expect(picker).toBeHidden();

  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await sessionB.locator(".session-switch").click();
  await expect(page.locator("#model-name")).toHaveText("fake-provider / fake-model");
  await trigger.click();
  await expect(page.locator("#model-picker [role=option]")).toHaveCount(1);
  await expect(page.locator("#model-picker [role=option]")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByLabel("Message Pi").fill("activate model history");
  await page.getByLabel("Message Pi").press("Enter");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await trigger.click();
  await picker.locator('[data-model-id="available-0"]').click();
  await expect(page.locator("#model-name")).toHaveText("another-provider / available-model-0");
  await sessionA.locator(".session-switch").click();
  await expect(page.locator("#model-name")).toHaveText("fake-provider / model-next");
  await sessionB.locator(".session-switch").click();
  await expect(page.locator("#model-name")).toHaveText("another-provider / available-model-0");

  await trigger.click();
  await picker.locator('[data-model-id="fail-model"]').click();
  await expect(picker).toBeVisible();
  await expect(page.locator("#model-picker-message")).toHaveText("Fake model switch failed.");
  await expect(page.locator("#model-name")).toHaveText("another-provider / available-model-0");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  await trigger.click();
  await expect(picker).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(picker).toBeHidden();
});

test("model picker avoids activating an inactive session and disables changes while Pi is busy", async ({ page }) => {
  await page.goto("/");
  const current = page.locator(".session-row").filter({ hasText: "Current session" });
  const trigger = page.getByRole("button", { name: /Current model:/ });
  await page.getByLabel("Message Pi").fill("long run");
  await page.getByLabel("Message Pi").press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await trigger.click();
  await expect(page.locator("#model-picker-message")).toHaveText("Model can be changed when the session is idle.");
  await expect(page.locator("#model-picker [role=option]").first()).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();

  await page.getByLabel("Message Pi").fill("arm slow compaction");
  await page.getByLabel("Message Pi").press("Enter");
  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await trigger.click();
  await expect(page.locator("#model-picker-message")).toHaveText("Model can be changed when the session is idle.");
  await expect(page.locator("#model-picker [role=option]").first()).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled();

  await current.locator(".session-actions summary").click();
  await current.getByRole("button", { name: "Close runtime for Current session" }).click();
  await trigger.click();
  await expect(page.locator("#model-picker-message")).toHaveText("Activate this session before changing models.");
  await expect(page.locator("#model-picker [role=option]")).toBeDisabled();
  await expect(current.locator(".session-active-dot")).toBeHidden();
});

test("a delayed model-list response from another session cannot repopulate the selected session picker", async ({ page }) => {
  let delayFirstList = true;
  await page.route("**/api/models", async (route) => {
    const response = await route.fetch();
    if (delayFirstList) {
      delayFirstList = false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.fulfill({ response });
  });
  await page.goto("/");
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await page.getByRole("button", { name: /Current model:/ }).click();
  await sessionB.locator(".session-switch").click();
  await expect(page.locator("#model-picker")).toBeHidden();
  await expect(page.locator("#model-name")).toHaveText("fake-provider / fake-model");
  await page.getByRole("button", { name: /Current model:/ }).click();
  await expect(page.locator("#model-picker [role=option]")).toHaveCount(1);
  await expect(page.locator("#model-picker [data-model-id=\"fake-model\"]")).toBeDisabled();
});

test("a model-list failure stays local to the picker and reopening retries", async ({ page }) => {
  let failOnce = true;
  await page.route("**/api/models", async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fake model list unavailable." }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Current model:/ });
  await trigger.click();
  await expect(page.locator("#model-picker-status")).toHaveText("Could not load models.");
  await expect(page.locator("#model-picker-message")).toHaveText("Fake model list unavailable.");
  await expect(page.locator("#model-name")).toHaveText("fake-provider / fake-model");
  await expect(page.locator("#status")).not.toHaveAttribute("data-state", "error");
  await trigger.click();
  await trigger.click();
  await expect(page.locator("#model-picker [role=option]")).toHaveCount(17);
});

test("a failed background runtime does not break another session and remains visibly failed", async ({ page }) => {
  await page.goto("/");
  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  const input = page.getByLabel("Message Pi");

  await expect(sessionA).toHaveAttribute("aria-current", "true");
  await expect(sessionA.locator(".session-active-dot")).toBeVisible();
  await input.fill("background crash");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await sessionB.locator(".session-switch").click();
  await expect(sessionB).toHaveAttribute("aria-current", "true");
  await input.fill("long run");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(sessionB).toHaveAttribute("data-runtime-state", "running");
  await expect(sessionA.locator(".session-active-dot")).toBeHidden({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await sessionA.locator(".session-switch").click();
  await expect(page.getByRole("status")).toHaveText("Fake Pi process crashed.");
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await sessionA.locator(".session-actions summary").click();
  await expect(sessionA.getByRole("button", { name: "Close runtime for Current session" })).toBeVisible();
  await sessionA.getByRole("button", { name: "Close runtime for Current session" }).click();
  await expect(sessionA.locator(".session-active-dot")).toBeHidden();
  await sessionB.locator(".session-switch").click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
});

test("streams assistant output with collapsed thinking and tool details", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("hi");
  await page.getByRole("button", { name: "Send" }).click();

  const assistantText = page.locator(".assistant-text");
  await expect(assistantText).toHaveText("Streaming response ");
  await expect(page.locator("details.thinking")).toHaveCount(1);
  await expect(page.locator("details.tool")).toHaveCount(1);
  await expect(page.locator("details.thinking")).toHaveJSProperty("open", false);
  await expect(page.locator("details.tool")).toHaveJSProperty("open", false);
  await expect(page.locator("details.tool")).toHaveAttribute("data-state", "complete");
  await expect(input).toBeEnabled();
  await expect(assistantText).toHaveText("Canonical final answer.");
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
});

test("assistant Markdown streams incomplete syntax, renders rich blocks, and uses canonical final text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("markdown response");
  await input.press("Enter");

  const body = page.locator(".assistant-text");
  await expect.poll(async () => body.textContent()).toContain("def f(");
  await expect(body.locator("pre code").first()).toContainText("    return 42");
  await expect(body).toContainText("Interim text.");
  await expect(body.locator("h1")).toHaveText("Canonical heading");
  await expect(body.locator("p").first()).toContainText("emphasis");
  await expect(body.locator("em")).toHaveText("emphasis");
  await expect(body.locator("strong")).toHaveText("strong text");
  await expect(body.locator("ol > li")).toHaveCount(2);
  await expect(body.locator("ol ul li")).toHaveText("Nested item");
  await expect(body.locator("blockquote")).toContainText("A quoted line.");
  await expect(body.locator("hr")).toHaveCount(1);
  await expect(body.locator(":not(pre) > code")).toHaveText("inline <code>");
  await expect(body.locator("table tbody tr")).toHaveCount(1);
  await expect(body.locator(".code-block")).toHaveCount(5);
  await expect(body.locator(".code-language")).toHaveText(["javascript", "python", "json", "not-a-real-language", "Code"]);
  await expect(body.locator(".code-block").nth(1).locator("pre > code")).toHaveText("def add(a, b):\n    return a + b");
  await expect(body.locator(".code-block").nth(1).locator("pre")).toHaveCSS("white-space", "pre");
  await expect(body.locator(".code-block").nth(1).locator("pre")).toHaveCSS("overflow-x", "auto");
  await expect(body.locator(".code-block").nth(0).locator(".hljs-keyword")).toHaveCount(1);
  await expect(body.locator(".code-block").nth(1).locator(".hljs-keyword")).toHaveCount(2);
  await expect(body.locator(".code-block").nth(2).locator(".hljs-attr")).toHaveCount(1);
  await expect(body.locator(".code-block").nth(3).locator("pre code")).toHaveText("  <tag> & exact text");
  await expect(body.locator(".code-block").nth(3).locator(".hljs")).toHaveCount(0);

  const copyButton = body.locator(".code-block").nth(1).getByRole("button", { name: "Copy code" });
  await copyButton.click();
  await expect(copyButton).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("def add(a, b):\n    return a + b");
  await expect(pageErrors).toEqual([]);
});

test("raw model HTML stays inert and dangerous links are not rendered as anchors", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Message Pi").fill("markdown security");
  await page.getByLabel("Message Pi").press("Enter");

  const body = page.locator(".assistant-text");
  await expect(body).toContainText("<script>window.__modelScriptRan = true</script>");
  await expect(body).toContainText("onerror=");
  await expect(body.locator("script, img, iframe")).toHaveCount(0);
  await expect(body.locator("a")).toHaveCount(1);
  await expect(body.locator("a")).toHaveAttribute("href", "https://example.com/");
  await expect(body.locator("a")).toHaveAttribute("rel", "noopener noreferrer");
  expect(await page.evaluate(() => [
    (window as Window & { __modelScriptRan?: boolean }).__modelScriptRan,
    (window as Window & { __modelEventRan?: boolean }).__modelEventRan,
    (window as Window & { __modelFrameRan?: boolean }).__modelFrameRan,
  ])).toEqual([undefined, undefined, undefined]);
});

test("restrictive CSP permits Markdown, highlighting, Copy, SSE, context updates, and favicon status", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");
  expect(response?.headers()["content-security-policy"]).not.toContain("unsafe-inline");
  await expect.poll(() => page.evaluate(() => {
    const browserWindow = window as Window & { marked?: unknown; hljs?: unknown };
    return Boolean(browserWindow.marked && browserWindow.hljs);
  })).toBe(true);
  await expect(page.locator("#context-meter")).toHaveAttribute("aria-valuenow", "67.5");
  await expect(page.locator("#status-favicon")).toHaveAttribute("data-state", "idle");

  expect(await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__cspInlineScriptRan = true";
    document.head.append(script);
    return (window as Window & { __cspInlineScriptRan?: boolean }).__cspInlineScriptRan;
  })).toBeUndefined();

  await page.getByLabel("Message Pi").fill("markdown response");
  await page.getByLabel("Message Pi").press("Enter");
  const body = page.locator(".assistant-text");
  await expect(body.locator("h1")).toHaveText("Canonical heading");
  await expect(body.locator(".code-block").first().locator(".hljs-keyword")).toHaveCount(1);
  const copy = body.locator(".code-block").nth(1).getByRole("button", { name: "Copy code" });
  await copy.click();
  await expect(copy).toHaveText("Copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("def add(a, b):\n    return a + b");

  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.locator("#context-meter")).toHaveAttribute("aria-valuenow", "15.5");
  await expect(page.locator("#context-value")).toHaveText("31,000 / 200,000");
  await expect(page.locator("#status-favicon")).toHaveAttribute("href", /^data:image\/svg\+xml,/);
  await expect(page.locator("#status-favicon")).toHaveAttribute("data-state", "idle");
});

test("tool errors are distinguishable from successful tool completion", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("tool error");
  await input.press("Enter");
  await expect(page.locator("details.tool")).toHaveAttribute("data-state", "error");
  await expect(page.locator("details.tool summary")).toContainText("error");
});

test("Send steers an active run and Stop aborts it without disabling the composer", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await page.getByRole("button", { name: "Send" }).click();

  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await expect(input).toBeEnabled();
  await input.fill("redirect now");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status")).toHaveText("Message sent to steer the current run.");
  await stop.click();
  await expect(stop).toBeHidden();

  await input.fill("usable again");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".assistant-text")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
});

test("long conversations scroll independently and follow only while near the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long transcript");
  await page.getByRole("button", { name: "Send" }).click();

  const conversation = page.locator("#conversation");
  const assistantText = page.locator(".assistant-text");
  await expect.poll(async () => assistantText.evaluate((node) => node.textContent?.length ?? 0)).toBeGreaterThan(500);

  const layout = await page.evaluate(() => {
    const pane = document.querySelector("#conversation")!;
    const composer = document.querySelector("#message-form")!.getBoundingClientRect();
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      paneClientHeight: pane.clientHeight,
      paneScrollHeight: pane.scrollHeight,
      composerBottom: composer.bottom,
    };
  });
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.paneScrollHeight).toBeGreaterThan(layout.paneClientHeight);
  expect(layout.paneClientHeight).toBeGreaterThan(100);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(await conversation.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(80);

  await conversation.evaluate((node) => {
    node.scrollTop = 0;
  });
  const beforeReading = await assistantText.evaluate((node) => node.textContent?.length ?? 0);
  await expect.poll(async () => assistantText.evaluate((node) => node.textContent?.length ?? 0)).toBeGreaterThan(beforeReading + 100);
  const readingScrollTop = await conversation.evaluate((node) => node.scrollTop);
  expect(readingScrollTop).toBeLessThan(5);

  await conversation.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const beforeFollow = await assistantText.evaluate((node) => node.textContent?.length ?? 0);
  await expect.poll(async () => assistantText.evaluate((node) => node.textContent?.length ?? 0)).toBeGreaterThan(beforeFollow + 100);
  expect(await conversation.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(80);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
});

test("Enter sends, Shift+Enter inserts newlines, and composition Enter does not submit", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  const userMessages = page.locator(".message.user");
  await input.press("Enter");
  await expect(userMessages).toHaveCount(0);

  await input.fill("first line");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("first line\n");
  await expect(userMessages).toHaveCount(0);
  await input.type("second line");
  await input.press("Enter");
  await expect(userMessages).toHaveCount(1);
  await expect(userMessages.first()).toContainText("first line\nsecond line");
  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");

  await input.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
  });
  await expect(userMessages).toHaveCount(1);
  await expect(input).toBeFocused();
  await input.fill("   ");
  await input.press("Enter");
  await expect(userMessages).toHaveCount(1);

  await input.fill("click still works");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(userMessages).toHaveCount(2);
  await expect(userMessages.nth(1)).toContainText("click still works");
});

test("Enter steers while active and Shift+Enter remains a newline", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await input.fill("redirect");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("redirect\n");
  await expect(page.locator(".message.user")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await input.type("more");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Message sent to steer the current run.");
  await expect(page.locator(".message.user").last()).toContainText("redirect\nmore");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
});

test("context/model display and manual compaction queue messages until Pi settles", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#model-info")).toContainText("fake-provider / fake-model");
  await expect(page.locator("#context-value")).toHaveText("134,982 / 200,000");
  await expect(page.locator("#context-percent")).toHaveText("68%");
  await expect(page.locator("#context-meter #context-percent")).toHaveCount(0);
  await expect(page.locator("#context-percent")).toHaveCSS("color", "rgb(241, 245, 249)");
  await expect(page.locator("#context-meter")).toHaveAttribute("aria-valuenow", "67.5");
  await expect.poll(() => page.locator("#context-meter").evaluate((element) => (element as HTMLMeterElement).value)).toBe(67.5);

  const input = page.getByLabel("Message Pi");
  const compact = page.getByRole("button", { name: "Compact" });
  await compact.click();
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await expect(page.locator("#context-status")).toContainText("compacting");
  await expect(input).toBeEnabled();

  await input.fill("first queued message");
  await input.press("Enter");
  await expect(page.locator(".message-delivery")).toHaveText("Queued until compaction completes");
  await input.fill("second queued");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("second queued\n");
  await expect(page.locator(".message-delivery")).toHaveCount(1);
  await input.type("message");
  await input.press("Enter");
  await expect(page.locator(".message-delivery")).toHaveCount(2);

  await expect(page.locator("#context-value")).toHaveText("31,000 / 200,000", { timeout: 3_000 });
  await expect(page.locator("#context-percent")).toHaveText("16%");
  await expect(page.locator(".message-delivery")).toHaveCount(0);
  await expect(page.locator(".message.user").first()).toContainText("first queued message");
  await expect(page.locator(".message.user").nth(1)).toContainText("second queued\nmessage");
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled();
});

test("automatic compaction uses the same state and a failed compaction leaves the composer usable", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("trigger automatic compaction");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await expect(page.locator("#context-status")).toContainText("threshold compaction");
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled({ timeout: 3_000 });

  await input.fill("trigger failed compaction");
  await input.press("Enter");
  await expect(page.locator("#context-status")).toHaveText("Fake compaction failed safely.", { timeout: 3_000 });
  await expect(page.locator("#context-status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled();
});

test("a session-too-small compaction result is shown as neutral information", async ({ page }) => {
  await page.goto("/");
  const initialContext = await page.locator("#context-value").innerText();
  const input = page.getByLabel("Message Pi");
  await input.fill("arm no-op compaction");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText(
    "Pi handled that input without starting a normal agent response.",
  );
  await page.getByRole("button", { name: "Compact" }).click();

  await expect(page.locator("#context-status")).toHaveText("Nothing to compact yet.", { timeout: 3_000 });
  await expect(page.locator("#context-status")).toHaveAttribute("data-state", "info");
  await expect(page.locator("#status")).not.toHaveAttribute("data-state", "error");
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled();
  await expect(input).toBeEnabled();
  await expect(page.locator("#context-value")).toHaveText(initialContext);
});

test("model context window is metadata only when current Pi context usage is unavailable", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("show unavailable context");
  await input.press("Enter");
  await expect(page.locator("#context-value")).toHaveText("Context unavailable · 200,000 window");
  await expect(page.locator("#context-percent")).toHaveText("Unavailable");
  await expect(page.locator("#context-meter")).not.toHaveAttribute("aria-valuenow", /\d/);
  await expect(page.locator("#context-value")).not.toContainText("0 /");

  await input.fill("show incomplete context");
  await input.press("Enter");
  await expect(page.locator("#context-value")).toHaveText("Context unavailable · 200,000 window");
  await expect(page.locator("#context-value")).not.toContainText("100 /");
});

test("session sidebar hydrates Pi history and a browser refresh restores the active transcript", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#project-directory")).toHaveText("/fake/project");
  await expect(page.locator("#session-list .session-row")).toHaveCount(3);
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("Current session");

  const historicalSession = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await historicalSession.locator(".session-switch").click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.locator(".message.user").first()).toContainText("Investigate persisted sessions");
  await expect(page.locator(".assistant-text").first()).toHaveText("I will inspect the saved history.");
  await expect(page.locator(".assistant-text h2")).toHaveText("Persisted heading");
  await expect(page.locator(".assistant-text strong")).toHaveText("rich");
  await expect(page.locator(".assistant-text .code-language")).toHaveText("typescript");
  await expect(page.locator("details.thinking")).toContainText("Reviewing the selected Pi session.");
  await expect(page.locator("details.tool")).toHaveAttribute("data-state", "complete");
  await expect(page.locator("details.tool .tool-content")).toContainText("Stored session message.");

  await page.reload();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await expect(page.locator(".message.user").last()).toContainText("Continue from the stored transcript.");
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("HDF5 debugging");
  await expect(page.locator(".assistant-text h2")).toHaveText("Persisted heading");
  await expect(page.locator(".assistant-text .code-block pre code")).toHaveText('const hydrated: string = "Pi";');
});

test("session groups use cwd metadata and preserve collapse state without releasing runtimes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".session-group")).toHaveCount(1);
  const group = page.locator('.session-group[data-cwd="/fake/project"]');
  const header = group.locator(".session-group-header");
  await expect(header).toContainText("/fake/project");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(group.locator(".session-row")).toHaveCount(3);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".session-group-items")).toBeHidden();
  await expect(group.locator(".session-group-active")).toHaveText("1 active");
  await expect(group.locator('.session-row[aria-current="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(group.locator(".session-group-header")).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  const reloadedGroup = page.locator('.session-group[data-cwd="/fake/project"]');
  await expect(reloadedGroup.locator(".session-group-header")).toHaveAttribute("aria-expanded", "false");
  await reloadedGroup.locator(".session-group-header").click();
  await expect(reloadedGroup.locator(".session-row")).toHaveCount(4);
  await expect(reloadedGroup.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-active-dot")).toBeVisible();
  await reloadedGroup.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-actions summary").click();
  await expect(reloadedGroup.getByRole("button", { name: "Close runtime for Current session" })).toBeVisible();
});

test("session action menus stay inside the sidebar and preserve vertical session scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 460 });
  await page.goto("/");
  const refresh = page.getByRole("button", { name: "Refresh sessions" });
  for (let index = 0; index < 10; index++) {
    await refresh.click();
  }

  const sessionList = page.locator("#session-list");
  await expect.poll(() => sessionList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(sessionList).toHaveCSS("overflow-y", "auto");
  await expect(sessionList).toHaveCSS("overflow-x", "hidden");

  const measureMenu = async (menu: import("@playwright/test").Locator) => menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const sidebar = document.querySelector("#session-sidebar")!.getBoundingClientRect();
    const trigger = element.parentElement!.querySelector("summary")!.getBoundingClientRect();
    const list = document.querySelector("#session-list")!;
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      sidebarLeft: sidebar.left,
      sidebarRight: sidebar.right,
      triggerRight: trigger.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
    };
  });
  const expectMenuVisible = async (menu: import("@playwright/test").Locator) => {
    await expect.poll(async () => {
      const bounds = await measureMenu(menu);
      return bounds.left >= bounds.sidebarLeft &&
        bounds.right <= bounds.sidebarRight &&
        bounds.top >= 0 &&
        bounds.bottom <= bounds.viewportHeight;
    }).toBe(true);
    const bounds = await measureMenu(menu);
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.sidebarLeft);
    expect(bounds.right).toBeLessThanOrEqual(bounds.sidebarRight);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.width).toBeLessThanOrEqual(bounds.sidebarRight - bounds.sidebarLeft);
    expect(bounds.right).toBeLessThanOrEqual(bounds.triggerRight);
    expect(bounds.listScrollWidth).toBeLessThanOrEqual(bounds.listClientWidth);
  };

  const current = page.locator(".session-row").filter({ hasText: "Current session" });
  const actions = current.locator(".session-actions");
  const menu = actions.locator(".session-menu");
  await actions.locator("summary").click();
  await expect(menu).toBeVisible();
  await expect(current.getByRole("button", { name: "Rename Current session" })).toBeVisible();
  await expect(current.getByRole("button", { name: "Close runtime for Current session" })).toBeVisible();
  await expectMenuVisible(menu);

  await page.keyboard.press("Escape");
  await expect(actions).not.toHaveAttribute("open", "");
  await actions.locator("summary").click();
  await page.locator("#session-toolbar").click();
  await expect(actions).not.toHaveAttribute("open", "");

  await actions.locator("summary").click();
  page.once("dialog", (dialog) => {
    void dialog.accept("Renamed from menu");
  });
  await current.getByRole("button", { name: "Rename Current session" }).click();
  await expect(page.locator(".session-row").filter({ hasText: "Renamed from menu" })).toHaveCount(1);

  await sessionList.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => sessionList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const lastRow = page.locator(".session-row").last();
  const lastActions = lastRow.locator(".session-actions");
  const lastMenu = lastActions.locator(".session-menu");
  await lastActions.locator("summary").click();
  await expect(lastMenu).toBeVisible();
  await expectMenuVisible(lastMenu);
  await expect.poll(() => sessionList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("sessions from separate working directories render in separate selectable groups", async ({ page }) => {
  await page.goto("/");
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await page.locator("#project-path").fill("/fake/other-project");
  await page.getByRole("button", { name: "Open", exact: true }).click();

  await expect(page.locator(".session-group")).toHaveCount(2);
  const originalProject = page.locator('.session-group[data-cwd="/fake/project"]');
  const otherProject = page.locator('.session-group[data-cwd="/fake/other-project"]');
  await expect(originalProject.locator(".session-row").filter({ hasText: "HDF5 debugging" })).toHaveCount(1);
  await expect(originalProject.locator(".session-group-active")).toHaveText("1 active");
  await expect(otherProject.locator(".session-row").filter({ hasText: "Current session" })).toHaveCount(1);
  await expect(page.locator(".session-group").first()).toHaveAttribute("data-cwd", "/fake/other-project");
  await originalProject.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect(originalProject.locator('.session-row[aria-current="true"]')).toContainText("HDF5 debugging");
});

test("favicon follows the selected session with distinct idle, running, and error shapes", async ({ page }) => {
  await page.goto("/");
  const favicon = page.locator("#status-favicon");
  const svg = async () => favicon.evaluate((element) => decodeURIComponent((element as HTMLLinkElement).href.split(",")[1] ?? ""));
  await expect(favicon).toHaveAttribute("data-state", "idle");
  await expect.poll(svg).toContain("M5 12.5");

  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await input.press("Enter");
  await expect(favicon).toHaveAttribute("data-state", "running");
  await expect.poll(svg).toContain('r="5"');

  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect(favicon).toHaveAttribute("data-state", "idle");
  await expect.poll(svg).toContain("M5 12.5");
  await expect.poll(svg).not.toContain('r="5"');
  await expect(page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-active-dot")).toBeVisible();

  await input.fill("background crash");
  await input.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Fake Pi process crashed.");
  await expect(favicon).toHaveAttribute("data-state", "error");
  await expect.poll(svg).toContain("M6 6l12 12M18 6L6 18");
});

test("Refresh discovers a session created outside Pi-vot", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".session-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.locator(".session-row")).toHaveCount(4);
  await expect(page.locator(".session-row").filter({ hasText: "Created in terminal Pi" })).toHaveCount(1);
});

test("New Session clears the transcript and selects a new persisted session", async ({ page }) => {
  await page.goto("/");
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await page.getByRole("button", { name: "+ New Session" }).click();
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(page.locator(".session-row")).toHaveCount(4);
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("New session");
  await expect(page.locator("#model-info")).toContainText("fake-provider / fake-model");
  await expect(page.locator("#context-value")).toHaveText("Context unavailable · 200,000 window");
});

test("session rename persists its displayed name and delete confirms one selected Pi session", async ({ page }) => {
  await page.goto("/");
  const unnamed = page.locator(".session-row").filter({ hasText: "Find a parser regression" });
  page.once("dialog", (dialog) => {
    expect(dialog.type()).toBe("prompt");
    void dialog.accept("Parser follow-up");
  });
  await unnamed.locator(".session-actions summary").click();
  await unnamed.getByRole("button", { name: "Rename Find a parser regression" }).click();
  await expect(page.locator(".session-row").filter({ hasText: "Parser follow-up" })).toHaveCount(1);

  let confirmation = "";
  page.once("dialog", (dialog) => {
    confirmation = dialog.message();
    void dialog.accept();
  });
  const renamed = page.locator(".session-row").filter({ hasText: "Parser follow-up" });
  await renamed.locator(".session-actions summary").click();
  await renamed.getByRole("button", { name: "Delete Parser follow-up" }).click();
  expect(confirmation).toContain("This removes the persisted Pi session.");
  await expect(page.locator(".session-row")).toHaveCount(2);
  await expect(page.locator(".session-row").filter({ hasText: "HDF5 debugging" })).toHaveCount(1);
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("Current session");
});

test("a background session remains active and selectable while another session is compacting", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("long run");
  await page.getByRole("button", { name: "Send" }).click();
  const historicalSwitch = page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch");
  await expect(historicalSwitch).toBeEnabled();
  await expect(page.getByRole("status")).toHaveText("Pi is responding...");
  await historicalSwitch.click();
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("HDF5 debugging");
  await expect(page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-active-dot")).toBeVisible();
  await expect(page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-active-dot")).toBeHidden();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();

  await historicalSwitch.click();
  await expect(page.locator(".message.user")).toHaveCount(2);
  await page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-switch").click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(historicalSwitch).toBeEnabled();

  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await expect(historicalSwitch).toBeEnabled();
  await historicalSwitch.click();
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("HDF5 debugging");
  await expect(page.getByRole("button", { name: "Compact" })).toBeDisabled();
  await expect(page.locator(".session-row").filter({ hasText: "Current session" }).locator(".session-active-dot")).toBeVisible();
});

test("two sessions stream independently and Stop on B leaves background A running", async ({ page }) => {
  await page.goto("/");
  const sessionA = page.locator(".session-row").filter({ hasText: "Current session" });
  const sessionB = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  const input = page.getByLabel("Message Pi");

  await input.fill("background stream");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await sessionB.locator(".session-switch").click();
  await expect(page.locator(".session-row[aria-current='true']")).toContainText("HDF5 debugging");
  await expect(page.locator("#context-value")).toContainText("Context unavailable");
  await input.fill("long run");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await sessionA.locator(".session-actions summary").click();
  await expect(sessionA.getByRole("button", { name: "Stop Current session" })).toBeVisible();
  await expect(sessionA.locator(".session-active-dot")).toBeVisible();
  await expect(sessionB.locator(".session-active-dot")).toBeVisible();
  await expect(sessionA).toHaveAttribute("data-runtime-state", "idle", { timeout: 5_000 });
  await sessionA.locator(".session-actions summary").click();
  await expect(sessionA.getByRole("button", { name: "Stop Current session" })).toBeHidden();

  await expect(page.locator(".assistant-text").filter({ hasText: "Background response from A." })).toHaveCount(0);
  await sessionA.locator(".session-switch").click();
  await expect(page.locator(".assistant-text").filter({ hasText: "Background response from A." })).toHaveCount(1);
  await expect(page.locator("details.thinking").last()).toContainText("Thinking for session A.");
  await expect(page.locator("details.tool").last()).toContainText("Session A tool result");
  await expect(page.locator("#context-value")).toHaveText("81,000 / 200,000");
});

test("closing a runtime removes its dot but keeps its Pi session, and active delete is blocked", async ({ page }) => {
  await page.goto("/");
  const row = page.locator(".session-row").filter({ hasText: "Current session" });
  await row.locator(".session-actions summary").click();
  page.once("dialog", (dialog) => void dialog.accept());
  await row.getByRole("button", { name: "Delete Current session" }).click();
  await expect(page.locator("#status")).toContainText("Close this session's runtime");

  await row.getByRole("button", { name: "Close runtime for Current session" }).click();
  await expect(row.locator(".session-active-dot")).toBeHidden();
  await expect(row).toHaveCount(1);
  await expect(row.locator(".session-title")).toHaveText("Current session");
});

test("project browsing preserves active session access and the fixed conversation layout", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");
  await page.locator(".session-row").filter({ hasText: "HDF5 debugging" }).locator(".session-switch").click();
  await page.locator("#project-path").fill("/fake/other-project");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator("#project-directory")).toHaveText("/fake/other-project");
  await expect(page.locator("#session-list .session-row")).toHaveCount(4);
  const backgroundSession = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await expect(backgroundSession.locator(".session-active-dot")).toBeHidden();
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(backgroundSession.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator(".message.user")).toHaveCount(2);

  const layout = await page.evaluate(() => {
    const sidebar = document.querySelector("#session-sidebar")!.getBoundingClientRect();
    const workspace = document.querySelector("#workspace")!.getBoundingClientRect();
    const conversation = document.querySelector("#conversation")!;
    const composer = document.querySelector("#message-form")!.getBoundingClientRect();
    return {
      sidebarRatio: sidebar.width / workspace.width,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      paneHeight: conversation.clientHeight,
      paneScrollHeight: conversation.scrollHeight,
      composerBottom: composer.bottom,
    };
  });
  expect(layout.sidebarRatio).toBeLessThan(0.3);
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.paneHeight).toBeGreaterThan(100);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight);

  const input = page.getByLabel("Message Pi");
  await input.fill("after session and project switch");
  await input.press("Enter");
  await expect(page.locator(".assistant-text").last()).toHaveText("Canonical final answer.");
  await expect(page.locator("#model-info")).toContainText("fake-provider / fake-model");
  await backgroundSession.locator(".session-switch").click();
  await expect(backgroundSession).toHaveAttribute("aria-current", "true");
  await backgroundSession.locator(".session-actions summary").click();
  await expect(backgroundSession.getByRole("button", { name: "Close runtime for HDF5 debugging" })).toBeVisible();
});

test("drag, clipboard, and picker inputs preserve ordering and reject unsupported or oversized images", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const form = page.locator("#message-form");
  const pngBase64 = TEST_PNG.toString("base64");
  const drop = await form.evaluate((element, data) => {
    const file = new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], "dropped.png", {
      type: "image/png",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const enter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(enter);
    const highlightVisible = !(document.querySelector("#drop-overlay") as HTMLElement).hidden;
    const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
    element.dispatchEvent(dropEvent);
    return { highlightVisible, prevented: dropEvent.defaultPrevented, url: location.href };
  }, pngBase64);
  expect(drop.highlightVisible).toBe(true);
  expect(drop.prevented).toBe(true);
  expect(drop.url).toBe(page.url());
  await expect(page.locator("#drop-overlay")).toBeHidden();
  await expect(page.locator(".image-attachment-name")).toHaveText("dropped.png");

  const paste = await page.getByLabel("Message Pi").evaluate((element, data) => {
    const file = new File([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], "pasted.png", {
      type: "image/png",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, pngBase64);
  expect(paste).toBe(true);
  await expect(page.locator(".image-attachment-name")).toHaveText(["dropped.png", "pasted.png"]);

  await page.evaluate(async () => navigator.clipboard.writeText("ordinary clipboard text"));
  await page.getByLabel("Message Pi").focus();
  await page.keyboard.press("Control+V");
  await expect(page.getByLabel("Message Pi")).toHaveValue("ordinary clipboard text");

  const longName = `${"long-filename-".repeat(12)}.png`;
  await page.locator("#image-picker").setInputFiles([
    imageFile(longName),
    imageFile("second.png"),
  ]);
  await expect(page.locator(".image-attachment")).toHaveCount(4);
  await expect(page.getByRole("button", { name: `Remove image ${longName}` })).toBeVisible();
  await expect(page.locator(".image-attachment-name").last()).toHaveAttribute("title", "second.png");
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
  await page.getByRole("button", { name: `Remove image ${longName}` }).click();
  await expect(page.locator(".image-attachment")).toHaveCount(3);

  await page.locator("#image-picker").setInputFiles({
    name: "document.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF"),
  });
  await expect(page.locator("#status")).toHaveText("Unsupported image type.");
  await expect(page.locator(".image-attachment")).toHaveCount(3);

  await page.locator("#image-picker").evaluate((element) => {
    const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = new File([bytes], "large.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    (element as HTMLInputElement).files = transfer.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#status")).toHaveText("Image is too large.");
  await expect(page.locator(".image-attachment")).toHaveCount(3);
});

test("image capability follows Pi model metadata and accepted sends include ordered native image payloads", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/message", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue();
  });
  await page.goto("/");
  await page.locator("#image-picker").setInputFiles([
    imageFile("first.png"),
    imageFile("second.png"),
  ]);
  await expect(page.locator(".image-attachment")).toHaveCount(2);
  const input = page.getByLabel("Message Pi");
  await input.fill("describe both");

  const trigger = page.getByRole("button", { name: /Current model:/ });
  await trigger.click();
  await page.locator('#model-options [data-model-id="available-1"]').click();
  await expect(page.locator("#attachment-warning")).toHaveText("The selected model does not support image input.");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.locator(".image-attachment")).toHaveCount(2);

  await trigger.click();
  await page.locator('#model-options [data-model-id="available-0"]').click();
  await expect(page.locator("#attachment-warning")).toBeHidden();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await input.press("Enter");
  await expect.poll(() => submitted).toBeDefined();
  expect(submitted?.message).toBe("describe both");
  const sentImages = submitted?.images as Array<{ mimeType: string; data: string; name: string }>;
  expect(sentImages.map(({ name }) => name)).toEqual(["first.png", "second.png"]);
  expect(sentImages.every(({ mimeType, data }) => mimeType === "image/png" && data === TEST_PNG.toString("base64"))).toBe(true);
  await expect(page.locator(".image-attachment")).toHaveCount(0);
  await expect(page.locator(".message.user").last().locator(".image-message-attachments img")).toHaveCount(2);
});

test("inactive-session image drafts stay isolated and activate only when sent", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/message", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue();
  });
  await page.goto("/");
  const current = page.locator(".session-row").filter({ hasText: "Current session" });
  const history = page.locator(".session-row").filter({ hasText: "HDF5 debugging" });
  await history.locator(".session-switch").click();
  await expect(history).toHaveAttribute("aria-current", "true");
  await expect(history.locator(".session-active-dot")).toBeHidden();
  await page.locator("#image-picker").setInputFiles(imageFile("history.png"));
  await expect(history.locator(".session-active-dot")).toBeHidden();
  await expect(page.locator(".session-row .session-active-dot:visible")).toHaveCount(1);

  await current.locator(".session-switch").click();
  await expect(current).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".image-attachment")).toHaveCount(0);
  await history.locator(".session-switch").click();
  await expect(history).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".image-attachment-name")).toHaveText("history.png");
  await page.getByLabel("Message Pi").fill("inspect this screenshot");
  await page.getByLabel("Message Pi").press("Enter");
  await expect.poll(() => submitted).toBeDefined();
  expect(submitted?.sessionId).toBe("/fake/project/history-hydration.jsonl");
  expect((submitted?.images as unknown[]).length).toBe(1);
  await expect(history.locator(".session-active-dot")).toBeVisible();
  await expect(page.locator(".image-attachment")).toHaveCount(0);
});

test("failed image sends preserve their text and attachment, and images stay queued through compaction", async ({ page }) => {
  const submissions: Array<Record<string, unknown>> = [];
  let releaseQueuedResponse = () => {};
  let signalQueuedResponseReached = () => {};
  const queuedResponseGate = new Promise<void>((resolve) => {
    releaseQueuedResponse = resolve;
  });
  const queuedResponseReached = new Promise<void>((resolve) => {
    signalQueuedResponseReached = resolve;
  });
  await page.route("**/api/message", async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    submissions.push(payload);
    if (payload.message === "reject image") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fake Pi rejected the prompt." }),
      });
      return;
    }
    if (payload.message === "queued image") {
      const response = await route.fetch();
      signalQueuedResponseReached();
      await queuedResponseGate;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await page.locator("#image-picker").setInputFiles(imageFile("retry.png"));
  await input.fill("reject image");
  await input.press("Enter");
  await expect(page.locator("#status")).toHaveText("Fake Pi rejected the prompt.");
  await expect(input).toHaveValue("reject image");
  await expect(page.locator(".image-attachment-name")).toHaveText("retry.png");

  await input.fill("arm slow compaction");
  await input.press("Enter");
  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await page.locator("#image-picker").setInputFiles(imageFile("queued.png"));
  await input.fill("queued image");
  await input.press("Enter");
  const queuedMessage = page.locator(".message.user").last();
  await expect(queuedMessage.locator(".message-delivery")).toHaveText("Queued until compaction completes");
  await expect(page.locator(".image-attachment-name")).toHaveText("queued.png");
  await expect(queuedMessage.locator(".image-message-placeholder")).toHaveCount(1);
  await queuedResponseReached;
  const queuedMessageId = await queuedMessage.getAttribute("data-message-id");
  releaseQueuedResponse();
  await expect(queuedMessage.locator(".image-message-attachments img")).toHaveCount(1);
  await expect(queuedMessage.locator(".image-message-placeholder")).toHaveCount(0);
  await expect(queuedMessage.locator(".message-delivery")).toHaveText("Queued until compaction completes");
  expect(await queuedMessage.getAttribute("data-message-id")).toBe(queuedMessageId);
  expect((submissions.at(-1)?.images as unknown[]).length).toBe(1);
  await expect(page.getByRole("button", { name: "Compact" })).toBeEnabled({ timeout: 4_000 });
  await expect(page.locator(".image-attachment")).toHaveCount(0);
  await expect(queuedMessage.locator(".message-delivery")).toHaveCount(0);
  await expect(queuedMessage.locator(".image-message-attachments img")).toHaveCount(1);
  await expect(queuedMessage.locator(".image-message-placeholder")).toHaveCount(0);
});

test("a queued image failure keeps its local thumbnail, attachment, and draft", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Message Pi");
  await input.fill("arm slow compaction");
  await input.press("Enter");
  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  await page.locator("#image-picker").setInputFiles(imageFile("queued-retry.png"));
  await input.fill("fail queued image");
  await input.press("Enter");

  const queuedMessage = page.locator(".message.user").last();
  await expect(queuedMessage.locator(".message-delivery")).toHaveText("Queued until compaction completes");
  await expect(queuedMessage.locator(".image-message-attachments img")).toHaveCount(1);
  await expect(queuedMessage.locator(".image-message-placeholder")).toHaveCount(0);
  await expect(page.locator(".image-attachment-name")).toHaveText("queued-retry.png");
  await expect(queuedMessage.locator(".message-delivery")).toHaveText(
    "Not sent: Fake Pi rejected the queued image.",
    { timeout: 4_000 },
  );
  await expect(input).toHaveValue("fail queued image");
  await expect(page.locator(".image-attachment-name")).toHaveText("queued-retry.png");
  await expect(queuedMessage.locator(".image-message-attachments img")).toHaveCount(1);
  await expect(queuedMessage.locator(".image-message-placeholder")).toHaveCount(0);
});

test("attachment previews and compact controls fit at minimum and maximum composer heights", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 640 });
  await page.goto("/");
  await page.getByLabel("Message Pi").fill("long run");
  await page.getByLabel("Message Pi").press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.locator("#image-picker").setInputFiles(
    Array.from({ length: 12 }, (_, index) => imageFile(`image-${index}.png`)),
  );
  const splitter = page.getByRole("separator", { name: "Resize message composer" });
  await splitter.focus();
  await page.keyboard.press("Home");
  const minimum = await page.evaluate(() => ({
    viewport: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    form: document.querySelector("#message-form")!.getBoundingClientRect(),
    send: document.querySelector("#send")!.getBoundingClientRect(),
    stop: document.querySelector("#stop")!.getBoundingClientRect(),
    strip: {
      scrollWidth: document.querySelector("#attachment-strip")!.scrollWidth,
      clientWidth: document.querySelector("#attachment-strip")!.clientWidth,
    },
  }));
  expect(minimum.documentHeight).toBeLessThanOrEqual(minimum.viewport + 1);
  expect(minimum.send.bottom).toBeLessThanOrEqual(minimum.viewport + 1);
  expect(minimum.stop.bottom).toBeLessThanOrEqual(minimum.viewport + 1);
  expect(minimum.form.height).toBeGreaterThanOrEqual(96);
  expect(minimum.strip.scrollWidth).toBeGreaterThan(minimum.strip.clientWidth);

  await page.keyboard.press("End");
  const maximum = await page.evaluate(() => ({
    viewport: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    form: document.querySelector("#message-form")!.getBoundingClientRect(),
    send: document.querySelector("#send")!.getBoundingClientRect(),
    stop: document.querySelector("#stop")!.getBoundingClientRect(),
    strip: document.querySelector("#attachment-strip")!.getBoundingClientRect(),
  }));
  expect(maximum.documentHeight).toBeLessThanOrEqual(maximum.viewport + 1);
  expect(maximum.send.height).toBeLessThan(50);
  expect(maximum.stop.height).toBeLessThan(50);
  expect(Math.abs(maximum.send.bottom - maximum.stop.top + 6)).toBeLessThan(2);
  expect(Math.abs(maximum.stop.bottom - maximum.form.bottom)).toBeLessThan(2);
  expect(maximum.strip.right).toBeLessThanOrEqual(maximum.form.right + 1);
});
