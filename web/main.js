import { safeMarkdownHref, supportedMarkdownLanguage } from "./markdown-security.js";

const form = document.querySelector("#message-form");
const input = document.querySelector("#message");
const stop = document.querySelector("#stop");
const compact = document.querySelector("#compact");
const conversation = document.querySelector("#conversation");
const status = document.querySelector("#status");
const contextValue = document.querySelector("#context-value");
const contextMeter = document.querySelector("#context-meter");
const contextPercent = document.querySelector("#context-percent");
const contextStatus = document.querySelector("#context-status");
const modelName = document.querySelector("#model-name");
const modelTrigger = document.querySelector("#model-trigger");
const modelInfo = document.querySelector("#model-info");
const modelPicker = document.querySelector("#model-picker");
const modelPickerStatus = document.querySelector("#model-picker-status");
const modelOptions = document.querySelector("#model-options");
const modelPickerMessage = document.querySelector("#model-picker-message");
const modelPickerRefresh = document.querySelector("#model-picker-refresh");
const sessionList = document.querySelector("#session-list");
const composerSplitter = document.querySelector("#composer-splitter");
const composerForm = document.querySelector("#message-form");
const attachmentArea = document.querySelector("#attachment-area");
const attachmentStrip = document.querySelector("#attachment-strip");
const attachmentWarning = document.querySelector("#attachment-warning");
const imagePicker = document.querySelector("#image-picker");
const dropOverlay = document.querySelector("#drop-overlay");
const attachImages = document.querySelector("#attach-images");
const sendButton = document.querySelector("#send");
const wakeButton = document.querySelector("#wake");
const conversationPane = document.querySelector("#conversation-pane");
const contextPanel = document.querySelector("#context-panel");
const statusFavicon = document.querySelector("#status-favicon");
const projectDirectoryLabel = document.querySelector("#project-directory");
const projectPath = document.querySelector("#project-path");
const sessionButtons = [
    document.querySelector("#new-session"),
    document.querySelector("#refresh-sessions"),
    document.querySelector("#select-project"),
    document.querySelector("#pick-project"),
];
const assistants = new Map();
const tools = new Map();
const userMessages = new Map();
let activeAssistant;
let runState = "idle";
let isCompacting = false;
let latestContext = {
    tokens: null,
    contextWindow: null,
    percent: null,
};
let modelContextWindow = null;
let modelSupportsImageInput = null;
let activeSessionId = null;
let modelPickerRequest = 0;
let modelPickerSessionId = null;
let modelPickerOpen = false;
let projectDirectory = "";
let sessions = [];
let queuedMessages = [];
const runtimeStates = new Map();
const draftsBySession = new Map();
const attachmentsBySession = new Map();
const sendAttempts = new Map();
const wakeRequests = new Set();
const queuedMessageIds = new Map();
let pendingComposerSwitch = null;
const COLLAPSED_GROUPS_STORAGE_KEY = "pi-vot-collapsed-session-groups";
const COMPOSER_HEIGHT_STORAGE_KEY = "pi-vot-composer-height";
const LEGACY_COLLAPSED_GROUPS_STORAGE_KEY = "pi-pane-collapsed-session-groups";
const LEGACY_COMPOSER_HEIGHT_STORAGE_KEY = "pi-pane-composer-height";
const MAX_IMAGE_COUNT = 32;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
function readMigratedStorageValue(key, legacyKey) {
    const value = localStorage.getItem(key);
    if (value !== null)
        return value;
    const legacyValue = localStorage.getItem(legacyKey);
    if (legacyValue !== null) {
        localStorage.setItem(key, legacyValue);
        localStorage.removeItem(legacyKey);
    }
    return legacyValue;
}
function readCollapsedGroups() {
    try {
        const value = JSON.parse(readMigratedStorageValue(COLLAPSED_GROUPS_STORAGE_KEY, LEGACY_COLLAPSED_GROUPS_STORAGE_KEY) ?? "[]");
        return new Set(Array.isArray(value) ? value.filter((cwd) => typeof cwd === "string") : []);
    }
    catch {
        return new Set();
    }
}
const collapsedGroups = readCollapsedGroups();
function positionModelPicker() {
    if (!modelPickerOpen || !activeSessionId)
        return;
    const triggerRect = modelTrigger.getBoundingClientRect();
    modelPicker.style.maxHeight = `${Math.max(120, window.innerHeight - 16)}px`;
    modelPicker.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
    const pickerRect = modelPicker.getBoundingClientRect();
    const left = Math.max(8, Math.min(triggerRect.left, window.innerWidth - pickerRect.width - 8));
    const below = triggerRect.bottom + 4;
    const above = triggerRect.top - pickerRect.height - 4;
    const top = below + pickerRect.height <= window.innerHeight - 8 || above < 8 ? below : above;
    modelPicker.style.left = `${left}px`;
    modelPicker.style.top = `${Math.max(8, Math.min(top, window.innerHeight - pickerRect.height - 8))}px`;
}
function closeModelPicker(returnFocus = false) {
    modelPickerOpen = false;
    modelPickerRequest++;
    modelPickerSessionId = null;
    modelPicker.hidden = true;
    modelTrigger.setAttribute("aria-expanded", "false");
    if (returnFocus)
        modelTrigger.focus();
}
function modelLabel(model) {
    if (typeof model?.provider !== "string")
        return "";
    const name = typeof model.name === "string" && model.name ? model.name : model.id;
    return typeof name === "string" ? `${model.provider} / ${name}` : "";
}
function renderModelOptions(result) {
    modelOptions.replaceChildren();
    modelPickerMessage.textContent = "";
    delete modelPickerMessage.dataset.state;
    const canChange = result.canChange === true;
    const models = Array.isArray(result.models) ? result.models : [];
    if (!result.hasRuntime) {
        if (result.model && modelLabel(result.model))
            appendModelOption(result.model, result.model, false);
        modelPickerMessage.textContent = result.message || "Activate this session before changing models.";
        return;
    }
    if (models.length === 0) {
        modelPickerMessage.textContent = "Pi did not return any available models.";
        return;
    }
    for (const model of models) {
        if (typeof model?.provider === "string" && typeof model.id === "string")
            appendModelOption(model, result.model, canChange);
    }
    if (!canChange)
        modelPickerMessage.textContent = result.message || "Model can be changed when the session is idle.";
}
function appendModelOption(model, currentModel, canChange) {
    const label = modelLabel(model);
    if (!label)
        return;
    const option = document.createElement("button");
    option.type = "button";
    option.className = "model-option";
    option.setAttribute("role", "option");
    option.dataset.provider = model.provider;
    option.dataset.modelId = model.id;
    option.title = label;
    const selected = currentModel?.provider === model.provider && currentModel?.id === model.id;
    option.setAttribute("aria-selected", String(selected));
    option.disabled = !canChange;
    const check = document.createElement("span");
    check.className = "model-option-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = selected ? "✓" : "";
    const text = document.createElement("span");
    text.className = "model-option-label";
    text.textContent = label;
    option.append(check, text);
    option.addEventListener("click", () => void selectModel(model));
    option.addEventListener("keydown", (event) => {
        const options = [...modelOptions.querySelectorAll(".model-option:not(:disabled)")];
        const index = options.indexOf(option);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = event.key === "ArrowDown"
                ? (index + 1) % options.length
                : (index - 1 + options.length) % options.length;
            options[next]?.focus();
        }
    });
    modelOptions.append(option);
}
async function loadModelOptions(sessionId = activeSessionId) {
    if (!sessionId || !modelPickerOpen)
        return;
    modelPickerSessionId = sessionId;
    const request = ++modelPickerRequest;
    modelPickerStatus.textContent = "Loading models…";
    modelPickerMessage.textContent = "";
    delete modelPickerMessage.dataset.state;
    modelOptions.replaceChildren();
    positionModelPicker();
    try {
        const result = await post("/api/models", { sessionId });
        if (request !== modelPickerRequest || !modelPickerOpen || activeSessionId !== sessionId ||
            result.sessionId !== sessionId)
            return;
        modelPickerStatus.textContent = "";
        renderModelOptions(result);
        positionModelPicker();
    }
    catch (error) {
        if (request !== modelPickerRequest || !modelPickerOpen || activeSessionId !== sessionId)
            return;
        modelPickerStatus.textContent = "Could not load models.";
        modelPickerMessage.dataset.state = "error";
        modelPickerMessage.textContent = error instanceof Error ? error.message : "Refresh to try again.";
        positionModelPicker();
    }
}
async function selectModel(model) {
    const sessionId = modelPickerSessionId;
    if (!sessionId || sessionId !== activeSessionId)
        return;
    const request = modelPickerRequest;
    modelPickerStatus.textContent = "Changing model…";
    modelPickerMessage.textContent = "";
    for (const option of modelOptions.querySelectorAll(".model-option"))
        option.disabled = true;
    try {
        const result = await post("/api/model", {
            sessionId,
            provider: model.provider,
            modelId: model.id,
        });
        const view = runtimeView(sessionId);
        view.model = result.model;
        view.context = result.context;
        if (request === modelPickerRequest && modelPickerOpen && activeSessionId === sessionId) {
            updateModel(result.model);
            updateContext(result.context);
            closeModelPicker();
        }
    }
    catch (error) {
        if (request !== modelPickerRequest || !modelPickerOpen || activeSessionId !== sessionId)
            return;
        modelPickerStatus.textContent = "";
        modelPickerMessage.dataset.state = "error";
        modelPickerMessage.textContent = error instanceof Error ? error.message : "Pi could not change the model.";
        for (const option of modelOptions.querySelectorAll(".model-option"))
            option.disabled = false;
    }
}
function openModelPicker() {
    if (modelPickerOpen) {
        closeModelPicker();
        return;
    }
    modelPickerOpen = true;
    modelPicker.hidden = false;
    modelTrigger.setAttribute("aria-expanded", "true");
    loadModelOptions();
    positionModelPicker();
}
modelTrigger.addEventListener("click", openModelPicker);
modelPickerRefresh.addEventListener("click", () => void loadModelOptions());
window.addEventListener("resize", positionModelPicker);
window.addEventListener("scroll", positionModelPicker, true);
function saveCollapsedGroups() {
    try {
        localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify([...collapsedGroups]));
    }
    catch {
    }
}
function runtimeView(sessionId) {
    let view = runtimeStates.get(sessionId);
    if (!view) {
        view = { state: "idle", isCompacting: false, queuedMessages: [] };
        runtimeStates.set(sessionId, view);
    }
    return view;
}
function pendingAttachments(sessionId = activeSessionId) {
    return sessionId ? attachmentsBySession.get(sessionId) ?? [] : [];
}
function pendingQueueIds(sessionId = activeSessionId) {
    return sessionId ? queuedMessageIds.get(sessionId) ?? new Set() : new Set();
}
function updateSendButton() {
    const attachments = pendingAttachments();
    const hasInFlight = [...sendAttempts.values()].some((attempt) => attempt.sessionId === activeSessionId);
    sendButton.disabled = hasInFlight || pendingQueueIds().size > 0 ||
        (!input.value.trim() && attachments.length === 0) ||
        (attachments.length > 0 && modelSupportsImageInput === false);
}
function renderPendingAttachments() {
    attachmentStrip.replaceChildren();
    const sessionId = activeSessionId;
    const attachments = pendingAttachments();
    attachmentWarning.hidden = attachments.length === 0 || modelSupportsImageInput !== false;
    if (!attachmentWarning.hidden)
        attachmentWarning.textContent = "The selected model does not support image input.";
    for (const attachment of attachments) {
        const item = document.createElement("div");
        item.className = "image-attachment";
        const thumbnail = document.createElement("img");
        thumbnail.src = attachment.previewUrl;
        thumbnail.alt = "";
        const name = document.createElement("span");
        name.className = "image-attachment-name";
        name.textContent = attachment.name;
        name.title = attachment.name;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "attachment-remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove image ${attachment.name}`);
        remove.title = `Remove ${attachment.name}`;
        remove.addEventListener("click", () => removeAttachment(sessionId, attachment.id));
        item.append(thumbnail, name, remove);
        attachmentStrip.append(item);
    }
    updateSendButton();
}
function removeAttachment(sessionId, attachmentId) {
    if (!sessionId)
        return;
    const attachments = attachmentsBySession.get(sessionId) ?? [];
    const removed = attachments.find((item) => item.id === attachmentId);
    if (!removed)
        return;
    URL.revokeObjectURL(removed.previewUrl);
    const remaining = attachments.filter((item) => item.id !== attachmentId);
    if (remaining.length)
        attachmentsBySession.set(sessionId, remaining);
    else
        attachmentsBySession.delete(sessionId);
    if (activeSessionId === sessionId)
        renderPendingAttachments();
}
function addImageFiles(files, sessionId = activeSessionId) {
    if (!sessionId) {
        setStatus("Select a Pi session before attaching images.", "error");
        return;
    }
    const attachments = [...pendingAttachments(sessionId)];
    let totalSize = attachments.reduce((total, item) => total + item.file.size, 0);
    let rejected = "";
    for (const file of files) {
        const mimeType = file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type.toLowerCase();
        if (!SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) {
            rejected ||= "Unsupported image type.";
            continue;
        }
        if (file.size > MAX_IMAGE_SIZE_BYTES) {
            rejected ||= "Image is too large.";
            continue;
        }
        if (attachments.length >= MAX_IMAGE_COUNT) {
            rejected ||= `Attach no more than ${MAX_IMAGE_COUNT} images.`;
            continue;
        }
        if (totalSize + file.size > MAX_TOTAL_IMAGE_SIZE_BYTES) {
            rejected ||= "Total attachment size exceeds the limit.";
            continue;
        }
        totalSize += file.size;
        attachments.push({
            id: crypto.randomUUID(),
            file,
            mimeType,
            name: file.name || "image",
            previewUrl: URL.createObjectURL(file),
        });
    }
    if (attachments.length)
        attachmentsBySession.set(sessionId, attachments);
    if (activeSessionId === sessionId)
        renderPendingAttachments();
    if (rejected)
        setStatus(rejected, "error");
}
function switchComposerSession(sessionId) {
    const pendingSwitch = pendingComposerSwitch?.targetSessionId === sessionId
        ? pendingComposerSwitch
        : null;
    const typedDuringSwitch = pendingSwitch !== null && input.value !== pendingSwitch.inputValue;
    if (activeSessionId) {
        if (typedDuringSwitch && pendingSwitch.previousSessionId === activeSessionId) {
            if (pendingSwitch.previousDraft === undefined)
                draftsBySession.delete(activeSessionId);
            else
                draftsBySession.set(activeSessionId, pendingSwitch.previousDraft);
        }
        else {
            draftsBySession.set(activeSessionId, input.value);
        }
    }
    if (typedDuringSwitch) {
        draftsBySession.set(sessionId, input.value);
    }
    else {
        input.value = sessionId ? draftsBySession.get(sessionId) ?? "" : "";
    }
    if (pendingSwitch)
        pendingComposerSwitch = null;
}
function clearSentComposer(attempt) {
    const remaining = pendingAttachments(attempt.sessionId).filter((attachment) => {
        if (!attempt.attachments.includes(attachment))
            return true;
        URL.revokeObjectURL(attachment.previewUrl);
        return false;
    });
    if (remaining.length)
        attachmentsBySession.set(attempt.sessionId, remaining);
    else
        attachmentsBySession.delete(attempt.sessionId);
    const draft = draftsBySession.get(attempt.sessionId) ?? "";
    if (draft.trim() === attempt.message)
        draftsBySession.set(attempt.sessionId, "");
    if (activeSessionId === attempt.sessionId && input.value.trim() === attempt.message) {
        input.value = "";
        draftsBySession.set(attempt.sessionId, "");
    }
    if (activeSessionId === attempt.sessionId)
        renderPendingAttachments();
}
function disposeComposerSession(sessionId) {
    for (const attachment of pendingAttachments(sessionId))
        URL.revokeObjectURL(attachment.previewUrl);
    attachmentsBySession.delete(sessionId);
    draftsBySession.delete(sessionId);
    queuedMessageIds.delete(sessionId);
}
function encodeBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    return btoa(binary);
}
async function encodeAttachment(attachment) {
    return {
        mimeType: attachment.mimeType,
        name: attachment.name,
        data: encodeBase64(new Uint8Array(await attachment.file.arrayBuffer())),
    };
}
const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_CRITICAL_PERCENT = 90;
function isNearConversationBottom() {
    return conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop <= 80;
}
function followLatestIfNeeded(wasFollowing) {
    if (wasFollowing)
        conversation.scrollTop = conversation.scrollHeight;
}
function updateSessionControls() {
    sessionButtons[0].disabled = runState !== "idle" || isCompacting || queuedMessages.length > 0;
    sessionButtons[1].disabled = false;
    const selectedSession = sessions.find((session) => session.id === activeSessionId);
    const hasRuntime = selectedSession?.hasRuntime === true;
    const failedRuntime = runtimeStates.get(activeSessionId)?.state === "failed";
    wakeButton.hidden = !selectedSession ||
        selectedSession.active === true ||
        (hasRuntime && !failedRuntime);
    wakeButton.disabled = !activeSessionId || wakeRequests.has(activeSessionId);
    wakeButton.textContent = wakeRequests.has(activeSessionId) ? "Waking…" : "Wake";
    wakeButton.setAttribute("aria-busy", String(wakeRequests.has(activeSessionId)));
    document.querySelectorAll("[data-wake-session]").forEach((button) => {
        button.disabled = wakeRequests.has(button.dataset.wakeSession);
    });
    compact.disabled = !hasRuntime || isCompacting;
    stop.hidden = !hasRuntime || isCompacting || (runState !== "running" && runState !== "stopping");
}
function positionSessionMenu(actions) {
    const menu = actions.querySelector(".session-menu");
    const trigger = actions.querySelector("summary");
    const sidebar = document.querySelector("#session-sidebar");
    if (!menu || !trigger || !sidebar)
        return;
    const sidebarRect = sidebar.getBoundingClientRect();
    const minX = Math.max(sidebarRect.left + 4, 8);
    const maxX = Math.min(sidebarRect.right - 4, window.innerWidth - 8);
    menu.style.maxWidth = `${Math.max(0, maxX - minX)}px`;
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`;
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const left = Math.max(minX, Math.min(triggerRect.right - menuRect.width, maxX - menuRect.width));
    const maxY = Math.max(8, window.innerHeight - 8 - menuRect.height);
    let top = triggerRect.bottom;
    if (top > maxY && triggerRect.top - menuRect.height >= 8)
        top = triggerRect.top - menuRect.height;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.min(Math.max(8, top), maxY)}px`;
}
function repositionOpenSessionMenus() {
    document.querySelectorAll(".session-actions[open]").forEach((actions) => positionSessionMenu(actions));
}
document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Node))
        return;
    if (modelPickerOpen && !modelInfo.contains(event.target))
        closeModelPicker();
    document.querySelectorAll(".session-actions[open]").forEach((actions) => {
        if (!actions.contains(event.target))
            actions.open = false;
    });
});
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape")
        return;
    if (modelPickerOpen)
        closeModelPicker(true);
    const openMenus = document.querySelectorAll(".session-actions[open]");
    openMenus.forEach((actions) => {
        actions.open = false;
        actions.querySelector("summary")?.focus();
    });
});
window.addEventListener("resize", repositionOpenSessionMenus);
const MIN_COMPOSER_HEIGHT = 96;
const MIN_CONVERSATION_HEIGHT = 96;
function outerHeight(element) {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height
        + Number.parseFloat(style.marginTop)
        + Number.parseFloat(style.marginBottom);
}
function composerHeightBounds() {
    const paneHeight = conversationPane.clientHeight;
    const fixedHeight = outerHeight(status)
        + outerHeight(contextPanel)
        + outerHeight(composerSplitter)
        + Number.parseFloat(getComputedStyle(conversation).marginBottom);
    const roomAfterConversation = Math.max(0, paneHeight - fixedHeight - MIN_CONVERSATION_HEIGHT);
    const maximum = Math.floor(Math.min(paneHeight * 0.4, roomAfterConversation));
    return { minimum: Math.min(MIN_COMPOSER_HEIGHT, maximum), maximum };
}
let composerHeight = null;
function setComposerHeight(value, persist = false) {
    const { minimum, maximum } = composerHeightBounds();
    const height = Math.max(minimum, Math.min(maximum, Math.round(value)));
    const wasFollowing = isNearConversationBottom();
    composerHeight = height;
    composerForm.style.setProperty("--composer-height", `${height}px`);
    composerSplitter.setAttribute("aria-valuemin", String(minimum));
    composerSplitter.setAttribute("aria-valuemax", String(maximum));
    composerSplitter.setAttribute("aria-valuenow", String(height));
    composerSplitter.setAttribute("aria-valuetext", `${height} pixels`);
    if (persist) {
        try {
            localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(height));
        }
        catch {
        }
    }
    requestAnimationFrame(() => {
        if (wasFollowing)
            conversation.scrollTop = conversation.scrollHeight;
    });
    return height;
}
function initializeComposerHeight() {
    let saved;
    try {
        const value = Number(readMigratedStorageValue(COMPOSER_HEIGHT_STORAGE_KEY, LEGACY_COMPOSER_HEIGHT_STORAGE_KEY));
        if (Number.isFinite(value) && value > 0)
            saved = value;
    }
    catch {
    }
    const initial = saved ?? Math.round(conversationPane.clientHeight * 0.24);
    const height = setComposerHeight(initial);
    if (saved !== undefined && height !== saved) {
        try {
            localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(height));
        }
        catch {
        }
    }
    composerHeightInitialized = true;
}
let composerHeightInitialized = false;
const composerResizeObserver = new ResizeObserver(() => {
    if (composerHeightInitialized) {
        setComposerHeight(composerHeight, true);
    }
});
composerResizeObserver.observe(conversationPane);
composerResizeObserver.observe(document.querySelector("#app-shell"));
composerResizeObserver.observe(contextPanel);
composerResizeObserver.observe(status);
composerSplitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0)
        return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = composerHeight ?? composerForm.getBoundingClientRect().height;
    composerSplitter.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-composer");
    const move = (pointerEvent) => setComposerHeight(startHeight + startY - pointerEvent.clientY);
    const end = () => {
        document.body.classList.remove("resizing-composer");
        if (composerSplitter.hasPointerCapture(event.pointerId))
            composerSplitter.releasePointerCapture(event.pointerId);
        composerSplitter.removeEventListener("pointermove", move);
        composerSplitter.removeEventListener("pointerup", end);
        composerSplitter.removeEventListener("pointercancel", end);
        setComposerHeight(composerHeight, true);
    };
    composerSplitter.addEventListener("pointermove", move);
    composerSplitter.addEventListener("pointerup", end);
    composerSplitter.addEventListener("pointercancel", end);
});
composerSplitter.addEventListener("keydown", (event) => {
    const current = composerForm.getBoundingClientRect().height;
    const { minimum, maximum } = composerHeightBounds();
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        setComposerHeight(current + (event.key === "ArrowUp" ? 16 : -16), true);
    }
    else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setComposerHeight(event.key === "Home" ? minimum : maximum, true);
    }
});
window.addEventListener("resize", () => {
    if (composerHeightInitialized)
        setComposerHeight(composerHeight, true);
});
requestAnimationFrame(() => {
    initializeComposerHeight();
});
window.addEventListener("resize", positionModelPicker);
sessionList.addEventListener("scroll", repositionOpenSessionMenus);
function renderSessions() {
    sessionList.replaceChildren();
    const groups = new Map();
    for (const session of sessions) {
        const cwd = typeof session.cwd === "string" ? session.cwd : projectDirectory;
        if (!groups.has(cwd))
            groups.set(cwd, []);
        groups.get(cwd).push(session);
    }
    let groupIndex = 0;
    for (const [cwd, groupSessions] of groups) {
        const group = document.createElement("li");
        group.className = "session-group";
        group.dataset.cwd = cwd;
        const groupHeader = document.createElement("button");
        groupHeader.className = "session-group-header";
        groupHeader.type = "button";
        groupHeader.title = cwd;
        const expanded = !collapsedGroups.has(cwd);
        groupHeader.setAttribute("aria-expanded", String(expanded));
        groupHeader.setAttribute("aria-controls", `session-group-items-${groupIndex}`);
        const disclosure = document.createElement("span");
        disclosure.className = "session-group-disclosure";
        disclosure.setAttribute("aria-hidden", "true");
        disclosure.textContent = expanded ? "▼" : "▶";
        const label = document.createElement("span");
        label.className = "session-group-label";
        label.textContent = cwd;
        const activeCount = groupSessions.filter((session) => session.active === true).length;
        const activeIndicator = document.createElement("span");
        activeIndicator.className = "session-group-active";
        activeIndicator.hidden = activeCount === 0;
        activeIndicator.textContent = `${activeCount} active`;
        groupHeader.append(disclosure, label, activeIndicator);
        groupHeader.addEventListener("click", () => {
            if (collapsedGroups.has(cwd))
                collapsedGroups.delete(cwd);
            else
                collapsedGroups.add(cwd);
            saveCollapsedGroups();
            renderSessions();
        });
        const groupItems = document.createElement("ul");
        groupItems.className = "session-group-items";
        groupItems.id = `session-group-items-${groupIndex++}`;
        groupItems.hidden = !expanded;
        for (const session of groupSessions) {
        const item = document.createElement("li");
        item.className = "session-row";
        item.setAttribute("aria-current", String(session.id === activeSessionId));
        item.dataset.runtimeState = runtimeStates.get(session.id)?.state ?? "idle";
        const select = document.createElement("button");
        select.className = "session-select session-switch";
        select.type = "button";
        select.title = session.preview;
        const dot = document.createElement("span");
        dot.className = "session-active-dot";
        dot.hidden = session.active !== true;
        dot.setAttribute("aria-label", "Pi runtime active");
        const copy = document.createElement("span");
        copy.className = "session-copy";
        const title = document.createElement("span");
        title.className = "session-title";
        title.textContent = session.name || session.preview;
        const preview = document.createElement("span");
        preview.className = "session-preview";
        preview.textContent = new Date(session.updatedAt).toLocaleString();
        copy.append(title, preview);
        select.append(dot, copy);
        select.addEventListener("click", () => {
            pendingComposerSwitch = {
                targetSessionId: session.id,
                previousSessionId: activeSessionId,
                inputValue: input.value,
                previousDraft: activeSessionId ? draftsBySession.get(activeSessionId) : undefined,
            };
            void sessionAction("/api/sessions/switch", { sessionId: session.id }).finally(() => {
                if (pendingComposerSwitch?.targetSessionId === session.id)
                    pendingComposerSwitch = null;
            });
        });
        const actions = document.createElement("details");
        actions.className = "session-actions";
        actions.addEventListener("toggle", () => {
            if (actions.open)
                positionSessionMenu(actions);
        });
        const menuButton = document.createElement("summary");
        menuButton.textContent = "···";
        menuButton.setAttribute("aria-label", `Actions for ${session.name || session.preview}`);
        const menu = document.createElement("span");
        menu.className = "session-menu";
        const runtimeFailed = runtimeStates.get(session.id)?.state === "failed";
        if (session.active !== true && (session.hasRuntime !== true || runtimeFailed)) {
            const wake = document.createElement("button");
            wake.type = "button";
            wake.className = "session-mutation";
            wake.textContent = "Wake session";
            wake.dataset.wakeSession = session.id;
            wake.setAttribute("aria-label", `Wake session ${session.name || session.preview}`);
            wake.disabled = wakeRequests.has(session.id);
            wake.addEventListener("click", () => {
                actions.open = false;
                void wakeSession(session.id);
            });
            menu.append(wake);
        }
        const rename = document.createElement("button");
        rename.type = "button";
        rename.className = "session-mutation";
        rename.textContent = "Rename";
        rename.setAttribute("aria-label", `Rename ${session.name || session.preview}`);
        rename.addEventListener("click", () => {
            const entered = window.prompt("Name this Pi session:", session.name || "");
            if (entered !== null)
                void sessionAction("/api/sessions/rename", { sessionId: session.id, name: entered });
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "session-mutation";
        remove.textContent = "Delete";
        remove.setAttribute("aria-label", `Delete ${session.name || session.preview}`);
        remove.addEventListener("click", () => {
            const name = session.name || session.preview;
            if (window.confirm(`Delete "${name}"?\n\nThis removes the persisted Pi session.`)) {
                void sessionAction("/api/sessions/delete", { sessionId: session.id });
            }
        });
        menu.append(rename, remove);
        if (session.active === true || session.hasRuntime === true) {
            if (session.active === true) {
                const stopBackground = document.createElement("button");
                stopBackground.type = "button";
                stopBackground.textContent = "Stop work";
                stopBackground.setAttribute("aria-label", `Stop ${session.name || session.preview}`);
                stopBackground.hidden = session.id === activeSessionId ||
                    runtimeStates.get(session.id)?.state !== "running" ||
                    runtimeStates.get(session.id)?.isCompacting === true;
                stopBackground.addEventListener("click", () => {
                    void post("/api/stop", { sessionId: session.id }).catch((error) => setStatus(error instanceof Error ? error.message : "Pi could not be stopped.", "error"));
                });
                menu.append(stopBackground);
            }
            const release = document.createElement("button");
            release.type = "button";
            release.textContent = "Close runtime";
            release.setAttribute("aria-label", `Close runtime for ${session.name || session.preview}`);
            release.addEventListener("click", () => {
                void sessionAction("/api/sessions/release", { sessionId: session.id });
            });
            menu.append(release);
        }
        actions.append(menuButton, menu);
        item.append(select, actions);
        groupItems.append(item);
        }
        group.append(groupHeader, groupItems);
        sessionList.append(group);
    }
    updateSessionControls();
}
function updateStatusIndicator() {
    const selectedSession = sessions.find((session) => session.id === activeSessionId);
    const selectedRuntime = activeSessionId ? runtimeStates.get(activeSessionId) : undefined;
    const runtimeExists = selectedSession?.hasRuntime === true;
    const state = runtimeExists ? selectedRuntime?.state ?? runState : "idle";
    const indicatorState = runtimeExists && (state === "failed" || selectedRuntime?.status?.kind === "error")
        ? "error"
        : runtimeExists && (state === "running" || state === "stopping" || selectedRuntime?.isCompacting === true)
            ? "running"
            : "idle";
    const appearance = indicatorState === "error"
        ? { color: "#ef5350", shape: '<path d="M6 6l12 12M18 6L6 18" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>' }
        : indicatorState === "running"
            ? { color: "#f4c542", shape: '<circle cx="12" cy="12" r="5" fill="#fff"/>' }
            : { color: "#48bd70", shape: '<path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>' };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="5" fill="#171c24"/><circle cx="12" cy="12" r="9" fill="${appearance.color}"/>${appearance.shape}</svg>`;
    statusFavicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    statusFavicon.dataset.state = indicatorState;
    document.title = indicatorState === "error" ? "Pi - Error" : indicatorState === "running" ? "pi - Running" : "pi - Ready";
}
function clearTranscript() {
    for (const message of userMessages.values())
        for (const previewUrl of message.previewUrls)
            URL.revokeObjectURL(previewUrl);
    conversation.replaceChildren();
    assistants.clear();
    tools.clear();
    userMessages.clear();
    activeAssistant = undefined;
}
function renderTranscript(value) {
    clearTranscript();
    if (!Array.isArray(value))
        return;
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null)
            continue;
        const item = entry;
        if (typeof item.id !== "string")
            continue;
        if (item.type === "user" && typeof item.text === "string") {
            addUserMessage(item.text, item.id, "sent", item.imageCount);
        }
        else if (item.type === "assistant" && typeof item.text === "string") {
            assistantStart(item.id);
            const assistant = assistants.get(item.id);
            if (assistant) {
                assistant.source = item.text;
                renderAssistantMarkdown(assistant);
            }
            if (typeof item.thinking === "string" && item.thinking)
                updateThinking(item.id, item.thinking);
        }
        else if (item.type === "tool" &&
            typeof item.toolCallId === "string" && typeof item.toolName === "string") {
            toolStart({
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                input: typeof item.input === "string" ? item.input : "",
            });
            const tool = tools.get(item.toolCallId);
            if (tool) {
                const isError = item.isError === true;
                const hasOutput = typeof item.output === "string" && item.output.length > 0;
                if (hasOutput || isError) {
                    toolEnd({
                        toolCallId: item.toolCallId,
                        toolName: item.toolName,
                        output: item.output,
                        isError,
                    });
                }
                else {
                    tool.details.dataset.state = "history";
                    tool.state.textContent = "result unavailable";
                }
            }
        }
        else if (item.type === "custom" && typeof item.text === "string") {
            const article = document.createElement("article");
            article.className = "message custom";
            const heading = document.createElement("h2");
            heading.textContent = "Pi extension";
            const body = document.createElement("p");
            body.textContent = item.text;
            article.append(heading, body);
            conversation.append(article);
        }
    }
}
function statusValueFrom(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const status = value;
    if (typeof status.kind !== "string" || typeof status.message !== "string")
        return undefined;
    return { kind: status.kind, message: status.message };
}
function applySnapshot(value) {
    const nextSessionId = typeof value.selectedSessionId === "string"
        ? value.selectedSessionId
        : typeof value.activeSessionId === "string" ? value.activeSessionId : null;
    if (nextSessionId !== activeSessionId) {
        closeModelPicker();
        switchComposerSession(nextSessionId);
    }
    activeSessionId = nextSessionId;
    if (typeof value.state === "string")
        setRunState(value.state);
    updateCompactionState(value.isCompacting === true);
    updateContext(value.context);
    updateModel(value.model);
    renderPendingAttachments();
    if (typeof value.projectDirectory === "string" && projectDirectory !== value.projectDirectory) {
        projectDirectory = value.projectDirectory;
        projectDirectoryLabel.textContent = projectDirectory;
        projectDirectoryLabel.title = projectDirectory;
        projectPath.value = projectDirectory;
    }
    sessions = Array.isArray(value.sessions) ? value.sessions : [];
    queuedMessages = Array.isArray(value.queuedMessages)
        ? value.queuedMessages.filter((item) => typeof item === "object" && item !== null && typeof item.id === "string" && typeof item.message === "string")
        : [];
    if (activeSessionId) {
        const selectedView = runtimeView(activeSessionId);
        selectedView.state = runState;
        selectedView.isCompacting = isCompacting;
        selectedView.context = value.context;
        selectedView.model = value.model;
        selectedView.queuedMessages = queuedMessages.map((item) => ({ ...item }));
        selectedView.status = statusValueFrom(value.status);
    }
    for (const session of sessions) {
        if (session.active !== true && session.hasRuntime !== true && session.id !== activeSessionId) {
            runtimeStates.delete(session.id);
        }
        for (const sessionId of attachmentsBySession.keys()) {
            if (!sessions.some((session) => session.id === sessionId))
                disposeComposerSession(sessionId);
        }
    }
    renderSessions();
    renderTranscript(value.transcript);
    for (const queued of queuedMessages)
        addUserMessage(queued.message, queued.id, "queued", queued.imageCount);
    const statusValue = statusValueFrom(value.status);
    if (statusValue) {
        if (statusValue.kind === "compaction") {
            contextStatus.textContent = statusValue.message;
            contextStatus.dataset.state = statusValue.message.includes("failed") ? "error" : "info";
        }
        setStatus(statusValue.message, statusValue.kind === "error" ? "error" : runState);
    }
    else if (runState !== "failed") {
        setStatus("");
    }
    updateSessionControls();
    updateStatusIndicator();
}
function setStatus(message, state = runState) {
    status.textContent = message;
    status.dataset.state = state;
}
function setRunState(state, error) {
    runState = state;
    input.placeholder = state === "running" || state === "stopping"
        ? "Message Pi to redirect the current run..."
        : "Message Pi...";
    stop.hidden = isCompacting || (state !== "running" && state !== "stopping");
    stop.disabled = state === "stopping";
    if (error)
        setStatus(error, "error");
    else if (state === "running")
        setStatus("Pi is responding...");
    else if (state === "stopping")
        setStatus("Stopping Pi...");
    else if (state === "failed")
        setStatus("Pi is disconnected.", "error");
    else if (status.dataset.state !== "error")
        setStatus("");
    updateSessionControls();
    updateStatusIndicator();
}
function addUserMessage(text, id, deliveryState = "sending", imageCount = 0, imagePreviews = []) {
    const existing = userMessages.get(id);
    if (existing) {
        addLocalImagePreviews(existing, imagePreviews);
        setDeliveryState(id, deliveryState);
        return;
    }
    const wasFollowing = isNearConversationBottom();
    const article = document.createElement("article");
    article.className = "message user";
    article.dataset.messageId = id;
    const heading = document.createElement("h2");
    const body = document.createElement("p");
    const attachmentEntries = document.createElement("div");
    attachmentEntries.className = "image-message-attachments";
    const previewUrls = [];
    if (Array.isArray(imagePreviews) && imagePreviews.length) {
        for (const attachment of imagePreviews) {
            const preview = document.createElement("img");
            const previewUrl = URL.createObjectURL(attachment.file);
            preview.src = previewUrl;
            preview.alt = attachment.name;
            preview.title = attachment.name;
            previewUrls.push(previewUrl);
            attachmentEntries.append(preview);
        }
    }
    else {
        for (let index = 0; index < imageCount; index++) {
            const placeholder = document.createElement("span");
            placeholder.className = "image-message-placeholder";
            placeholder.textContent = "[Image attachment]";
            attachmentEntries.append(placeholder);
        }
    }
    const delivery = document.createElement("p");
    delivery.className = "message-delivery";
    delivery.dataset.state = deliveryState;
    delivery.hidden = deliveryState === "sending";
    delivery.textContent = deliveryState === "queued"
        ? "Queued until compaction completes"
        : deliveryState === "failed"
            ? "Message was not sent"
            : "Sending to Pi…";
    heading.textContent = "You";
    body.textContent = text;
    article.append(heading, body);
    if (imageCount > 0 || imagePreviews.length > 0)
        article.append(attachmentEntries);
    article.append(delivery);
    conversation.append(article);
    userMessages.set(id, { article, attachmentEntries, delivery, previewUrls });
    followLatestIfNeeded(wasFollowing);
}
function addLocalImagePreviews(userMessage, attachments) {
    if (!attachments.length || userMessage.previewUrls.length)
        return;
    const wasFollowing = isNearConversationBottom();
    userMessage.attachmentEntries.replaceChildren();
    for (const attachment of attachments) {
        const preview = document.createElement("img");
        const previewUrl = URL.createObjectURL(attachment.file);
        preview.src = previewUrl;
        preview.alt = attachment.name;
        preview.title = attachment.name;
        userMessage.previewUrls.push(previewUrl);
        userMessage.attachmentEntries.append(preview);
    }
    if (!userMessage.attachmentEntries.isConnected)
        userMessage.delivery.before(userMessage.attachmentEntries);
    followLatestIfNeeded(wasFollowing);
}
function setDeliveryState(id, deliveryState, error) {
    const userMessage = userMessages.get(id);
    if (!userMessage)
        return;
    if (deliveryState === "sent") {
        userMessage.delivery.remove();
        return;
    }
    userMessage.delivery.hidden = false;
    userMessage.delivery.dataset.state = deliveryState;
    userMessage.delivery.textContent = deliveryState === "queued"
        ? "Queued until compaction completes"
        : deliveryState === "failed"
            ? `Not sent: ${error || "Pi could not accept this message."}`
            : "Sending to Pi…";
}
function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
}
function updateContext(value) {
    if (typeof value !== "object" || value === null)
        return;
    const context = value;
    latestContext = {
        tokens: typeof context.tokens === "number" && Number.isFinite(context.tokens) ? context.tokens : null,
        contextWindow: typeof context.contextWindow === "number" && Number.isFinite(context.contextWindow)
            ? context.contextWindow
            : null,
        percent: typeof context.percent === "number" && Number.isFinite(context.percent) ? context.percent : null,
    };
    renderContext();
}
function renderContext() {
    const { tokens, percent } = latestContext;
    const liveWindow = latestContext.contextWindow && latestContext.contextWindow > 0
        ? latestContext.contextWindow
        : null;
    const estimateAvailable = tokens !== null && liveWindow !== null && percent !== null;
    const windowSize = liveWindow ?? (!estimateAvailable ? modelContextWindow : null);
    if (!estimateAvailable || windowSize === null || windowSize <= 0) {
        contextValue.textContent = windowSize && windowSize > 0
            ? `Context unavailable · ${formatNumber(windowSize)} window`
            : "Context unavailable";
        contextPercent.textContent = "Unavailable";
        contextMeter.value = 0;
        contextMeter.removeAttribute("aria-valuenow");
        delete contextMeter.dataset.level;
        return;
    }
    const roundedPercent = Math.round(percent);
    contextValue.textContent = `${formatNumber(tokens)} / ${formatNumber(windowSize)}`;
    contextPercent.textContent = `${roundedPercent}%`;
    contextMeter.value = Math.max(0, Math.min(percent, 100));
    contextMeter.setAttribute("aria-valuenow", String(contextMeter.value));
    contextMeter.dataset.level = percent >= CONTEXT_CRITICAL_PERCENT
        ? "critical"
        : percent >= CONTEXT_WARNING_PERCENT
            ? "warning"
            : "normal";
}
function updateModel(value) {
    if (typeof value !== "object" || value === null) {
        modelContextWindow = null;
        modelSupportsImageInput = null;
        modelName.textContent = "Unavailable";
        modelName.title = "Unavailable";
        modelTrigger.setAttribute("aria-label", "Current model: Unavailable");
        renderContext();
        renderPendingAttachments();
        return;
    }
    const model = value;
    modelSupportsImageInput = Array.isArray(model.input) && model.input.every((item) => typeof item === "string")
        ? model.input.includes("image")
        : null;
    modelContextWindow = typeof model.contextWindow === "number" &&
        Number.isFinite(model.contextWindow) && model.contextWindow > 0
        ? model.contextWindow
        : null;
    modelName.textContent = typeof model.provider === "string" && typeof model.name === "string"
        ? `${model.provider} / ${model.name}`
        : typeof model.provider === "string" && typeof model.id === "string"
            ? `${model.provider} / ${model.id}`
            : "Unavailable";
    modelName.title = modelName.textContent;
    modelTrigger.setAttribute("aria-label", `Current model: ${modelName.textContent}`);
    renderContext();
    renderPendingAttachments();
}
function updateCompactionState(compacting) {
    isCompacting = compacting;
    compact.disabled = compacting;
    compact.textContent = compacting ? "Compacting…" : "Compact";
    stop.hidden = compacting || (runState !== "running" && runState !== "stopping");
    if (!compacting)
        contextStatus.textContent = "";
    else {
        contextStatus.dataset.state = "active";
        contextStatus.textContent = "Pi is compacting. New messages will be queued.";
    }
    updateSessionControls();
    updateStatusIndicator();
}
function assistantStart(messageId) {
    const wasFollowing = isNearConversationBottom();
    const article = document.createElement("article");
    article.className = "message assistant";
    article.dataset.messageId = messageId;
    const heading = document.createElement("h2");
    const thinkingSlot = document.createElement("div");
    const text = document.createElement("div");
    heading.textContent = "Assistant";
    text.className = "assistant-text";
    article.append(heading, thinkingSlot, text);
    conversation.append(article);
    const assistant = { article, text, source: "" };
    article.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const button = target.closest("button[data-copy-code]");
        const codeBlock = button?.closest(".code-block");
        const code = codeBlock?.querySelector("pre > code");
        if (button && code)
            void copyCode(button, code.textContent ?? "");
    });
    assistants.set(messageId, assistant);
    activeAssistant = article;
    followLatestIfNeeded(wasFollowing);
}
function escapeMarkdownHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    })[character]);
}
const markdownRenderer = new window.marked.Renderer();
markdownRenderer.html = ({ text }) => escapeMarkdownHtml(text);
markdownRenderer.link = ({ href, text }) => {
    const safeHref = safeMarkdownHref(href, window.location.href);
    if (!safeHref)
        return text;
    return `<a href="${escapeMarkdownHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
};
markdownRenderer.image = ({ text }) => escapeMarkdownHtml(text);
markdownRenderer.code = ({ text, lang }) => {
    const rawLanguage = typeof lang === "string" ? lang.trim().split(/\s+/, 1)[0] : "";
    const language = supportedMarkdownLanguage(rawLanguage, (name) => window.hljs?.getLanguage(name));
    const label = rawLanguage || "Code";
    let highlighted = escapeMarkdownHtml(text);
    if (language && window.hljs?.getLanguage(language)) {
        try {
            highlighted = window.hljs.highlight(text, { language, ignoreIllegals: true }).value;
        }
        catch {
        }
    }
    const className = language ? ` class="language-${escapeMarkdownHtml(language)}"` : "";
    return `<figure class="code-block"><figcaption class="code-header"><span class="code-language">${escapeMarkdownHtml(label)}</span><button type="button" data-copy-code aria-label="Copy code">Copy</button></figcaption><pre><code${className}>${highlighted}</code></pre></figure>`;
};
function renderAssistantMarkdown(assistant) {
    const wasFollowing = isNearConversationBottom();
    try {
        const rendered = window.marked.parse(assistant.source, {
            gfm: true,
            breaks: false,
            renderer: markdownRenderer,
        });
        const template = document.createElement("template");
        template.innerHTML = rendered;
        assistant.text.replaceChildren(template.content);
    }
    catch {
        assistant.text.textContent = assistant.source;
    }
    followLatestIfNeeded(wasFollowing);
}
async function copyCode(button, code) {
    try {
        if (!navigator.clipboard?.writeText)
            throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(code);
        button.textContent = "Copied";
    }
    catch {
        button.textContent = "Copy failed";
    }
    window.setTimeout(() => {
        if (button.isConnected)
            button.textContent = "Copy";
    }, 1400);
}
function appendText(element, text) {
    const wasFollowing = isNearConversationBottom();
    element.textContent += text;
    followLatestIfNeeded(wasFollowing);
}
function updateThinking(messageId, text, replace = false) {
    const assistant = assistants.get(messageId);
    if (!assistant)
        return;
    const wasFollowing = isNearConversationBottom();
    if (!assistant.thinking) {
        const details = document.createElement("details");
        details.className = "thinking";
        const summary = document.createElement("summary");
        const content = document.createElement("pre");
        content.className = "thinking-content";
        summary.textContent = "Thinking";
        details.append(summary, content);
        assistant.article.children[1].append(details);
        assistant.thinking = content;
    }
    if (replace)
        assistant.thinking.textContent = text;
    else
        appendText(assistant.thinking, text);
    followLatestIfNeeded(wasFollowing);
}
function toolStart(event) {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string")
        return;
    const wasFollowing = isNearConversationBottom();
    const details = document.createElement("details");
    details.className = "tool";
    details.dataset.state = "running";
    const summary = document.createElement("summary");
    const name = document.createElement("span");
    const state = document.createElement("span");
    const content = document.createElement("pre");
    name.textContent = `${event.toolName} ${String(event.input ?? "").split("\n")[0]}`.trim();
    state.textContent = "running";
    state.className = "tool-state";
    content.className = "tool-content";
    content.textContent = `Input:\n${String(event.input ?? "{}")}`;
    summary.append(name, state);
    details.append(summary, content);
    (activeAssistant ?? conversation).append(details);
    tools.set(event.toolCallId, { details, summary: name, state, content });
    followLatestIfNeeded(wasFollowing);
}
function toolUpdate(event) {
    if (typeof event.toolCallId !== "string")
        return;
    const tool = tools.get(event.toolCallId);
    if (tool) {
        const wasFollowing = isNearConversationBottom();
        tool.content.textContent = `Output:\n${String(event.output ?? "")}`;
        followLatestIfNeeded(wasFollowing);
    }
}
function toolEnd(event) {
    if (typeof event.toolCallId !== "string")
        return;
    const tool = tools.get(event.toolCallId);
    if (!tool)
        return;
    const wasFollowing = isNearConversationBottom();
    const isError = event.isError === true;
    tool.details.dataset.state = isError ? "error" : "complete";
    tool.state.textContent = isError ? "error" : "✓";
    tool.content.textContent = `Output:\n${String(event.output ?? "")}`;
    followLatestIfNeeded(wasFollowing);
}
function handleEvent(event) {
    if (typeof event !== "object" || event === null)
        return;
    const message = event;
    const eventSessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    const owningSessionId = eventSessionId ?? activeSessionId;
    if (owningSessionId && message.type === "queued_message" && typeof message.id === "string") {
        queueSet(owningSessionId).add(message.id);
        if (owningSessionId === activeSessionId)
            updateSendButton();
    }
    if (owningSessionId && message.type === "queued_message_sent" && typeof message.id === "string")
        settleQueuedSubmission(owningSessionId, message.id, true);
    if (owningSessionId && message.type === "queued_message_failed" && typeof message.id === "string") {
        settleQueuedSubmission(
            owningSessionId,
            message.id,
            false,
            typeof message.error === "string" ? message.error : undefined,
        );
    }
    if (eventSessionId) {
        const state = runtimeView(eventSessionId);
        if (message.type === "state" && typeof message.state === "string") {
            state.state = message.state;
            if (message.state === "idle" || message.state === "running")
                state.status = undefined;
        }
        if (message.type === "context_update")
            state.context = message.context;
        if (message.type === "model_update")
            state.model = message.model;
        if (message.type === "compaction_start")
            state.isCompacting = true;
        if (message.type === "compaction_end")
            state.isCompacting = false;
        if (message.type === "queued_message" && typeof message.id === "string" && typeof message.message === "string" &&
            !state.queuedMessages.some((item) => item.id === message.id)) {
            state.queuedMessages.push({ id: message.id, message: message.message });
        }
        if ((message.type === "queued_message_sent" || message.type === "queued_message_failed") &&
            typeof message.id === "string") {
            state.queuedMessages = state.queuedMessages.filter((item) => item.id !== message.id);
        }
        if (message.type === "notice" && typeof message.message === "string") {
            state.status = { kind: "notice", message: message.message };
        }
        else if (message.type === "error" && typeof message.message === "string") {
            state.status = { kind: "error", message: message.message };
        }
        else if (message.type === "compaction_end" && typeof message.error === "string") {
            state.status = { kind: "compaction", message: message.error };
        }
        if (message.type === "session_snapshot" &&
            typeof message.snapshot === "object" && message.snapshot !== null) {
            const snapshot = message.snapshot;
            if (typeof snapshot.state === "string")
                state.state = snapshot.state;
            state.isCompacting = snapshot.isCompacting === true;
            state.context = snapshot.context;
            state.model = snapshot.model;
            state.queuedMessages = Array.isArray(snapshot.queuedMessages)
                ? snapshot.queuedMessages.filter((item) => typeof item === "object" && item !== null && typeof item.id === "string" && typeof item.message === "string")
                : [];
            state.status = statusValueFrom(snapshot.status);
            if (Array.isArray(snapshot.sessions)) {
                sessions = snapshot.sessions;
                renderSessions();
            }
            if (eventSessionId !== activeSessionId)
                return;
        }
        else if (eventSessionId !== activeSessionId) {
            renderSessions();
            return;
        }
    }
    switch (message.type) {
        case "snapshot":
            applySnapshot(message);
            break;
        case "session_snapshot":
            if (typeof message.snapshot === "object" && message.snapshot !== null) {
                applySnapshot(message.snapshot);
            }
            break;
        case "state":
            if (typeof message.state === "string")
                setRunState(message.state, typeof message.error === "string" ? message.error : undefined);
            break;
        case "context_update":
            updateContext(message.context);
            break;
        case "model_update":
            updateModel(message.model);
            break;
        case "compaction_start":
            updateCompactionState(true);
            contextStatus.textContent = message.reason === "manual"
                ? "Pi is compacting the session…"
                : `Pi started ${typeof message.reason === "string" ? message.reason : ""} compaction…`;
            break;
        case "compaction_end":
            updateCompactionState(false);
            if (message.success === true) {
                contextStatus.textContent = "Compaction complete.";
                contextStatus.dataset.state = "complete";
            }
            else if (message.informational === true) {
                contextStatus.textContent = "Nothing to compact yet.";
                contextStatus.dataset.state = "info";
            }
            else {
                const reason = message.aborted === true ? "Compaction was aborted." :
                    typeof message.error === "string" ? message.error : "Compaction failed; the session is still available.";
                contextStatus.textContent = reason;
                contextStatus.dataset.state = "error";
                setStatus(reason, "error");
            }
            break;
        case "queued_message":
            if (typeof message.id === "string" && typeof message.message === "string") {
                if (!queuedMessages.some((queued) => queued.id === message.id)) {
                    queuedMessages.push({ id: message.id, message: message.message });
                }
                const imageCount = Number.isInteger(message.imageCount) && message.imageCount > 0
                    ? message.imageCount
                    : 0;
                addUserMessage(message.message, message.id, "queued", imageCount);
                updateSessionControls();
            }
            break;
        case "queued_message_sent":
            if (typeof message.id === "string") {
                queuedMessages = queuedMessages.filter((queued) => queued.id !== message.id);
                setDeliveryState(message.id, "sent");
                updateSessionControls();
            }
            break;
        case "queued_message_failed":
            if (typeof message.id === "string") {
                queuedMessages = queuedMessages.filter((queued) => queued.id !== message.id);
                setDeliveryState(message.id, "failed", typeof message.error === "string" ? message.error : undefined);
                updateSessionControls();
            }
            break;
        case "assistant_start":
            if (typeof message.messageId === "string")
                assistantStart(message.messageId);
            break;
        case "assistant_delta": {
            const assistant = typeof message.messageId === "string" ? assistants.get(message.messageId) : undefined;
            if (assistant && typeof message.text === "string") {
                assistant.source += message.text;
                renderAssistantMarkdown(assistant);
            }
            break;
        }
        case "thinking_delta":
            if (typeof message.messageId === "string" && typeof message.text === "string") {
                updateThinking(message.messageId, message.text);
            }
            break;
        case "assistant_end": {
            const assistant = typeof message.messageId === "string" ? assistants.get(message.messageId) : undefined;
            if (assistant && typeof message.text === "string") {
                assistant.source = message.text;
                renderAssistantMarkdown(assistant);
            }
            if (typeof message.messageId === "string" && typeof message.thinking === "string") {
                if (message.thinking)
                    updateThinking(message.messageId, message.thinking, true);
                else
                    assistants.get(message.messageId)?.thinking?.parentElement?.remove();
            }
            break;
        }
        case "tool_start":
            toolStart(message);
            break;
        case "tool_update":
            toolUpdate(message);
            break;
        case "tool_end":
            toolEnd(message);
            break;
        case "notice":
            if (typeof message.message === "string")
                setStatus(message.message, "error");
            break;
        case "error":
            if (typeof message.message === "string")
                setStatus(message.message, "error");
            break;
        case "input_disposition":
            if (message.disposition === "handled") {
                setStatus("Pi handled that input without starting a normal agent response.");
            }
            else if (message.disposition === "steered") {
                setStatus("Message sent to steer the current run.");
            }
            break;
    }
}
const events = new EventSource("/api/events");
events.onmessage = (event) => {
    try {
        handleEvent(JSON.parse(event.data));
    }
    catch {
        setStatus("Pi-vot received an invalid server event.", "error");
    }
};
events.onerror = () => {
    if (runState !== "failed")
        setStatus("Connection interrupted; reconnecting…", "error");
};
async function post(path, body) {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json());
    if (!response.ok) {
        throw new Error(typeof result.error === "string" ? result.error : "Pi-vot could not complete the request.");
    }
    if (result.disposition === "handled") {
        setStatus("Pi handled that input without starting a normal agent response.");
    }
    return result;
}
async function sessionAction(path, body = {}) {
    try {
        const result = await post(path, body);
        if (typeof result.projectDirectory === "string")
            applySnapshot(result);
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "Pi-vot could not complete the session operation.", "error");
    }
}
async function wakeSession(sessionId) {
    if (wakeRequests.has(sessionId))
        return;
    wakeRequests.add(sessionId);
    updateSessionControls();
    try {
        const result = await post("/api/sessions/wake", { sessionId });
        if (typeof result.projectDirectory === "string")
            applySnapshot(result);
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "Pi-vot could not wake this session.", "error");
    }
    finally {
        wakeRequests.delete(sessionId);
        updateSessionControls();
        renderSessions();
    }
}
function queueSet(sessionId) {
    let ids = queuedMessageIds.get(sessionId);
    if (!ids) {
        ids = new Set();
        queuedMessageIds.set(sessionId, ids);
    }
    return ids;
}
function settleQueuedSubmission(sessionId, messageId, succeeded, error) {
    const attempt = sendAttempts.get(messageId);
    queueSet(sessionId).delete(messageId);
    if (attempt && attempt.sessionId === sessionId) {
        if (succeeded)
            clearSentComposer(attempt);
        else if (activeSessionId === sessionId) {
            setDeliveryState(messageId, "failed", error);
            setStatus(error || "Pi could not accept the queued message.", "error");
        }
        attempt.queueSettled = succeeded;
        if (!attempt.responsePending)
            sendAttempts.delete(messageId);
    }
    else if (!succeeded && activeSessionId === sessionId) {
        setDeliveryState(messageId, "failed", error);
        setStatus(error || "Pi could not accept the queued message.", "error");
    }
    updateSendButton();
}
document.querySelector("#new-session").addEventListener("click", () => {
    void sessionAction("/api/sessions/new");
});
document.querySelector("#refresh-sessions").addEventListener("click", () => {
    void sessionAction("/api/sessions/refresh");
});
wakeButton.addEventListener("click", () => {
    if (activeSessionId)
        void wakeSession(activeSessionId);
});
document.querySelector("#select-project").addEventListener("click", () => {
    const directory = projectPath.value.trim();
    if (!directory || directory === projectDirectory) {
        void sessionAction("/api/sessions/refresh");
        return;
    }
    void sessionAction("/api/project/select", { directory });
});
document.querySelector("#pick-project").addEventListener("click", async () => {
    try {
        const result = await post("/api/project/pick", {});
        if (typeof result.directory === "string")
            projectPath.value = result.directory;
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "The directory picker is unavailable.", "error");
    }
});
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    const sessionId = activeSessionId;
    const attachments = [...pendingAttachments(sessionId)];
    if ((!message && attachments.length === 0) || !sessionId)
        return;
    const messageId = crypto.randomUUID();
    const attempt = { sessionId, messageId, message, attachments, responsePending: true, queueSettled: null };
    draftsBySession.set(sessionId, input.value);
    sendAttempts.set(messageId, attempt);
    updateSendButton();
    try {
        const images = await Promise.all(attachments.map(encodeAttachment));
        const result = await post("/api/message", { message, images, messageId, sessionId });
        attempt.responsePending = false;
        const resultId = typeof result.messageId === "string" ? result.messageId : messageId;
        const deliveryState = result.disposition === "queued"
            ? attempt.queueSettled === true ? "sent" : attempt.queueSettled === false ? "failed" : "queued"
            : "sending";
        addUserMessage(message, resultId, deliveryState, attachments.length, attachments);
        if (result.disposition === "queued") {
            if (attempt.queueSettled === null)
                setDeliveryState(resultId, "queued");
            if (attempt.queueSettled === null)
                queueSet(sessionId).add(resultId);
            else
                sendAttempts.delete(messageId);
        }
        else {
            setDeliveryState(resultId, "sent");
            clearSentComposer(attempt);
            attempt.queueSettled = true;
            sendAttempts.delete(messageId);
        }
    }
    catch (error) {
        attempt.responsePending = false;
        const detail = error instanceof Error ? error.message : undefined;
        if (attempt.queueSettled !== true) {
            addUserMessage(message, messageId, "failed", attachments.length, attachments);
            setDeliveryState(messageId, "failed", detail);
            setStatus(error instanceof Error ? error.message : "Could not connect to Pi-vot.", "error");
        }
        sendAttempts.delete(messageId);
    }
    updateSendButton();
    if (activeSessionId === sessionId)
        input.focus();
});
attachImages.addEventListener("click", () => imagePicker.click());
imagePicker.addEventListener("change", () => {
    addImageFiles(Array.from(imagePicker.files ?? []));
    imagePicker.value = "";
});
input.addEventListener("paste", (event) => {
    const files = [];
    for (const item of event.clipboardData?.items ?? []) {
        if (item.kind === "file" && item.type.toLowerCase().startsWith("image/")) {
            const file = item.getAsFile();
            if (file)
                files.push(file);
        }
    }
    if (!files.length)
        return;
    const includesText = [...(event.clipboardData?.items ?? [])].some((item) => item.kind === "string");
    if (!includesText)
        event.preventDefault();
    addImageFiles(files);
});
function hasFileDrag(event) {
    return [...(event.dataTransfer?.types ?? [])].includes("Files");
}
composerForm.addEventListener("dragenter", (event) => {
    if (!hasFileDrag(event))
        return;
    event.preventDefault();
    dropOverlay.hidden = false;
});
composerForm.addEventListener("dragover", (event) => {
    if (!hasFileDrag(event))
        return;
    event.preventDefault();
    if (event.dataTransfer)
        event.dataTransfer.dropEffect = "copy";
    dropOverlay.hidden = false;
});
composerForm.addEventListener("dragleave", (event) => {
    if (!(event.relatedTarget instanceof Node) || !composerForm.contains(event.relatedTarget))
        dropOverlay.hidden = true;
});
composerForm.addEventListener("drop", (event) => {
    if (!hasFileDrag(event))
        return;
    event.preventDefault();
    dropOverlay.hidden = true;
    addImageFiles([...event.dataTransfer.files]);
});
compact.addEventListener("click", async () => {
    try {
        await post("/api/compact", { sessionId: activeSessionId });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Pi could not compact the session.";
        contextStatus.textContent = message;
        contextStatus.dataset.state = "error";
        setStatus(message, "error");
    }
});
stop.addEventListener("click", async () => {
    try {
        await post("/api/stop", { sessionId: activeSessionId });
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "Pi could not be stopped.", "error");
    }
});
input.addEventListener("input", () => {
    if (activeSessionId)
        draftsBySession.set(activeSessionId, input.value);
    updateSendButton();
});
input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing)
        return;
    event.preventDefault();
    form.requestSubmit();
});
updateSendButton();
window.addEventListener("pagehide", () => {
    for (const attachments of attachmentsBySession.values())
        for (const attachment of attachments)
            URL.revokeObjectURL(attachment.previewUrl);
    for (const message of userMessages.values())
        for (const previewUrl of message.previewUrls)
            URL.revokeObjectURL(previewUrl);
});
