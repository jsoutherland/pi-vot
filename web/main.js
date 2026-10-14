import { safeMarkdownHref, supportedMarkdownLanguage } from "./markdown-security.js";

const form = document.querySelector("#message-form");
const input = document.querySelector("#message");
const messagePreviewToggle = document.querySelector("#message-preview-toggle");
const messagePreview = document.querySelector("#message-preview");
const messageMarkdownOverlay = document.querySelector("#message-markdown-overlay");
let messagePreviewOpen = false;
const stop = document.querySelector("#stop");
const compact = document.querySelector("#compact");
const conversation = document.querySelector("#conversation");
const queuedMessageArea = document.querySelector("#queued-message-area");
const queuedMessageList = document.querySelector("#queued-messages");
const queuedMessagesClearButton = document.querySelector("#queued-messages-clear");
const queuedMessagesToggle = document.querySelector("#queued-messages-toggle");
const historyLoading = document.querySelector("#history-loading");
const sessionHistoryLoading = document.querySelector("#session-history-loading");
const sessionHistoryLoadingCount = document.querySelector("#session-history-loading-count");
const sessionHistoryLoadingAnnouncement = document.querySelector("#session-history-loading-announcement");
const HISTORY_LOADING_INDICATOR_DELAY_MS = 2000;
const HISTORY_LOADING_COUNT_REFRESH_MS = 500;
const RUNNING_ACTIVITY_STALE_DELAY_MS = 12000;
const RUNNING_ACTIVITY_REFRESH_MS = 1000;
const MAX_PROMPT_HISTORY = 25;
const status = document.querySelector("#status");
const contextValue = document.querySelector("#context-value");
const contextMeter = document.querySelector("#context-meter");
const contextPercent = document.querySelector("#context-percent");
const bigPiIndicator = document.querySelector("#big-pi-indicator");
const bigPiTopLabel = document.querySelector("#big-pi-top-label");
const bigPiTitle = document.querySelector("#big-pi-title");
const bigPiDisk = document.querySelector("#big-pi-disk");
const bigPiTierOne = document.querySelector("#big-pi-t1");
const bigPiTierTwo = document.querySelector("#big-pi-t2");
const bigPiTierThree = document.querySelector("#big-pi-t3");
const bigPiTotal = document.querySelector("#big-pi-total");
const contextStatus = document.querySelector("#context-status");
const modelName = document.querySelector("#model-name");
const modelTrigger = document.querySelector("#model-trigger");
const warningIndicator = document.querySelector("#warning-indicator");
const warningCount = document.querySelector("#warning-count");
const warningDetails = document.querySelector("#warning-details");
const warningMessages = document.querySelector("#warning-messages");
const warningDismiss = document.querySelector("#warning-dismiss");
const helpButton = document.querySelector("#help-button");
const helpDialog = document.querySelector("#help-dialog");
const helpClose = document.querySelector("#help-close");
const helpContent = document.querySelector("#help-content");
const helpError = document.querySelector("#help-error");
let helpLoaded = false;
const modelInfo = document.querySelector("#model-info");
const modelPicker = document.querySelector("#model-picker");
const modelPickerStatus = document.querySelector("#model-picker-status");
const modelOptions = document.querySelector("#model-options");
const modelPickerMessage = document.querySelector("#model-picker-message");
const modelPickerRefresh = document.querySelector("#model-picker-refresh");
const promptTemplateSuggestions = document.querySelector("#prompt-template-suggestions");
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
const busyModePicker = document.querySelector("#busy-mode-picker");
const busyModeOptions = document.querySelector("#busy-mode-options");
const wakeButton = document.querySelector("#wake");
const conversationPane = document.querySelector("#conversation-pane");
const contextPanel = document.querySelector("#context-panel");
const statusFavicon = document.querySelector("#status-favicon");
const projectDirectoryLabel = document.querySelector("#project-directory");
const projectTrigger = document.querySelector("#project-trigger");
const projectPicker = document.querySelector("#project-picker");
const projectMenu = document.querySelector("#project-menu");
const sessionButtons = [
    document.querySelector("#new-session"),
    document.querySelector("#refresh-sessions"),
];
const assistants = new Map();
const tools = new Map();
const userMessages = new Map();
let activeAssistant;
let transcriptRenderGeneration = 0;
let transcriptHydrationSessionId = null;
let transcriptHydrationEvents = [];
const deferredCompactionEventsBySession = new Map();
const transcriptMutationEventTypes = new Set([
    "assistant_start", "assistant_delta", "assistant_end", "assistant_discard",
    "thinking_delta", "tool_start", "tool_update", "tool_end",
]);
let renderedTranscriptSessionId = null;
let renderedTranscriptIds = new Set();
let renderedTranscriptItems = new Map();
let renderedTranscriptMessageCount = 0;
let renderedHistoryRevision = null;
let historyHasOlder = false;
let historyBeforeId = null;
let historyRequestVersion = 0;
let historyLoadInProgress = false;
let olderHistoryLoaded = false;
let historyScrollAnchor = null;
let preservingHistoryScroll = false;
let selectedHistoryLoad = null;
let selectedHistoryLoadId = 0;
let selectionRequestId = 0;
let navigationRevision = 0;
let runState = "idle";
let isCompacting = false;
let manualCompactionKeepRecentTokens = 20_000;
let latestContext = {
    tokens: null,
    contextWindow: null,
    percent: null,
};
let modelContextWindow = null;
let modelSupportsImageInput = null;
let activeSessionId = null;
let hasReceivedInitialSnapshot = false;
let modelPickerRequest = 0;
let modelPickerTarget = null;
let modelPickerOpen = false;
const promptTemplateCommandsBySession = new Map();
let promptTemplateRequest = 0;
let promptTemplateSuggestionMatch = null;
let promptTemplateSuggestionIndex = -1;
let promptTemplateSuggestionSessionId = null;
let warningPinned = false;
let warningPointerInside = false;
let warningKeyboardFocused = false;
let warningCloseTimer;
let runningActivityTimer;
let compactionActivityTimer;
let compactionActivitySessionId;
let transientStatusTimer;
const dismissedWarningsBySession = new Map();
let projectDirectory = "";
let displayedProjectDirectory = "";
let updatingProjectMenu = false;
let sessions = [];
let queuedMessages = [];
const runtimeStates = new Map();
const promptHistoryByComposer = new Map();
const promptHistoryCursorByComposer = new Map();
const draftsBySession = new Map();
const attachmentsBySession = new Map();
const warningsBySession = new Map();
const compressionConflictWarnings = new Map();
const compactionNoticesBySession = new Map();
const messageTimestamps = new Map();
const sendAttempts = new Map();
const pendingSessionIds = new Map();
const wakeRequests = new Set();
const queuedMessageIds = new Map();
let pendingComposerSwitch = null;
const COLLAPSED_GROUPS_STORAGE_KEY = "pi-vot-collapsed-session-groups";
const BUSY_MODE_STORAGE_KEY = "pi-vot-busy-modes";
const COMPOSER_HEIGHT_STORAGE_KEY = "pi-vot-composer-height";
const RECENT_PROJECTS_STORAGE_KEY = "pi-vot-recent-projects";
const LEGACY_COLLAPSED_GROUPS_STORAGE_KEY = "pi-pane-collapsed-session-groups";
const LEGACY_COMPOSER_HEIGHT_STORAGE_KEY = "pi-pane-composer-height";
const MAX_RECENT_PROJECTS = 6;
const MAX_IMAGE_COUNT = 32;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_COLLAPSED_DETAIL_CHARS = 16_384;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
function normalizeProjectPath(path) {
    const isDrivePath = /^[a-z]:[\\/]/i.test(path);
    const isUncPath = path.startsWith("\\\\") || path.startsWith("//");
    const isWindowsPath = isDrivePath || isUncPath;
    if (isWindowsPath) {
        const normalized = path.replaceAll("/", "\\");
        const drive = /^([a-z]:)\\/i.exec(normalized);
        const prefix = drive ? `${drive[1]}\\` : isUncPath ? "\\\\" : "";
        const parts = normalized.slice(prefix.length).split(/\\+/);
        const rootParts = isUncPath ? 2 : 0;
        const normalizedParts = [];
        for (const part of parts) {
            if (!part || part === ".")
                continue;
            if (part === "..") {
                if (normalizedParts.length > rootParts && normalizedParts.at(-1) !== "..")
                    normalizedParts.pop();
                else if (!prefix)
                    normalizedParts.push(part);
                continue;
            }
            normalizedParts.push(part);
        }
        const pathParts = normalizedParts.join("\\");
        return pathParts ? `${prefix}${pathParts}`.toLowerCase() : prefix.toLowerCase();
    }
    const isAbsolute = path.startsWith("/");
    const parts = [];
    for (const part of path.split("/")) {
        if (!part || part === ".")
            continue;
        if (part === "..") {
            if (parts.length && parts.at(-1) !== "..")
                parts.pop();
            else if (!isAbsolute)
                parts.push(part);
            continue;
        }
        parts.push(part);
    }
    const normalized = `${isAbsolute ? "/" : ""}${parts.join("/")}`;
    return normalized || (isAbsolute ? "/" : ".");
}
function readRecentProjects() {
    try {
        const value = JSON.parse(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY) ?? "[]");
        if (!Array.isArray(value))
            return [];
        const seen = new Set();
        return value.filter((path) => {
            if (typeof path !== "string" || !path.trim())
                return false;
            const key = normalizeProjectPath(path);
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        }).slice(0, MAX_RECENT_PROJECTS);
    }
    catch {
        return [];
    }
}
let recentProjects = readRecentProjects();
function rememberRecentProjects(paths) {
    const nextProjects = [];
    const seen = new Set();
    for (const path of [...paths, ...recentProjects]) {
        if (typeof path !== "string" || !path.trim())
            continue;
        const key = normalizeProjectPath(path);
        if (seen.has(key))
            continue;
        seen.add(key);
        nextProjects.push(path);
        if (nextProjects.length === MAX_RECENT_PROJECTS)
            break;
    }
    recentProjects = nextProjects;
    try {
        localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(recentProjects));
    }
    catch {
    }
    renderProjectMenu();
}
function renderProjectDirectory() {
    projectDirectoryLabel.textContent = displayedProjectDirectory || "Loading…";
    projectTrigger.title = displayedProjectDirectory || "Project directory";
    renderProjectMenu();
}
function renderProjectMenu() {
    if (!projectMenu)
        return;
    const currentKey = displayedProjectDirectory ? normalizeProjectPath(displayedProjectDirectory) : "";
    const seen = new Set(currentKey ? [currentKey] : []);
    const otherProjects = recentProjects.filter((path) => {
        const key = normalizeProjectPath(path);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    }).slice(0, 5);
    const createItem = ({ label, directory, current = false, action }) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "project-menu-item";
        item.setAttribute("role", "menuitem");
        item.textContent = label;
        item.title = directory;
        item.dataset.directory = directory;
        item.dataset.projectKey = action === "choose" ? "choose" : normalizeProjectPath(directory);
        if (current)
            item.setAttribute("aria-current", "true");
        if (action)
            item.dataset.action = action;
        return item;
    };
    const menuItems = [
        { label: displayedProjectDirectory || "Loading…", directory: displayedProjectDirectory, current: true },
        ...otherProjects.map((path) => ({ label: path, directory: path })),
        { label: "Choose directory…", directory: "", action: "choose" },
    ];
    const signature = JSON.stringify(menuItems.map((item) => [
        item.label,
        item.directory,
        item.current === true,
        item.action ?? "",
    ]));
    if (projectMenu.dataset.signature === signature)
        return;
    const focusedItem = projectMenu.contains(document.activeElement) ? document.activeElement : null;
    const focusedKey = focusedItem?.dataset.projectKey;
    const focusedIndex = focusedItem ? projectMenuItems().indexOf(focusedItem) : -1;
    const items = menuItems.map(createItem);
    const separator = document.createElement("div");
    separator.className = "project-menu-separator";
    separator.setAttribute("role", "separator");
    updatingProjectMenu = true;
    try {
        projectMenu.replaceChildren(...items.slice(0, -1), separator, items.at(-1));
        projectMenu.dataset.signature = signature;
    }
    finally {
        updatingProjectMenu = false;
    }
    if (focusedItem && !projectMenu.hidden) {
        const focusTarget = projectMenuItems().find((item) => item.dataset.projectKey === focusedKey) ??
            projectMenuItems()[Math.min(focusedIndex, projectMenuItems().length - 1)];
        focusTarget?.focus();
    }
}
function setProjectMenuOpen(open, focusIndex) {
    projectMenu.hidden = !open;
    projectTrigger.setAttribute("aria-expanded", String(open));
    if (open && Number.isInteger(focusIndex)) {
        projectMenu.querySelectorAll("button[role=menuitem]")[focusIndex]?.focus();
    }
}
function projectMenuItems() {
    return [...projectMenu.querySelectorAll("button[role=menuitem]")];
}
function moveProjectMenuFocus(key) {
    const items = projectMenuItems();
    if (!items.length)
        return;
    const current = items.indexOf(document.activeElement);
    const index = key === "Home" ? 0
        : key === "End" ? items.length - 1
            : key === "ArrowUp" ? (current <= 0 ? items.length - 1 : current - 1)
                : (current < 0 || current === items.length - 1 ? 0 : current + 1);
    items[index].focus();
}
function closeProjectMenu(returnFocus = false) {
    if (projectMenu.hidden)
        return;
    setProjectMenuOpen(false);
    if (returnFocus)
        projectTrigger.focus();
}
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
function readBusyModes() {
    try {
        const value = JSON.parse(localStorage.getItem(BUSY_MODE_STORAGE_KEY) ?? "{}");
        return new Map(Object.entries(value).filter(([, mode]) => mode === "queue" || mode === "steer"));
    }
    catch {
        return new Map();
    }
}
const busyModesBySession = readBusyModes();
function busyMode(sessionId = activeSessionId) {
    return sessionId ? busyModesBySession.get(sessionId) ?? "steer" : "steer";
}
function setBusyMode(sessionId, mode) {
    if (!sessionId || (mode !== "queue" && mode !== "steer"))
        return;
    busyModesBySession.set(sessionId, mode);
    try {
        localStorage.setItem(BUSY_MODE_STORAGE_KEY, JSON.stringify(Object.fromEntries(busyModesBySession)));
    }
    catch {
    }
    if (sessionId === activeSessionId)
        updateSendButton();
}
function updateWarningPopover() {
    const open = warningPinned || warningPointerInside || warningKeyboardFocused;
    warningDetails.hidden = !open;
    warningIndicator.setAttribute("aria-expanded", String(open));
    if (open)
        positionWarningPopover();
}
function positionWarningPopover() {
    if (warningDetails.hidden)
        return;
    const margin = 8;
    const gap = 5;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const anchor = warningIndicator.getBoundingClientRect();
    warningDetails.style.maxWidth = `${Math.max(0, viewportWidth - margin * 2)}px`;
    warningDetails.style.maxHeight = `${Math.max(0, Math.min(280, viewportHeight - margin * 2))}px`;
    const above = Math.max(0, anchor.top - margin - gap);
    const below = Math.max(0, viewportHeight - margin - anchor.bottom - gap);
    const openAbove = above >= below;
    const availableHeight = Math.max(0, Math.min(
        openAbove ? above : below,
        280,
        viewportHeight - margin * 2,
    ));
    warningDetails.style.maxHeight = `${availableHeight}px`;
    const popover = warningDetails.getBoundingClientRect();
    const left = Math.max(
        margin,
        Math.min(anchor.right - popover.width, viewportWidth - margin - popover.width),
    );
    const preferredTop = openAbove
        ? Math.max(margin, anchor.top - gap - popover.height)
        : Math.min(viewportHeight - margin - popover.height, anchor.bottom + gap);
    const top = Math.max(margin, Math.min(preferredTop, viewportHeight - margin - popover.height));
    warningDetails.style.left = `${left}px`;
    warningDetails.style.top = `${top}px`;
}
function renderWarnings(sessionId = activeSessionId) {
    const warnings = sessionId
        ? [...(warningsBySession.get(sessionId) ?? []), ...(compressionConflictWarnings.has(sessionId) ? [compressionConflictWarnings.get(sessionId)] : [])]
        : [];
    warningMessages.replaceChildren();
    for (const message of warnings) {
        const item = document.createElement("p");
        item.textContent = message;
        warningMessages.append(item);
    }
    const signature = JSON.stringify(warnings);
    const dismissedSignature = sessionId ? dismissedWarningsBySession.get(sessionId) : undefined;
    if (dismissedSignature !== undefined && dismissedSignature !== signature) {
        dismissedWarningsBySession.delete(sessionId);
        warningPinned = false;
        warningPointerInside = false;
        warningKeyboardFocused = false;
    }
    const dismissed = dismissedSignature === signature;
    warningIndicator.hidden = warnings.length === 0 || dismissed;
    if (warnings.length === 0 || dismissed) {
        warningDetails.hidden = true;
        warningPinned = false;
        warningPointerInside = false;
        warningKeyboardFocused = false;
        clearTimeout(warningCloseTimer);
    }
    warningCount.textContent = warnings.length > 1 ? String(warnings.length) : "";
    warningIndicator.setAttribute(
        "aria-label",
        warnings.length === 1 ? "1 warning" : `Warnings (${warnings.length})`,
    );
    updateWarningPopover();
}
warningDismiss.addEventListener("click", (event) => {
    event.stopPropagation();
    const warnings = activeSessionId ? warningsBySession.get(activeSessionId) ?? [] : [];
    if (warnings.length === 0)
        return;
    dismissedWarningsBySession.set(activeSessionId, JSON.stringify(warnings));
    warningPinned = false;
    warningPointerInside = false;
    warningKeyboardFocused = false;
    clearTimeout(warningCloseTimer);
    warningDetails.hidden = true;
    warningIndicator.hidden = true;
    warningIndicator.setAttribute("aria-expanded", "false");
    warningIndicator.blur();
});
function addWarning(message, sessionId = activeSessionId) {
    const normalized = typeof message === "string" ? message.trim() : "";
    if (!sessionId || !normalized)
        return;
    // Pi notice events have no recovery/clear signal, so retain them for this page's session view.
    const warnings = warningsBySession.get(sessionId) ?? [];
    if (!warnings.includes(normalized)) {
        warnings.push(normalized);
        warningsBySession.set(sessionId, warnings);
    }
    if (sessionId === activeSessionId)
        renderWarnings(sessionId);
}
warningIndicator.addEventListener("click", () => {
    if (warningIndicator.hidden)
        return;
    warningPinned = !warningPinned;
    updateWarningPopover();
});
function enterWarningPointer() {
    clearTimeout(warningCloseTimer);
    warningPointerInside = true;
    updateWarningPopover();
}
function leaveWarningPointer() {
    clearTimeout(warningCloseTimer);
    warningCloseTimer = setTimeout(() => {
        warningPointerInside = warningIndicator.matches(":hover") || warningDetails.matches(":hover");
        updateWarningPopover();
    }, 120);
}
warningIndicator.addEventListener("pointerenter", enterWarningPointer);
warningIndicator.addEventListener("pointerleave", leaveWarningPointer);
warningDetails.addEventListener("pointerenter", enterWarningPointer);
warningDetails.addEventListener("pointerleave", leaveWarningPointer);
warningIndicator.addEventListener("focus", () => {
    warningKeyboardFocused = warningIndicator.matches(":focus-visible");
    updateWarningPopover();
});
warningIndicator.addEventListener("blur", () => {
    warningKeyboardFocused = false;
    updateWarningPopover();
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !warningDetails.hidden) {
        warningPinned = false;
        warningPointerInside = false;
        warningKeyboardFocused = false;
        if (document.activeElement === warningIndicator)
            warningIndicator.blur();
        updateWarningPopover();
    }
});
window.addEventListener("resize", () => requestAnimationFrame(positionWarningPopover));
window.addEventListener("scroll", positionWarningPopover, true);
function promptTemplateMatchAtCaret() {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
    if (!match)
        return null;
    const start = match.index + match[0].lastIndexOf("/");
    const after = input.value.slice(caret);
    if (!match[1] && after.length > 0 && !/^\s/.test(after))
        return null;
    return { start, end: caret, query: match[1] ?? "" };
}
function closePromptTemplateSuggestions() {
    promptTemplateSuggestions.hidden = true;
    promptTemplateSuggestionMatch = null;
    promptTemplateSuggestionIndex = -1;
    promptTemplateSuggestionSessionId = null;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
}
function positionPromptTemplateSuggestions() {
    if (promptTemplateSuggestions.hidden)
        return;
    const rect = input.getBoundingClientRect();
    promptTemplateSuggestions.style.width = `${Math.min(420, Math.max(220, rect.width))}px`;
    promptTemplateSuggestions.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
    promptTemplateSuggestions.style.maxHeight = `${Math.max(100, window.innerHeight - 16)}px`;
    const height = promptTemplateSuggestions.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - promptTemplateSuggestions.getBoundingClientRect().width - 8));
    const above = rect.top - height - 6;
    const below = rect.bottom + 6;
    const top = above >= 8 ? above : Math.min(below, window.innerHeight - height - 8);
    promptTemplateSuggestions.style.left = `${left}px`;
    promptTemplateSuggestions.style.top = `${Math.max(8, top)}px`;
}
function renderPromptTemplateSuggestions(message = "") {
    if (promptTemplateSuggestions.hidden || !promptTemplateSuggestionMatch)
        return;
    const sessionId = promptTemplateSuggestionSessionId;
    const catalog = sessionId ? promptTemplateCommandsBySession.get(sessionId) : null;
    const query = promptTemplateSuggestionMatch.query.toLocaleLowerCase();
    const commands = (catalog?.commands ?? []).filter((command) => command.name.toLocaleLowerCase().startsWith(query));
    promptTemplateSuggestions.replaceChildren();
    const status = document.createElement("p");
    status.className = "prompt-template-suggestion-status";
    status.setAttribute("role", "status");
    status.textContent = message || (!sessionId
        ? "Start a Pi session to discover its prompt templates."
        : catalog?.message || (commands.length ? "Tab selects a template command" : "No matching prompt templates."));
    promptTemplateSuggestions.append(status);
    const list = document.createElement("div");
    list.id = "prompt-template-suggestion-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Pi prompt templates");
    list.className = "prompt-template-suggestion-list";
    for (const [index, command] of commands.entries()) {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `prompt-template-option-${index}`;
        option.className = "prompt-template-suggestion";
        option.tabIndex = -1;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === promptTemplateSuggestionIndex));
        const name = document.createElement("strong");
        name.textContent = `/${command.name}`;
        option.append(name);
        if (command.description) {
            const description = document.createElement("span");
            description.textContent = command.description;
            option.append(description);
        }
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => insertPromptTemplate(command.name));
        list.append(option);
    }
    promptTemplateSuggestions.append(list);
    if (promptTemplateSuggestionIndex >= commands.length)
        promptTemplateSuggestionIndex = commands.length - 1;
    if (promptTemplateSuggestionIndex >= 0) {
        const option = promptTemplateSuggestions.querySelector(`#prompt-template-option-${promptTemplateSuggestionIndex}`);
        if (option) input.setAttribute("aria-activedescendant", option.id);
    }
    else {
        input.removeAttribute("aria-activedescendant");
    }
    positionPromptTemplateSuggestions();
}
async function refreshPromptTemplates(sessionId) {
    if (!sessionId)
        return;
    const request = ++promptTemplateRequest;
    renderPromptTemplateSuggestions("Loading Pi prompt templates…");
    try {
        const result = await post("/api/prompt-templates", { sessionId });
        if (request !== promptTemplateRequest || promptTemplateSuggestionSessionId !== sessionId || promptTemplateSuggestions.hidden)
            return;
        promptTemplateCommandsBySession.set(sessionId, {
            commands: Array.isArray(result.commands)
                ? result.commands.filter((item) => typeof item?.name === "string" && item.name)
                : [],
            message: typeof result.message === "string" ? result.message : "",
        });
        renderPromptTemplateSuggestions();
    }
    catch (error) {
        if (request !== promptTemplateRequest || promptTemplateSuggestionSessionId !== sessionId || promptTemplateSuggestions.hidden)
            return;
        renderPromptTemplateSuggestions(error instanceof Error ? error.message : "Pi could not list prompt templates.");
    }
}
function updatePromptTemplateSuggestions() {
    const match = promptTemplateMatchAtCaret();
    if (!match) {
        closePromptTemplateSuggestions();
        return;
    }
    promptTemplateSuggestionMatch = match;
    if (promptTemplateSuggestions.hidden) {
        promptTemplateSuggestions.hidden = false;
        promptTemplateSuggestionSessionId = activeSessionId;
        input.setAttribute("aria-expanded", "true");
        promptTemplateSuggestionIndex = -1;
        renderPromptTemplateSuggestions(activeSessionId ? "Loading Pi prompt templates…" : "");
        if (activeSessionId)
            void refreshPromptTemplates(activeSessionId);
    }
    else {
        renderPromptTemplateSuggestions();
    }
}
function insertPromptTemplate(name) {
    const match = promptTemplateMatchAtCaret();
    if (!match)
        return;
    const after = input.value.slice(match.end);
    const insertion = `/${name}${after && /^\s/.test(after) ? "" : " "}`;
    input.setRangeText(insertion, match.start, match.end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
}
function movePromptTemplateSuggestion(delta) {
    const count = promptTemplateSuggestions.querySelectorAll('[role="option"]').length;
    if (!count)
        return;
    promptTemplateSuggestionIndex = promptTemplateSuggestionIndex < 0
        ? (delta > 0 ? 0 : count - 1)
        : (promptTemplateSuggestionIndex + delta + count) % count;
    renderPromptTemplateSuggestions();
}
window.addEventListener("resize", positionPromptTemplateSuggestions);
window.addEventListener("scroll", positionPromptTemplateSuggestions, true);
function positionModelPicker() {
    if (!modelPickerOpen || (!activeSessionId && !displayedProjectDirectory))
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
    modelPickerTarget = null;
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
async function loadModelOptions() {
    const target = activeSessionId ? { sessionId: activeSessionId } : { projectDirectory };
    if ((!target.sessionId && !target.projectDirectory) || !modelPickerOpen)
        return;
    modelPickerTarget = target;
    const request = ++modelPickerRequest;
    modelPickerStatus.textContent = "Loading models…";
    modelPickerMessage.textContent = "";
    delete modelPickerMessage.dataset.state;
    modelOptions.replaceChildren();
    positionModelPicker();
    try {
        const result = await post("/api/models", target);
        if (request !== modelPickerRequest || !modelPickerOpen || modelPickerTarget !== target ||
            (target.sessionId ? result.sessionId !== target.sessionId || activeSessionId !== target.sessionId : result.projectDirectory !== target.projectDirectory || projectDirectory !== target.projectDirectory))
            return;
        modelPickerStatus.textContent = "";
        renderModelOptions(result);
        positionModelPicker();
    }
    catch (error) {
        if (request !== modelPickerRequest || !modelPickerOpen || modelPickerTarget !== target)
            return;
        modelPickerStatus.textContent = "Could not load models.";
        modelPickerMessage.dataset.state = "error";
        modelPickerMessage.textContent = error instanceof Error ? error.message : "Refresh to try again.";
        positionModelPicker();
    }
}
async function selectModel(model) {
    const target = modelPickerTarget;
    if (!target || (target.sessionId && target.sessionId !== activeSessionId))
        return;
    const request = modelPickerRequest;
    modelPickerStatus.textContent = "Changing model…";
    modelPickerMessage.textContent = "";
    for (const option of modelOptions.querySelectorAll(".model-option"))
        option.disabled = true;
    try {
        const result = await post("/api/model", {
            ...target,
            provider: model.provider,
            modelId: model.id,
        });
        if (request === modelPickerRequest && modelPickerOpen && modelPickerTarget === target) {
            if (target.sessionId) {
                const view = runtimeView(target.sessionId);
                view.model = result.model;
                view.context = result.context;
                updateContext(result.context);
            }
            updateModel(result.model);
            closeModelPicker();
        }
    }
    catch (error) {
        if (request !== modelPickerRequest || !modelPickerOpen || modelPickerTarget !== target)
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
        view = {
            state: "idle",
            isCompacting: false,
            queuedMessages: [],
            activeToolNames: new Map(),
        };
        runtimeStates.set(sessionId, view);
    }
    if (!(view.activeToolNames instanceof Map))
        view.activeToolNames = new Map();
    return view;
}
function composerKey(sessionId = activeSessionId, directory = displayedProjectDirectory || projectDirectory) {
    return sessionId ?? `pending:${normalizeProjectPath(directory)}`;
}
function rememberPrompt(key, prompt) {
    const history = promptHistoryByComposer.get(key) ?? [];
    history.push(prompt);
    if (history.length > MAX_PROMPT_HISTORY)
        history.splice(0, history.length - MAX_PROMPT_HISTORY);
    promptHistoryByComposer.set(key, history);
    promptHistoryCursorByComposer.set(key, history.length);
}
function navigatePromptHistory(direction) {
    const key = composerKey();
    const history = promptHistoryByComposer.get(key) ?? [];
    if (history.length === 0)
        return false;
    let cursor = promptHistoryCursorByComposer.get(key) ?? history.length;
    if (cursor === history.length)
        draftsBySession.set(`${key}:history-draft`, input.value);
    cursor = Math.max(0, Math.min(history.length, cursor + direction));
    if (cursor === history.length) {
        input.value = draftsBySession.get(`${key}:history-draft`) ?? "";
    }
    else {
        input.value = history[cursor] ?? "";
    }
    promptHistoryCursorByComposer.set(key, cursor);
    draftsBySession.set(key, input.value);
    input.setSelectionRange(input.value.length, input.value.length);
    updateSendButton();
    return true;
}
function pendingAttachments(key = composerKey()) {
    return attachmentsBySession.get(key) ?? [];
}
function pendingQueueIds(sessionId = activeSessionId) {
    return sessionId ? queuedMessageIds.get(sessionId) ?? new Set() : new Set();
}
function clearRunningActivityTimer() {
    clearInterval(runningActivityTimer);
    runningActivityTimer = undefined;
}
function clearCompactionActivityTimer() {
    clearInterval(compactionActivityTimer);
    compactionActivityTimer = undefined;
}
function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function renderRunningActivity() {
    const view = activeSessionId ? runtimeView(activeSessionId) : undefined;
    if (runState !== "running" || isCompacting || status.dataset.state === "error" || transientStatusTimer || !view)
        return;
    const elapsed = formatElapsed(Date.now() - (view.runningStartedAt ?? Date.now()));
    const activeTools = [...view.activeToolNames.values()];
    if (activeTools.length) {
        const names = [...new Set(activeTools)];
        const label = names.length === 1 ? `Running ${names[0]}` : `Running ${names.length} tools`;
        status.textContent = `${label} · ${elapsed} elapsed`;
    }
    else if (Date.now() - (view.lastPiActivityAt ?? Date.now()) >= RUNNING_ACTIVITY_STALE_DELAY_MS) {
        status.textContent = `Pi is still working · ${elapsed} elapsed`;
    }
    else {
        status.textContent = `Pi is responding · ${elapsed} elapsed`;
    }
    status.dataset.state = "running";
    status.hidden = false;
}
function renderCompactionActivity() {
    const view = activeSessionId ? runtimeView(activeSessionId) : undefined;
    if (!isCompacting || status.dataset.state === "error" || !view)
        return;
    const elapsed = formatElapsed(Date.now() - (view.compactionStartedAt ?? Date.now()));
    status.textContent = `Compacting · ${elapsed} elapsed`;
    status.dataset.state = "running";
    status.hidden = false;
}
function notePiActivity(sessionId = activeSessionId) {
    if (!sessionId)
        return;
    const view = runtimeView(sessionId);
    const now = Date.now();
    view.runningStartedAt ??= now;
    view.lastPiActivityAt = now;
    if (sessionId !== activeSessionId || view.state !== "running" || view.isCompacting)
        return;
    if (runningActivityTimer === undefined)
        runningActivityTimer = setInterval(renderRunningActivity, RUNNING_ACTIVITY_REFRESH_MS);
    renderRunningActivity();
}
function setTransientStatus(message, duration = 6000) {
    clearTimeout(transientStatusTimer);
    setStatus(message);
    transientStatusTimer = setTimeout(() => {
        transientStatusTimer = undefined;
        if (status.textContent === message && status.dataset.state !== "error") {
            if (runState === "running") renderRunningActivity();
            else setStatus("");
        }
    }, duration);
}
function updateSendButton() {
    const attachments = pendingAttachments();
    const currentComposerKey = composerKey();
    const selectedSessionCwd = sessions.find((session) => session.id === activeSessionId)?.cwd;
    const hasInFlight = [...sendAttempts.values()].some((attempt) => attempt.responsePending && (
        (attempt.draftKey === currentComposerKey && attempt.mode !== "queue") ||
        (!attempt.sessionId && attempt.projectDirectory && attempt.projectDirectory === selectedSessionCwd)));
    const busy = runState === "running";
    const action = isCompacting ? "compacting" : busy ? busyMode() : runState === "idle" ? "send" : runState === "stopping" ? "stopping" : "unavailable";
    sendButton.textContent = action === "compacting" ? "Compacting…" : action === "stopping" ? "Stopping…" : action === "unavailable" ? "Unavailable" : action === "send" ? "Send" : action === "queue" ? "Queue" : "Steer";
    sendButton.dataset.mode = action;
    if (isCompacting)
        sendButton.setAttribute("aria-label", "Submission unavailable");
    else
        sendButton.removeAttribute("aria-label");
    busyModePicker.hidden = !busy || isCompacting;
    sendButton.disabled = hasInFlight ||
        (!input.value.trim() && attachments.length === 0) ||
        (attachments.length > 0 && modelSupportsImageInput === false) || isCompacting ||
        (runState !== "idle" && runState !== "running");
}
busyModeOptions.querySelectorAll("button[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
        setBusyMode(activeSessionId, button.dataset.mode);
        busyModePicker.open = false;
        input.focus();
    });
});
function renderPendingAttachments() {
    attachmentStrip.replaceChildren();
    const sessionId = composerKey();
    const attachments = pendingAttachments();
    attachmentWarning.hidden = attachments.length === 0 || modelSupportsImageInput !== false;
    if (!attachmentWarning.hidden)
        attachmentWarning.textContent = "The selected model does not support image input.";
    for (const attachment of attachments) {
        const item = document.createElement("div");
        item.className = "image-attachment";
        const thumbnailArea = document.createElement("div");
        thumbnailArea.className = "image-thumbnail";
        const thumbnailState = attachment.thumbnailState ?? "loading";
        thumbnailArea.dataset.thumbnailState = thumbnailState;
        const thumbnail = document.createElement("img");
        thumbnail.className = "image-thumbnail-image";
        thumbnail.alt = "";
        const spinner = document.createElement("span");
        spinner.className = "image-thumbnail-spinner";
        spinner.setAttribute("aria-hidden", "true");
        spinner.hidden = thumbnailState !== "loading";
        thumbnail.addEventListener("load", () => {
            updateAttachmentThumbnailState(sessionId, attachment, item, thumbnailArea, spinner, "loaded");
        });
        thumbnail.addEventListener("error", () => {
            updateAttachmentThumbnailState(sessionId, attachment, item, thumbnailArea, spinner, "failed");
        });
        thumbnailArea.append(thumbnail, spinner);
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
        item.append(thumbnailArea, name, remove);
        attachmentStrip.append(item);
        thumbnail.src = attachment.previewUrl;
    }
    updateSendButton();
}
function updateAttachmentThumbnailState(sessionId, attachment, item, thumbnailArea, spinner, state) {
    if (!(attachmentsBySession.get(sessionId) ?? []).includes(attachment))
        return;
    attachment.thumbnailState = state;
    if (!item.isConnected || !attachmentStrip.contains(item))
        return;
    thumbnailArea.dataset.thumbnailState = state;
    spinner.hidden = state !== "loading";
}
function removeAttachment(sessionId, attachmentId) {
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
    if (composerKey() === sessionId)
        renderPendingAttachments();
}
function addImageFiles(files, sessionId = activeSessionId) {
    sessionId ??= composerKey();
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
            thumbnailState: "loading",
        });
    }
    if (attachments.length)
        attachmentsBySession.set(sessionId, attachments);
    if (composerKey() === sessionId)
        renderPendingAttachments();
    if (rejected)
        setStatus(rejected, "error");
}
function switchComposerSession(sessionId, directory = displayedProjectDirectory || projectDirectory) {
    const previousKey = composerKey(activeSessionId);
    const nextKey = composerKey(sessionId, directory);
    const pendingSwitch = pendingComposerSwitch?.targetSessionId === sessionId
        ? pendingComposerSwitch
        : null;
    const typedDuringSwitch = pendingSwitch !== null && input.value !== pendingSwitch.inputValue;
    if (previousKey) {
        if (typedDuringSwitch && pendingSwitch.previousSessionId === activeSessionId) {
            if (pendingSwitch.previousDraft === undefined)
                draftsBySession.delete(previousKey);
            else
                draftsBySession.set(previousKey, pendingSwitch.previousDraft);
        }
        else {
            draftsBySession.set(previousKey, input.value);
        }
    }
    if (typedDuringSwitch) {
        draftsBySession.set(nextKey, input.value);
    }
    else {
        input.value = draftsBySession.get(nextKey) ?? "";
    }
    if (pendingSwitch)
        pendingComposerSwitch = null;
    renderMessagePreview();
}
function clearSentComposer(attempt) {
    const remaining = pendingAttachments(attempt.draftKey).filter((attachment) => {
        if (!attempt.attachments.includes(attachment))
            return true;
        URL.revokeObjectURL(attachment.previewUrl);
        return false;
    });
    if (remaining.length)
        attachmentsBySession.set(attempt.draftKey, remaining);
    else
        attachmentsBySession.delete(attempt.draftKey);
    const submittedComposerText = attempt.composerText ?? attempt.message;
    const draft = draftsBySession.get(attempt.draftKey) ?? "";
    if (draft.trim() === submittedComposerText.trim())
        draftsBySession.set(attempt.draftKey, "");
    if (composerKey() === attempt.draftKey && input.value.trim() === submittedComposerText.trim()) {
        input.value = "";
        draftsBySession.set(attempt.draftKey, "");
    }
    if (composerKey() === attempt.draftKey)
        renderPendingAttachments();
    renderMessagePreview();
}
function sendAttemptOwnsVisibleView(attempt) {
    if (attempt.originSessionId)
        return activeSessionId === attempt.originSessionId;
    if (attempt.sessionId)
        return activeSessionId === attempt.sessionId;
    return activeSessionId === null && composerKey() === attempt.draftKey;
}
function disposeComposerSession(sessionId) {
    for (const attachment of pendingAttachments(sessionId))
        URL.revokeObjectURL(attachment.previewUrl);
    attachmentsBySession.delete(sessionId);
    draftsBySession.delete(sessionId);
    queuedMessageIds.delete(sessionId);
    pendingSessionIds.delete(sessionId);
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
    const scrollableHeight = conversation.scrollHeight - conversation.clientHeight;
    if (scrollableHeight > 1 && conversation.scrollTop <= 1)
        return false;
    return scrollableHeight - conversation.scrollTop <= 80;
}
function followLatestIfNeeded(wasFollowing) {
    if (wasFollowing)
        conversation.scrollTop = conversation.scrollHeight;
}
function updateSessionControls() {
    sessionButtons[0].disabled = false;
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
    const contextKnown = latestContext.tokens !== null;
    const belowCompactionThreshold = contextKnown &&
        latestContext.tokens <= manualCompactionKeepRecentTokens;
    compact.disabled = !hasRuntime || isCompacting || !contextKnown || belowCompactionThreshold;
    compact.title = !contextKnown
        ? "Context usage is unavailable; manual compaction is disabled to avoid interrupting a turn for a no-op."
        : belowCompactionThreshold
            ? `Pi keeps the most recent ${formatNumber(manualCompactionKeepRecentTokens)} tokens. Manual compaction is available after context grows beyond that threshold.`
            : "Compact the session now.";
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
    const availableAfterFixed = Math.max(0, paneHeight - fixedHeight);
    const minimumConversationHeight = Math.min(
        MIN_CONVERSATION_HEIGHT,
        Math.max(0, availableAfterFixed - MIN_COMPOSER_HEIGHT),
    );
    const roomAfterConversation = Math.max(0, availableAfterFixed - minimumConversationHeight);
    const maximum = Math.max(0, Math.floor(Math.min(paneHeight * 0.4, roomAfterConversation)));
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
conversation.addEventListener("scroll", () => {
    if (historyScrollAnchor?.element.isConnected && !preservingHistoryScroll) {
        historyScrollAnchor.top = historyScrollAnchor.element.getBoundingClientRect().top;
    }
    if (conversation.scrollTop <= 140)
        void loadOlderHistory();
}, { passive: true });
conversation.addEventListener("keydown", (event) => {
    if (event.key === "PageUp" && historyHasOlder) {
        event.preventDefault();
        void loadOlderHistory();
    }
});
conversation.addEventListener("load", (event) => {
    if (event.target instanceof HTMLImageElement)
        preserveHistoryAnchor();
}, true);
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
            navigationRevision++;
            pendingComposerSwitch = {
                targetSessionId: session.id,
                previousSessionId: activeSessionId,
                inputValue: input.value,
                previousDraft: draftsBySession.get(composerKey()),
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
    const compacting = runtimeExists && selectedRuntime?.isCompacting === true;
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
    document.title = compacting ? "pi - Compacting" : indicatorState === "error" ? "Pi - Error" : indicatorState === "running" ? "pi - Running" : "pi - Ready";
}
function clearTranscript() {
    for (const message of userMessages.values())
        for (const previewUrl of message.previewUrls)
            URL.revokeObjectURL(previewUrl);
    conversation.replaceChildren();
    queuedMessageList.replaceChildren();
    queuedMessageArea.hidden = true;
    assistants.clear();
    tools.clear();
    userMessages.clear();
    activeAssistant = undefined;
    renderedTranscriptIds.clear();
    renderedTranscriptItems.clear();
    renderedTranscriptMessageCount = 0;
}
function cancelSelectedHistoryLoad(load = selectedHistoryLoad) {
    if (!load || selectedHistoryLoad !== load)
        return;
    window.clearTimeout(load.delayTimer);
    window.clearInterval(load.countTimer);
    sessionHistoryLoading.hidden = true;
    selectedHistoryLoad = null;
}
function selectedHistoryMessageCount(load) {
    if (!load.sessionId || load.sessionId !== activeSessionId ||
        renderedTranscriptSessionId !== load.sessionId)
        return 0;
    return renderedTranscriptMessageCount;
}
function refreshSelectedHistoryLoadingCount(load) {
    if (selectedHistoryLoad !== load || !load.visible)
        return;
    sessionHistoryLoadingCount.textContent = `Loaded ${selectedHistoryMessageCount(load)} messages…`;
}
function beginSelectedHistoryLoad(sessionId) {
    cancelSelectedHistoryLoad();
    const load = {
        id: ++selectedHistoryLoadId,
        sessionId,
        visible: false,
        delayTimer: 0,
        countTimer: 0,
    };
    selectedHistoryLoad = load;
    sessionHistoryLoading.hidden = true;
    sessionHistoryLoadingAnnouncement.textContent = "";
    load.delayTimer = window.setTimeout(() => {
        if (selectedHistoryLoad !== load)
            return;
        load.visible = true;
        sessionHistoryLoading.hidden = false;
        sessionHistoryLoadingAnnouncement.textContent = "Loading session history.";
        refreshSelectedHistoryLoadingCount(load);
        load.countTimer = window.setInterval(() => refreshSelectedHistoryLoadingCount(load), HISTORY_LOADING_COUNT_REFRESH_MS);
    }, HISTORY_LOADING_INDICATOR_DELAY_MS);
    return load.id;
}
function completeSelectedHistoryLoad(sessionId, loadId) {
    const load = selectedHistoryLoad;
    if (!load || load.sessionId !== sessionId || (loadId !== undefined && load.id !== loadId))
        return;
    cancelSelectedHistoryLoad(load);
}
function renderTranscript(value, hasOlder = false, beforeId = null, revision = null) {
    let entries = Array.isArray(value) ? value : [];
    const sessionChanged = renderedTranscriptSessionId !== activeSessionId;
    const nextRevision = typeof revision === "string" && revision ? revision : activeSessionId ?? "empty";
    const revisionChanged = renderedHistoryRevision !== nextRevision;
    if (sessionChanged || revisionChanged) {
        transcriptRenderGeneration++;
        historyRequestVersion++;
        historyLoadInProgress = false;
        historyLoading.hidden = true;
        historyLoading.textContent = "Loading earlier messages…";
        olderHistoryLoaded = false;
        historyScrollAnchor = null;
        historyHasOlder = hasOlder;
        historyBeforeId = beforeId;
        renderedTranscriptSessionId = activeSessionId;
        renderedHistoryRevision = nextRevision;
        transcriptHydrationSessionId = activeSessionId;
        transcriptHydrationEvents = [];
        clearTranscript();
    }
    else if (!olderHistoryLoaded && beforeId) {
        historyHasOlder = hasOlder;
        historyBeforeId = beforeId;
    }
    else if (!olderHistoryLoaded) {
        historyHasOlder = hasOlder;
        historyBeforeId = null;
    }
    if (!sessionChanged && !revisionChanged) {
        for (const entry of entries) {
            renderTranscriptEntry(entry);
        }
        syncSendingIndicators();
    }
    if (!sessionChanged && !revisionChanged) {
        completeSelectedHistoryLoad(activeSessionId);
        return;
    }
    const generation = ++transcriptRenderGeneration;
    const load = selectedHistoryLoad?.sessionId === activeSessionId ? selectedHistoryLoad : null;
    const wasFollowing = isNearConversationBottom();
    let index = 0;
    const renderBatch = () => {
        if (generation !== transcriptRenderGeneration)
            return;
        const startedAt = performance.now();
        try {
            do {
                renderTranscriptEntry(entries[index++]);
            } while (index < entries.length && performance.now() - startedAt < 8);
        }
        catch (error) {
            if (load)
                completeSelectedHistoryLoad(load.sessionId, load.id);
            throw error;
        }
        if (index < entries.length) {
            requestAnimationFrame(renderBatch);
            return;
        }
        const pendingEvents = transcriptHydrationEvents;
        if (sessionChanged || transcriptHydrationSessionId === activeSessionId) {
            transcriptHydrationEvents = [];
            transcriptHydrationSessionId = null;
        }
        for (const event of pendingEvents)
            handleEvent(event);
        syncSendingIndicators();
        if (sessionChanged || revisionChanged) {
            conversation.scrollTop = conversation.scrollHeight;
        }
        else {
            followLatestIfNeeded(wasFollowing);
        }
        if (load)
            completeSelectedHistoryLoad(load.sessionId, load.id);
    };
    requestAnimationFrame(renderBatch);
}
function renderTranscriptEntry(entry) {
    if (typeof entry !== "object" || entry === null)
        return;
    const item = entry;
    if (typeof item.id !== "string")
        return;
    if (renderedTranscriptIds.has(item.id)) {
        const previous = renderedTranscriptItems.get(item.id);
        if (previous !== JSON.stringify(item)) {
            reconcileTranscriptEntry(item);
            renderedTranscriptItems.set(item.id, JSON.stringify(item));
        }
        return;
    }
    renderedTranscriptIds.add(item.id);
    renderedTranscriptItems.set(item.id, JSON.stringify(item));
    if ((item.type === "user" || item.type === "assistant" || item.type === "custom") &&
        typeof item.text === "string")
        renderedTranscriptMessageCount++;
    if (item.type === "user" && typeof item.text === "string") {
        addUserMessage(item.text, item.id, "sent", item.imageCount, [], item.createdAt);
    }
    else if (item.type === "assistant" && typeof item.text === "string") {
        assistantStart(item.id, item.createdAt);
        const assistant = assistants.get(item.id);
        if (assistant) {
            assistant.source = item.text;
            renderAssistantMarkdown(assistant);
            completeAssistantMessage(assistant);
        }
        if (typeof item.thinking === "string" && item.thinking)
            updateThinking(item.id, item.thinking, true);
    }
    else if (item.type === "compaction" && typeof item.createdAt === "string") {
        renderCompactionEntry(item.id, item.createdAt, item.anchorId, item.afterId,
            item.reason, item.tokensBefore, item.estimatedTokensAfter);
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
function reconcileTranscriptEntry(item) {
    if (item.type === "user" && typeof item.text === "string") {
        const user = userMessages.get(item.id);
        if (user) {
            user.body.dataset.markdownSource = item.text;
            user.body.replaceChildren(parseMarkdownFragment(item.text));
            placeMessageCopyButton(user.body, user.copyButton);
            if (typeof item.createdAt === "string")
                setMessageTimestamp(user.article.querySelector(".message-heading"), item.createdAt);
            const nextCount = Number.isSafeInteger(item.imageCount) ? item.imageCount : 0;
            if (nextCount > user.imageCount && !user.previewUrls.length) {
                for (let index = user.imageCount; index < nextCount; index++) {
                    const placeholder = document.createElement("span");
                    placeholder.className = "image-message-placeholder";
                    placeholder.textContent = "[Image attachment]";
                    user.attachmentEntries.append(placeholder);
                }
                if (!user.attachmentEntries.isConnected)
                    user.delivery.before(user.attachmentEntries);
                user.imageCount = nextCount;
            }
        }
    }
    else if (item.type === "assistant" && typeof item.text === "string") {
        const assistant = assistants.get(item.id);
        if (assistant) {
            if (assistant.source !== item.text) {
                assistant.source = item.text;
                renderAssistantMarkdown(assistant);
            }
            completeAssistantMessage(assistant);
            if (typeof item.createdAt === "string")
                setMessageTimestamp(assistant.article.querySelector(".message-heading"), item.createdAt);
            if (typeof item.thinking === "string" || assistant.thinkingSource)
                updateThinking(item.id, typeof item.thinking === "string" ? item.thinking : "", true);
        }
    }
    else if (item.type === "tool") {
        const tool = tools.get(item.toolCallId);
        if (!tool) return;
        tool.summary.textContent = `${item.toolName} ${String(item.input ?? "").split("\n")[0]}`.trim();
        tool.contentSource = `Input:\n${String(item.input ?? "{}")}`;
        if ((typeof item.output === "string" && item.output.length > 0) || item.isError === true) {
            toolEnd({
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                output: item.output,
                isError: item.isError,
            });
        }
        else {
            tool.details.dataset.state = "history";
            tool.state.textContent = "result unavailable";
            if (tool.details.open || tool.contentSource.length <= MAX_COLLAPSED_DETAIL_CHARS) {
                tool.content.textContent = tool.contentSource;
                tool.contentRendered = true;
            }
        }
    }
    else if (item.type === "compaction") {
        const article = conversation.querySelector(`[data-compaction-id="${CSS.escape(item.id)}"]`);
        if (article && typeof item.createdAt === "string")
            setMessageTimestamp(article.querySelector(".message-heading"), item.createdAt);
    }
}
function visibleHistoryAnchor() {
    const top = conversation.getBoundingClientRect().top;
    for (const child of conversation.children) {
        const bounds = child.getBoundingClientRect();
        if (bounds.bottom > top)
            return { element: child, top: bounds.top };
    }
    return null;
}
function preserveHistoryAnchor() {
    const anchor = historyScrollAnchor;
    if (!anchor?.element.isConnected)
        return;
    const delta = anchor.element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 0.5)
        return;
    preservingHistoryScroll = true;
    conversation.scrollTop += delta;
    requestAnimationFrame(() => {
        preservingHistoryScroll = false;
    });
}
function prependTranscriptEntries(entries) {
    const anchor = visibleHistoryAnchor();
    const activeAssistantBeforePrepend = activeAssistant;
    const existingChildren = new Set(conversation.children);
    for (const entry of entries)
        renderTranscriptEntry(entry);
    const added = [...conversation.children].filter((child) => !existingChildren.has(child));
    if (!added.length)
        return;
    const fragment = document.createDocumentFragment();
    for (const child of added)
        fragment.append(child);
    conversation.prepend(fragment);
    activeAssistant = activeAssistantBeforePrepend;
    if (anchor?.element.isConnected) {
        historyScrollAnchor = anchor;
        preserveHistoryAnchor();
    }
}
async function loadOlderHistory() {
    if (!historyHasOlder || !historyBeforeId || !activeSessionId || historyLoadInProgress)
        return;
    const sessionId = activeSessionId;
    const cursor = historyBeforeId;
    const requestVersion = ++historyRequestVersion;
    historyLoadInProgress = true;
    historyLoading.hidden = false;
    let loadFailed = false;
    try {
        const query = new URLSearchParams({ sessionId, beforeId: cursor });
        query.set("revision", renderedHistoryRevision ?? "");
        const response = await fetch(`/api/history?${query}`);
        const result = await response.json();
        if (!response.ok) {
            if (typeof result.historyRevision === "string" &&
                result.historyRevision !== renderedHistoryRevision)
                return;
            throw new Error(typeof result.error === "string" ? result.error : "History could not be loaded.");
        }
        if (requestVersion !== historyRequestVersion || activeSessionId !== sessionId ||
            result.sessionId !== sessionId || historyBeforeId !== cursor ||
            result.historyRevision !== renderedHistoryRevision)
            return;
        const items = Array.isArray(result.items) ? result.items : [];
        prependTranscriptEntries(items);
        olderHistoryLoaded = true;
        historyHasOlder = result.hasOlder === true && items.length > 0;
        historyBeforeId = historyHasOlder && typeof result.beforeId === "string" ? result.beforeId : null;
    }
    catch (error) {
        if (requestVersion === historyRequestVersion && activeSessionId === sessionId) {
            loadFailed = true;
            historyLoading.textContent = "Could not load earlier messages";
            window.setTimeout(() => {
                if (!historyLoadInProgress)
                    historyLoading.textContent = "Loading earlier messages…";
            }, 1800);
            console.error(error);
        }
    }
    finally {
        if (requestVersion === historyRequestVersion) {
            historyLoadInProgress = false;
            historyLoading.hidden = !loadFailed;
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
    if (Number.isSafeInteger(value.manualCompactionKeepRecentTokens) && value.manualCompactionKeepRecentTokens >= 0)
        manualCompactionKeepRecentTokens = value.manualCompactionKeepRecentTokens;
    const nextSessionId = Object.hasOwn(value, "selectedSessionId")
        ? typeof value.selectedSessionId === "string" ? value.selectedSessionId : null
        : typeof value.activeSessionId === "string" ? value.activeSessionId : null;
    const nextSessions = Array.isArray(value.sessions) ? value.sessions : [];
    const nextProjectDirectory = typeof value.projectDirectory === "string"
        ? value.projectDirectory
        : projectDirectory;
    const selectedDirectory = nextSessions.find((session) => session.id === nextSessionId)?.cwd;
    const nextDisplayedDirectory = typeof selectedDirectory === "string" && selectedDirectory
        ? selectedDirectory
        : nextProjectDirectory;
    const selectionChanged = nextSessionId !== activeSessionId;
    const nextHistoryRevision = typeof value.historyRevision === "string" && value.historyRevision
        ? value.historyRevision
        : nextSessionId ?? "empty";
    const historyChanged = selectionChanged || nextHistoryRevision !== renderedHistoryRevision;
    if (historyChanged && nextSessionId) {
        if (selectedHistoryLoad?.sessionId === null) {
            selectedHistoryLoad.sessionId = nextSessionId;
        }
        else if (selectedHistoryLoad?.sessionId !== nextSessionId) {
            beginSelectedHistoryLoad(nextSessionId);
        }
    }
    else if (!nextSessionId) {
        cancelSelectedHistoryLoad();
    }
    const viewChanged = composerKey(nextSessionId, nextDisplayedDirectory) !== composerKey();
    const previousDisplayedDirectory = displayedProjectDirectory;
    if (selectionChanged || viewChanged) {
        closeModelPicker();
        closePromptTemplateSuggestions();
        warningPinned = false;
        warningPointerInside = false;
        warningKeyboardFocused = false;
        clearTimeout(warningCloseTimer);
        switchComposerSession(nextSessionId, nextDisplayedDirectory);
    }
    activeSessionId = nextSessionId;
    sessions = nextSessions;
    const projectDirectoryChanged = typeof value.projectDirectory === "string" &&
        projectDirectory !== value.projectDirectory;
    if (projectDirectoryChanged)
        projectDirectory = value.projectDirectory;
    displayedProjectDirectory = nextDisplayedDirectory;
    if (selectionChanged || projectDirectoryChanged || !hasReceivedInitialSnapshot) {
        if (nextDisplayedDirectory) {
            rememberRecentProjects([nextDisplayedDirectory, previousDisplayedDirectory]);
        }
    }
    renderProjectDirectory();
    updateCompressionConflictWarning(value, activeSessionId);
    renderWarnings();
    if (typeof value.state === "string")
        setRunState(value.state);
    updateCompactionState(value.isCompacting === true);
    updateContext(value.context);
    renderBigPi(value.bigPi, value.billionContextPi);
    updateModel(value.model);
    renderPendingAttachments();
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
            if (!sessionId.startsWith("pending:") && !sessions.some((session) => session.id === sessionId))
                disposeComposerSession(sessionId);
        }
    }
    renderSessions();
    renderTranscript(
        value.transcript,
        value.transcriptHasOlder === true,
        typeof value.transcriptBeforeId === "string" ? value.transcriptBeforeId : null,
        typeof value.historyRevision === "string" ? value.historyRevision : null,
    );
    if (activeSessionId) {
        const pendingIds = queueSet(activeSessionId);
        pendingIds.clear();
        for (const queued of queuedMessages) pendingIds.add(queued.id);
    }
    for (const queued of queuedMessages)
        addUserMessage(queued.message, queued.id, "queued", queued.imageCount, [], undefined, queued.reason);
    const statusValue = statusValueFrom(value.status);
    if (statusValue) {
        if (statusValue.kind === "notice")
            addWarning(statusValue.message);
        if (statusValue.kind === "compaction") {
            contextStatus.textContent = statusValue.message;
            contextStatus.dataset.state = statusValue.message.includes("failed") ? "error" : "info";
        }
        if (statusValue.kind !== "notice")
            setStatus(statusValue.message, statusValue.kind === "error" ? "error" : runState);
    }
    else if (isCompacting) {
        renderCompactionActivity();
    }
    else if (runState !== "failed") {
        setStatus("");
    }
    renderCompactionNotice(activeSessionId);
    hasReceivedInitialSnapshot = true;
    updateSessionControls();
    updateStatusIndicator();
    updateSendButton();
}
function setStatus(message, state = runState) {
    if (transientStatusTimer !== undefined) {
        clearTimeout(transientStatusTimer);
        transientStatusTimer = undefined;
    }
    status.textContent = message;
    status.dataset.state = state;
    status.hidden = message.length === 0;
}
function setRunState(state, error) {
    runState = state;
    if (activeSessionId) {
        const view = runtimeView(activeSessionId);
        view.state = state;
        if (state === "idle" || state === "failed") {
            view.runningStartedAt = undefined;
            view.lastPiActivityAt = undefined;
            view.activeToolNames.clear();
        }
    }
    if (state === "running") {
        notePiActivity(activeSessionId);
    }
    else {
        clearRunningActivityTimer();
    }
    input.placeholder = state === "running" || state === "stopping"
        ? "Message Pi to redirect the current run..."
        : "Message Pi...";
    stop.hidden = isCompacting || (state !== "running" && state !== "stopping");
    stop.disabled = state === "stopping";
    if (error)
        setStatus(error, "error");
    else if (isCompacting)
        renderCompactionActivity();
    else if (state === "running")
        renderRunningActivity();
    else if (state === "stopping")
        setStatus("Stopping Pi...");
    else if (state === "failed")
        setStatus("Pi is disconnected.", "error");
    else if (status.dataset.state !== "error")
        setStatus("");
    updateSessionControls();
    updateStatusIndicator();
}
function addUserMessage(text, id, deliveryState = "sending", imageCount = 0, imagePreviews = [], createdAt, queueReason) {
    renderedTranscriptIds.add(id);
    const existing = userMessages.get(id);
    if (existing) {
        addLocalImagePreviews(existing, imagePreviews);
        if (deliveryState !== "queued" && typeof createdAt === "string")
            setMessageTimestamp(existing.article.querySelector(".message-heading"), createdAt);
        const nextImageCount = Math.max(existing.imageCount, Number.isSafeInteger(imageCount) ? imageCount : 0);
        if (!existing.previewUrls.length && nextImageCount > existing.imageCount) {
            for (let index = existing.imageCount; index < nextImageCount; index++) {
                const placeholder = document.createElement("span");
                placeholder.className = "image-message-placeholder";
                placeholder.textContent = "[Image attachment]";
                existing.attachmentEntries.append(placeholder);
            }
            if (!existing.attachmentEntries.isConnected)
                existing.delivery.before(existing.attachmentEntries);
        }
        existing.imageCount = nextImageCount;
        if (deliveryState === "sent" && existing.article.parentElement === queuedMessageList)
            moveQueuedMessageToConversation(id, createdAt);
        else if (deliveryState !== "queued" && typeof createdAt === "string")
            updateMessageTimestamp(id, createdAt);
        if (existing.body.dataset.markdownSource !== text) {
            existing.body.dataset.markdownSource = text;
            existing.body.replaceChildren(parseMarkdownFragment(text));
            placeMessageCopyButton(existing.body, existing.copyButton);
        }
        setDeliveryState(id, deliveryState, undefined, queueReason);
        return;
    }
    const wasFollowing = isNearConversationBottom();
    const article = document.createElement("article");
    article.className = "message user";
    article.dataset.messageId = id;
    if (queueReason === "compaction" || queueReason === "turn")
        article.dataset.queueReason = queueReason;
    const heading = document.createElement("h2");
    heading.className = "message-heading";
    const queuedDetails = deliveryState === "queued" ? document.createElement("details") : undefined;
    const queuedSummary = queuedDetails ? document.createElement("summary") : undefined;
    const queuedPreview = queuedDetails ? document.createElement("span") : undefined;
    const queuedState = queuedDetails ? document.createElement("span") : undefined;
    const cancelButton = queuedDetails ? document.createElement("button") : undefined;
    if (queuedDetails && queuedSummary && queuedPreview && queuedState) {
        queuedDetails.className = "queued-message-details";
        queuedSummary.className = "queued-message-summary";
        queuedPreview.className = "queued-message-preview";
        queuedState.className = "queued-message-state";
        queuedPreview.textContent = text.replace(/\s+/g, " ").trim() || "Image message";
        queuedState.textContent = "Waiting";
        queuedSummary.append(queuedPreview, queuedState);
        queuedDetails.append(queuedSummary);
    }
    if (cancelButton) {
        cancelButton.type = "button";
        cancelButton.className = "queued-message-cancel";
        cancelButton.textContent = "×";
        cancelButton.setAttribute("aria-label", "Cancel queued message");
        cancelButton.title = "Cancel this queued message";
        cancelButton.addEventListener("click", (event) => {
            event.stopPropagation();
            void cancelQueuedMessage(id);
        });
    }
    const body = document.createElement("div");
    body.className = "user-message-content markdown-content";
    body.dataset.markdownSource = text;
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
        ? queuedDeliveryText(queueReason)
        : deliveryState === "failed"
            ? "Message was not sent"
            : "Sending to Pi…";
    heading.textContent = "You";
    const copyButton = createMessageCopyButton("Copy your message", () => body.dataset.markdownSource ?? "", deliveryState === "queued");
    // The copy control shares the first Markdown text block with its text.
    setMessageTimestamp(heading, deliveryState === "queued" ? undefined : createdAt ?? messageTimestamps.get(id));
    body.replaceChildren(parseMarkdownFragment(text));
    placeMessageCopyButton(body, copyButton);
    const contentParent = queuedDetails ?? article;
    contentParent.append(heading, body);
    if (imageCount > 0 || imagePreviews.length > 0)
        contentParent.append(attachmentEntries);
    contentParent.append(delivery);
    if (queuedDetails)
        article.append(queuedDetails);
    if (cancelButton)
        article.append(cancelButton);
    (deliveryState === "queued" ? queuedMessageList : conversation).append(article);
    updateQueuedMessageArea();
    syncSendingIndicators();
    userMessages.set(id, {
        article,
        body,
        attachmentEntries,
        delivery,
        queuedDetails,
        queuedState,
        cancelButton,
        previewUrls,
        imageCount: Number.isSafeInteger(imageCount) ? imageCount : 0,
        copyButton,
    });
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
function queuedDeliveryText(reason) {
    return reason === "compaction" ? "Queued until compaction completes" : "Queued for its own Pi turn";
}
function setDeliveryState(id, deliveryState, error, queueReason) {
    const userMessage = userMessages.get(id);
    if (!userMessage)
        return;
    userMessage.copyButton.hidden = deliveryState === "queued";
    if (deliveryState === "sent") {
        if (userMessage.article.parentElement === queuedMessageList)
            moveQueuedMessageToConversation(id);
        userMessage.delivery.remove();
        return;
    }
    if (queueReason === "compaction" || queueReason === "turn")
        userMessage.article.dataset.queueReason = queueReason;
    userMessage.delivery.hidden = false;
    userMessage.delivery.dataset.state = deliveryState;
    if (userMessage.queuedState)
        userMessage.queuedState.textContent = deliveryState === "failed" ? "Not sent" : "Waiting";
    userMessage.delivery.textContent = deliveryState === "queued"
        ? queuedDeliveryText(userMessage.article.dataset.queueReason)
        : deliveryState === "failed"
            ? `Not sent: ${error || "Pi could not accept this message."}`
            : "Sending to Pi…";
    syncSendingIndicators();
}
function syncSendingIndicators() {
    const latestMessage = [...conversation.querySelectorAll(".message.user, .message.assistant")].at(-1);
    for (const delivery of conversation.querySelectorAll('.message.user .message-delivery[data-state="sending"]')) {
        delivery.hidden = delivery.closest(".message.user") !== latestMessage;
    }
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
    updateSessionControls();
}
function renderBigPi(bigPiValue, billionContextPiValue) {
    const showBillionContextPi = typeof billionContextPiValue === "object" &&
        billionContextPiValue !== null && billionContextPiValue.detected === true &&
        Number.isSafeInteger(billionContextPiValue.totalBlocks) && billionContextPiValue.totalBlocks > 0;
    // Reset the conditional row even when the newly selected session has no stats.
    bigPiDisk.hidden = showBillionContextPi;
    const showBigPi = typeof bigPiValue === "object" && bigPiValue !== null &&
        Number.isSafeInteger(bigPiValue.totalChunks) && bigPiValue.totalChunks > 0;
    const value = showBillionContextPi ? billionContextPiValue : showBigPi ? bigPiValue : null;
    if (typeof value !== "object" || value === null) {
        bigPiIndicator.hidden = true;
        bigPiIndicator.setAttribute("aria-label", "Big Pi storage statistics");
        bigPiTopLabel.textContent = "";
        return;
    }
    const tiers = value.tiers;
    const totalBlocks = showBillionContextPi ? value.totalBlocks : value.totalChunks;
    const validCounts = typeof tiers === "object" && tiers !== null &&
        [tiers.t1, tiers.t2, tiers.t3].every((count) => Number.isSafeInteger(count) && count >= 0) &&
        Number.isSafeInteger(totalBlocks) && totalBlocks >= 0;
    const counts = validCounts
        ? { t1: formatNumber(tiers.t1), t2: formatNumber(tiers.t2), t3: formatNumber(tiers.t3), total: formatNumber(totalBlocks) }
        : { t1: "Unavailable", t2: "Unavailable", t3: "Unavailable", total: "Unavailable" };
    const diskUsage = !showBillionContextPi && Number.isSafeInteger(value.diskUsageBytes) && value.diskUsageBytes >= 0
        ? formatBytes(value.diskUsageBytes)
        : showBillionContextPi ? null : "Unavailable";
    bigPiTitle.textContent = showBillionContextPi ? "Billion Context Pi Blocks" : "Big Pi Storage";
    if (diskUsage !== null) bigPiDisk.textContent = `Disk usage: ${diskUsage}`;
    bigPiTierOne.textContent = `T1: ${counts.t1}`;
    bigPiTierTwo.textContent = `T2: ${counts.t2}`;
    bigPiTierThree.textContent = `T3: ${counts.t3}`;
    bigPiTotal.textContent = `Total ${showBillionContextPi ? "blocks" : "chunks"}: ${counts.total}`;
    bigPiTopLabel.textContent = showBillionContextPi ? "B" : "";
    bigPiIndicator.setAttribute(
        "aria-label",
        showBillionContextPi
            ? `Billion Context Pi blocks. T1 ${counts.t1}, T2 ${counts.t2}, T3 ${counts.t3}, total blocks ${counts.total}.`
            : `Big Pi storage. Disk usage ${diskUsage}; T1 ${counts.t1}, T2 ${counts.t2}, T3 ${counts.t3}, total chunks ${counts.total}. Native Pi compaction does not create Big Pi chunks; chunks count successful Big Pi compressions.`,
    );
    bigPiIndicator.hidden = false;
}
function updateCompressionConflictWarning(snapshot, sessionId) {
    if (!sessionId) return;
    const bothDetected = Number.isSafeInteger(snapshot?.bigPi?.totalChunks) && snapshot.bigPi.totalChunks > 0 &&
        snapshot?.billionContextPi?.detected === true &&
        Number.isSafeInteger(snapshot.billionContextPi.totalBlocks) && snapshot.billionContextPi.totalBlocks > 0;
    if (bothDetected) {
        compressionConflictWarnings.set(sessionId,
            "Both Big Pi and Billion Context Pi session data were detected. Pi-vot is showing Billion Context Pi block summaries.");
    }
    else {
        compressionConflictWarnings.delete(sessionId);
    }
}
function formatBytes(bytes) {
    if (bytes < 1024) return `${formatNumber(bytes)} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = -1;
    do {
        value /= 1024;
        unit++;
    } while (value >= 1024 && unit < units.length - 1);
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
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
    const sessionChanged = compactionActivitySessionId !== activeSessionId;
    if (sessionChanged)
        clearCompactionActivityTimer();
    isCompacting = compacting;
    const view = activeSessionId ? runtimeView(activeSessionId) : undefined;
    if (view) {
        view.isCompacting = compacting;
        if (compacting)
            view.compactionStartedAt ??= Date.now();
        else
            view.compactionStartedAt = undefined;
    }
    if (compacting) {
        clearRunningActivityTimer();
        compactionActivitySessionId = activeSessionId;
        if (compactionActivityTimer === undefined)
            compactionActivityTimer = setInterval(renderCompactionActivity, RUNNING_ACTIVITY_REFRESH_MS);
    }
    else {
        clearCompactionActivityTimer();
        compactionActivitySessionId = undefined;
        if (status.dataset.state === "running" && status.textContent.startsWith("Compacting ·"))
            setStatus("");
        if (runState === "running")
            notePiActivity();
    }
    compact.disabled = compacting;
    compact.textContent = compacting ? "Compacting…" : "Compact";
    stop.hidden = compacting || (runState !== "running" && runState !== "stopping");
    if (!compacting) {
        contextStatus.textContent = "";
        delete contextStatus.dataset.state;
    }
    else {
        contextStatus.dataset.state = "active";
        contextStatus.textContent = "New messages are unavailable during compaction.";
    }
    updateSessionControls();
    updateStatusIndicator();
    updateSendButton();
    if (compacting)
        renderCompactionActivity();
}
function timestampElements(createdAt) {
    if (typeof createdAt !== "string")
        return null;
    const date = new Date(createdAt);
    if (!Number.isFinite(date.getTime()))
        return null;
    const time = document.createElement("time");
    time.className = "message-timestamp";
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    time.title = date.toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
    });
    return time;
}
function setMessageTimestamp(heading, createdAt) {
    heading.querySelector(".message-timestamp")?.remove();
    const time = timestampElements(createdAt);
    if (time)
        messageHeadingActions(heading).append(time);
}
function messageHeadingActions(heading) {
    let actions = heading.querySelector(".message-heading-actions");
    if (!actions) {
        actions = document.createElement("span");
        actions.className = "message-heading-actions";
        heading.append(actions);
    }
    return actions;
}
function createMessageCopyButton(label, getText, hidden = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-copy-button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.hidden = hidden;
    button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>';
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        void copyMessageText(button, label, getText());
    });
    return button;
}
function placeMessageCopyButton(container, button) {
    const textBlock = container.querySelector("p, h1, h2, h3, h4, h5, h6, li, blockquote");
    if (textBlock)
        textBlock.prepend(button);
    else
        container.prepend(button);
}
async function copyMessageText(button, originalLabel, text) {
    try {
        if (!navigator.clipboard?.writeText)
            throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(text);
        button.setAttribute("aria-label", "Copied");
        button.title = "Copied";
    }
    catch {
        button.setAttribute("aria-label", "Copy failed");
        button.title = "Copy failed";
    }
    window.setTimeout(() => {
        if (button.isConnected) {
            button.setAttribute("aria-label", originalLabel);
            button.title = originalLabel;
        }
    }, 1400);
}
function updateMessageTimestamp(messageId, createdAt) {
    if (typeof messageId !== "string" || typeof createdAt !== "string")
        return;
    messageTimestamps.set(messageId, createdAt);
    const user = userMessages.get(messageId);
    if (user)
        setMessageTimestamp(user.article.querySelector("h2"), createdAt);
    const assistant = assistants.get(messageId);
    if (assistant)
        setMessageTimestamp(assistant.article.querySelector("h2"), createdAt);
}
function updateQueuedMessageArea() {
    queuedMessageArea.hidden = queuedMessageList.childElementCount === 0;
    queuedMessagesToggle.textContent = `Queued Messages (${queuedMessageList.childElementCount})`;
}
queuedMessagesToggle.addEventListener("click", () => {
    const expanded = queuedMessagesToggle.getAttribute("aria-expanded") === "true";
    queuedMessagesToggle.setAttribute("aria-expanded", String(!expanded));
    queuedMessageList.hidden = expanded;
});
function moveQueuedMessageToConversation(messageId, createdAt) {
    const userMessage = userMessages.get(messageId);
    if (!userMessage)
        return;
    const wasFollowing = isNearConversationBottom();
    updateMessageTimestamp(messageId, typeof createdAt === "string" ? createdAt : new Date().toISOString());
    userMessage.delivery.hidden = false;
    userMessage.delivery.dataset.state = "sending";
    userMessage.delivery.textContent = "Sending to Pi…";
    userMessage.cancelButton?.remove();
    if (userMessage.queuedDetails) {
        const details = userMessage.queuedDetails;
        const summary = details.querySelector("summary");
        const contents = [...details.children].filter((child) => child !== summary);
        details.remove();
        userMessage.article.append(...contents);
        userMessage.queuedDetails = undefined;
        userMessage.queuedState = undefined;
    }
    conversation.append(userMessage.article);
    syncSendingIndicators();
    updateQueuedMessageArea();
    followLatestIfNeeded(wasFollowing);
}
function clearCompactionNotice(sessionId) {
    if (!sessionId)
        return;
    compactionNoticesBySession.delete(sessionId);
    if (sessionId === activeSessionId && !isCompacting) {
        contextStatus.textContent = "";
        delete contextStatus.dataset.state;
    }
}
function renderCompactionNotice(sessionId) {
    if (!sessionId || sessionId !== activeSessionId || isCompacting)
        return;
    const notice = compactionNoticesBySession.get(sessionId);
    contextStatus.textContent = notice?.message ?? "";
    if (notice)
        contextStatus.dataset.state = notice.state;
    else
        delete contextStatus.dataset.state;
}
function renderCompactionEntry(id, createdAt, anchorId, afterId, reason, tokensBefore, estimatedTokensAfter) {
    if ([...conversation.querySelectorAll(".compaction-event")].some((entry) => entry.dataset.compactionId === id))
        return;
    renderedTranscriptIds.add(id);
    const wasFollowing = isNearConversationBottom();
    const article = document.createElement("article");
    article.className = "message compaction-event";
    article.dataset.compactionId = id;
    const heading = document.createElement("h2");
    heading.className = "message-heading";
    const label = document.createElement("span");
    label.className = "compaction-event-label";
    label.textContent = "Compaction Event";
    const details = ["Pi compacted conversation context at this point."];
    if (["manual", "threshold", "overflow"].includes(reason))
        details.push(`Reason: ${reason}.`);
    if (Number.isFinite(tokensBefore) && Number.isFinite(estimatedTokensAfter))
        details.push(`Estimated context: ${Math.round(tokensBefore).toLocaleString()} tokens before, ${Math.round(estimatedTokensAfter).toLocaleString()} after.`);
    label.title = details.join(" ");
    label.setAttribute("aria-label", label.title);
    heading.append(label);
    setMessageTimestamp(heading, createdAt);
    article.append(heading);
    const anchor = [anchorId, afterId].filter((value) => typeof value === "string")
        .map((value) => [...conversation.querySelectorAll("[data-message-id]")]
        .find((entry) => entry.dataset.messageId === value))
        .find(Boolean);
    if (anchor)
        anchor.insertAdjacentElement("afterend", article);
    else
        conversation.append(article);
    followLatestIfNeeded(wasFollowing);
}
function assistantStart(messageId, createdAt) {
    renderedTranscriptIds.add(messageId);
    const wasFollowing = isNearConversationBottom();
    const article = document.createElement("article");
    article.className = "message assistant";
    article.dataset.messageId = messageId;
    const heading = document.createElement("h2");
    heading.className = "message-heading";
    const thinkingSlot = document.createElement("div");
    const text = document.createElement("div");
    heading.textContent = "Assistant";
    const assistant = { id: messageId, article, text, source: "", thinkingSource: "" };
    assistant.copyButton = createMessageCopyButton("Copy assistant response", () => assistant.source, true);
    setMessageTimestamp(heading, createdAt ?? messageTimestamps.get(messageId));
    text.className = "assistant-text markdown-content";
    article.append(heading, thinkingSlot, text);
    conversation.append(article);
    syncSendingIndicators();
    assistants.set(messageId, assistant);
    activeAssistant = article;
    followLatestIfNeeded(wasFollowing);
}
function completeAssistantMessage(assistant) {
    assistant.copyButton.hidden = !assistant.source.trim();
}
function discardAssistant(messageId) {
    const assistant = assistants.get(messageId);
    if (!assistant)
        return;
    if (assistant.markdownFrame !== undefined)
        cancelAnimationFrame(assistant.markdownFrame);
    if (assistant.thinkingFrame !== undefined)
        cancelAnimationFrame(assistant.thinkingFrame);
    assistant.article.remove();
    assistants.delete(messageId);
    renderedTranscriptIds.delete(messageId);
    messageTimestamps.delete(messageId);
    if (activeAssistant === assistant.article)
        activeAssistant = null;
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
    if (assistant.markdownFrame !== undefined) {
        cancelAnimationFrame(assistant.markdownFrame);
        assistant.markdownFrame = undefined;
    }
    const wasFollowing = isNearConversationBottom();
    try {
        let source = assistant.source;
        const recoveryHeading = source.match(/^\s*(?:#{1,6}\s*)?(?:✅\s*)?\*{0,2}Context Recovery Complete\*{0,2}\s*$/im);
        const recoveryUsage = source.match(/^\s*[-*]\s*Context usage:\s*(.+)$/im);
        const recoveryAvailable = source.match(/^\s*[-*]\s*Available for new work:\s*(.+)$/im);
        const recoveryDetails = [
            recoveryUsage ? `Context usage: ${recoveryUsage[1].trim()}` : "",
            recoveryAvailable ? `Available for new work: ${recoveryAvailable[1].trim()}` : "",
        ].filter(Boolean).join("\n");
        const isRecoveryNotice = Boolean(recoveryHeading && recoveryDetails);
        if (isRecoveryNotice) {
            source = source.replace(recoveryHeading[0], "")
                .replace(/^\s*\*{0,2}Current Status:\*{0,2}\s*$/im, "")
                .replace(recoveryUsage?.[0] ?? "\0", "")
                .replace(recoveryAvailable?.[0] ?? "\0", "")
                .replace(/\n{3,}/g, "\n\n").trim();
        }
        const rendered = parseMarkdownFragment(source);
        if (isRecoveryNotice) {
            const marker = document.createElement("span");
            marker.className = "context-recovery-marker";
            marker.textContent = "✅ Context Recovery Complete";
            marker.title = recoveryDetails;
            marker.setAttribute("aria-label", `Context Recovery Complete. ${recoveryDetails.replaceAll("\n", ". ")}`);
            marker.tabIndex = 0;
            assistant.text.replaceChildren(marker, rendered);
        }
        else {
            assistant.text.replaceChildren(rendered);
        }
    }
    catch {
        assistant.text.textContent = assistant.source;
    }
    placeMessageCopyButton(assistant.text, assistant.copyButton);
    followLatestIfNeeded(wasFollowing);
}
function parseMarkdownFragment(source) {
    const template = document.createElement("template");
    template.innerHTML = window.marked.parse(source, {
        gfm: true,
        breaks: false,
        renderer: markdownRenderer,
    });
    return template.content;
}
function renderMessagePreview() {
    renderMessageMarkdownOverlay();
    if (!messagePreviewOpen)
        return;
    const source = input.value;
    if (!source.trim()) {
        const empty = document.createElement("p");
        empty.className = "message-preview-empty";
        empty.textContent = "Nothing to preview yet.";
        messagePreview.replaceChildren(empty);
        return;
    }
    try {
        messagePreview.replaceChildren(parseMarkdownFragment(source));
    }
    catch {
        messagePreview.textContent = source;
    }
}
function renderMessageMarkdownOverlay() {
    if (!messageMarkdownOverlay)
        return;
    messageMarkdownOverlay.hidden = messagePreviewOpen;
    if (messagePreviewOpen)
        return;
    const source = input.value;
    const fragment = document.createDocumentFragment();
    const patterns = [
        { expression: /```([^\r\n`]*)\r?\n([\s\S]*?)\r?\n?```/g, className: "composer-markdown-fence" },
        { expression: /`[^`\r\n]+`/g, className: "composer-markdown-inline" },
    ];
    const matches = [];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern.expression))
            matches.push({ start: match.index, end: match.index + match[0].length, text: match[0], className: pattern.className });
    }
    matches.sort((left, right) => left.start - right.start || right.end - left.end);
    let offset = 0;
    for (const match of matches) {
        if (match.start < offset)
            continue;
        fragment.append(document.createTextNode(source.slice(offset, match.start)));
        const styled = document.createElement("span");
        styled.className = match.className;
        styled.textContent = match.text;
        fragment.append(styled);
        offset = match.end;
    }
    fragment.append(document.createTextNode(source.slice(offset)));
    messageMarkdownOverlay.replaceChildren(fragment);
}
function setMessagePreviewOpen(open) {
    messagePreviewOpen = open;
    input.hidden = open;
    messagePreview.hidden = !open;
    messagePreviewToggle.textContent = open ? "Edit" : "Preview";
    messagePreviewToggle.setAttribute("aria-pressed", String(open));
    renderMessagePreview();
    if (!open)
        input.focus();
}
input.addEventListener("scroll", () => {
    messageMarkdownOverlay.scrollTop = input.scrollTop;
    messageMarkdownOverlay.scrollLeft = input.scrollLeft;
});
messagePreviewToggle.addEventListener("click", () => setMessagePreviewOpen(!messagePreviewOpen));
async function openHelp() {
    if (!helpDialog.open)
        helpDialog.showModal();
    if (helpLoaded)
        return;
    helpError.hidden = true;
    helpContent.textContent = "Loading help…";
    try {
        const response = await fetch("/help.md", { headers: { Accept: "text/markdown" } });
        if (!response.ok)
            throw new Error(`Help request failed with HTTP ${response.status}.`);
        const source = await response.text();
        helpContent.replaceChildren(parseMarkdownFragment(source));
        helpLoaded = true;
    }
    catch (error) {
        helpContent.replaceChildren();
        helpError.hidden = false;
        helpError.textContent = error instanceof Error ? error.message : "Help could not be loaded.";
    }
}
helpButton.addEventListener("click", () => void openHelp());
helpClose.addEventListener("click", () => helpDialog.close());
document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const button = target.closest("button[data-copy-code]");
    const code = button?.closest(".code-block")?.querySelector("pre > code");
    if (button && code)
        void copyCode(button, code.textContent ?? "");
});
function scheduleAssistantMarkdown(assistant) {
    if (assistant.markdownFrame !== undefined)
        return;
    assistant.markdownFrame = requestAnimationFrame(() => {
        assistant.markdownFrame = undefined;
        if (assistants.get(assistant.id) === assistant)
            renderAssistantMarkdown(assistant);
    });
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
function ensureThinking(assistant) {
    if (assistant.thinking)
        return assistant.thinking;
    const details = document.createElement("details");
    details.className = "thinking";
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.className = "thinking-label";
    const preview = document.createElement("span");
    preview.className = "thinking-preview";
    preview.setAttribute("aria-hidden", "true");
    const content = document.createElement("pre");
    content.className = "thinking-content";
    label.textContent = "Thinking";
    summary.append(label, preview);
    details.append(summary, content);
    assistant.article.children[1].append(details);
    assistant.thinking = content;
    assistant.thinkingDetails = details;
    assistant.thinkingPreview = preview;
    details.addEventListener("toggle", () => {
        if (details.open) {
            content.textContent = assistant.thinkingSource;
            assistant.thinkingRendered = true;
        }
    });
    return content;
}
function latestThinkingLine(text) {
    return text.split(/\r?\n/).findLast((line) => line.trim().length > 0)?.trim() ?? "";
}
function scheduleThinkingRender(assistant) {
    if (assistant.thinkingFrame !== undefined)
        return;
    assistant.thinkingFrame = requestAnimationFrame(() => {
        assistant.thinkingFrame = undefined;
        if (assistants.get(assistant.id) !== assistant || !assistant.thinking)
            return;
        const wasFollowing = isNearConversationBottom();
        if (assistant.thinkingDetails?.open || assistant.thinkingSource.length <= MAX_COLLAPSED_DETAIL_CHARS) {
            assistant.thinking.textContent = assistant.thinkingSource;
            assistant.thinkingRendered = true;
        }
        else if (assistant.thinkingRendered) {
            assistant.thinking.textContent = "";
            assistant.thinkingRendered = false;
        }
        if (assistant.thinkingPreview)
            assistant.thinkingPreview.textContent = latestThinkingLine(assistant.thinkingSource);
        followLatestIfNeeded(wasFollowing);
    });
}
function updateThinking(messageId, text, replace = false) {
    const assistant = assistants.get(messageId);
    if (!assistant)
        return;
    assistant.thinkingSource = replace ? text : assistant.thinkingSource + text;
    ensureThinking(assistant);
    if (replace) {
        if (assistant.thinkingFrame !== undefined) {
            cancelAnimationFrame(assistant.thinkingFrame);
            assistant.thinkingFrame = undefined;
        }
        const wasFollowing = isNearConversationBottom();
        if (assistant.thinkingDetails?.open || assistant.thinkingSource.length <= MAX_COLLAPSED_DETAIL_CHARS) {
            assistant.thinking.textContent = assistant.thinkingSource;
            assistant.thinkingRendered = true;
        }
        else {
            assistant.thinking.textContent = "";
            assistant.thinkingRendered = false;
        }
        if (assistant.thinkingPreview)
            assistant.thinkingPreview.textContent = latestThinkingLine(assistant.thinkingSource);
        followLatestIfNeeded(wasFollowing);
    }
    else {
        scheduleThinkingRender(assistant);
    }
}
function toolStart(event) {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string")
        return;
    renderedTranscriptIds.add(`tool-${event.toolCallId}`);
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
    summary.append(name, state);
    details.append(summary, content);
    (activeAssistant ?? conversation).append(details);
    const tool = {
        details,
        summary: name,
        state,
        content,
        contentSource: `Input:\n${String(event.input ?? "{}")}`,
        contentRendered: false,
    };
    details.addEventListener("toggle", () => {
        if (details.open) {
            content.textContent = tool.contentSource;
            tool.contentRendered = true;
        }
    });
    if (tool.contentSource.length <= MAX_COLLAPSED_DETAIL_CHARS) {
        content.textContent = tool.contentSource;
        tool.contentRendered = true;
    }
    tools.set(event.toolCallId, tool);
    if (activeSessionId)
        runtimeView(activeSessionId).activeToolNames.set(event.toolCallId, event.toolName);
    renderRunningActivity();
    followLatestIfNeeded(wasFollowing);
}
function toolUpdate(event) {
    if (typeof event.toolCallId !== "string")
        return;
    const tool = tools.get(event.toolCallId);
    if (tool) {
        const wasFollowing = isNearConversationBottom();
        tool.contentSource = `Output:\n${String(event.output ?? "")}`;
        if (tool.details.open || tool.contentSource.length <= MAX_COLLAPSED_DETAIL_CHARS) {
            tool.content.textContent = tool.contentSource;
            tool.contentRendered = true;
        }
        else if (tool.contentRendered) {
            tool.content.textContent = "";
            tool.contentRendered = false;
        }
        followLatestIfNeeded(wasFollowing);
    }
}
function toolEnd(event) {
    if (typeof event.toolCallId !== "string")
        return;
    const tool = tools.get(event.toolCallId);
    if (!tool)
        return;
    if (activeSessionId)
        runtimeView(activeSessionId).activeToolNames.delete(event.toolCallId);
    renderRunningActivity();
    const wasFollowing = isNearConversationBottom();
    const isError = event.isError === true;
    tool.details.dataset.state = isError ? "error" : "complete";
    tool.state.textContent = isError ? "error" : "✓";
    tool.contentSource = `Output:\n${String(event.output ?? "")}`;
    if (tool.details.open || tool.contentSource.length <= MAX_COLLAPSED_DETAIL_CHARS) {
        tool.content.textContent = tool.contentSource;
        tool.contentRendered = true;
    }
    else {
        tool.content.textContent = "";
        tool.contentRendered = false;
    }
    followLatestIfNeeded(wasFollowing);
}
function handleEvent(event) {
    if (typeof event !== "object" || event === null)
        return;
    const message = event;
    const eventSessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    const owningSessionId = eventSessionId ?? activeSessionId;
    if (["assistant_start", "assistant_delta", "assistant_end", "thinking_delta", "tool_start", "tool_update", "tool_end", "user_message"].includes(message.type))
        notePiActivity(owningSessionId);
    if (owningSessionId && transcriptMutationEventTypes.has(message.type) && runtimeView(owningSessionId).isCompacting) {
        const deferred = deferredCompactionEventsBySession.get(owningSessionId) ?? [];
        deferred.push(event);
        deferredCompactionEventsBySession.set(owningSessionId, deferred);
        return;
    }
    if (message.type === "user_message") {
        if (typeof message.messageId === "string" && typeof message.createdAt === "string" && message.disposition !== "queued") {
            updateMessageTimestamp(message.messageId, message.createdAt);
            if (eventSessionId === activeSessionId && userMessages.get(message.messageId)?.article.parentElement === queuedMessageList)
                moveQueuedMessageToConversation(message.messageId, message.createdAt);
        }
        if (typeof message.messageId === "string") {
            const attempt = sendAttempts.get(message.messageId);
            if (attempt)
                attempt.messageProcessed = true;
            if (eventSessionId === activeSessionId && userMessages.has(message.messageId) && message.disposition !== "queued")
                setDeliveryState(message.messageId, "sent");
        }
        clearCompactionNotice(eventSessionId ?? activeSessionId);
    }
    if (message.type === "assistant_end" && typeof message.text === "string" && message.text.trim()) {
        updateMessageTimestamp(message.messageId, message.createdAt);
        clearCompactionNotice(eventSessionId ?? activeSessionId);
    }
    if (message.type === "assistant_start" && typeof message.messageId === "string")
        clearCompactionNotice(eventSessionId ?? activeSessionId);
    if (eventSessionId && eventSessionId === transcriptHydrationSessionId &&
        ["user_message", "assistant_start", "assistant_delta", "thinking_delta", "assistant_end", "assistant_discard", "tool_start", "tool_update", "tool_end", "queued_message", "queued_message_sent", "queued_message_failed", "queued_message_cancelled"].includes(message.type)) {
        transcriptHydrationEvents.push(event);
        return;
    }
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
    if (owningSessionId && message.type === "queued_message_cancelled" && typeof message.id === "string")
        queueSet(owningSessionId).delete(message.id);
    if (eventSessionId) {
        const state = runtimeView(eventSessionId);
        if (message.type === "state" && typeof message.state === "string") {
            state.state = message.state;
            if (message.state === "running") {
                state.runningStartedAt ??= Date.now();
                state.lastPiActivityAt ??= Date.now();
            }
            else if (message.state === "idle" || message.state === "failed") {
                state.runningStartedAt = undefined;
                state.lastPiActivityAt = undefined;
                state.activeToolNames.clear();
            }
            if (message.state === "idle" || message.state === "running")
                state.status = undefined;
        }
        if (message.type === "context_update")
            state.context = message.context;
        if (message.type === "model_update")
            state.model = message.model;
        if (message.type === "compaction_start") {
            state.isCompacting = true;
            state.compactionStartedAt ??= Date.now();
        }
        if (message.type === "compaction_end") {
            state.isCompacting = false;
            state.compactionStartedAt = undefined;
        }
        if (message.type === "tool_start" && typeof message.toolCallId === "string" && typeof message.toolName === "string")
            state.activeToolNames.set(message.toolCallId, message.toolName);
        if (message.type === "tool_end" && typeof message.toolCallId === "string")
            state.activeToolNames.delete(message.toolCallId);
        if (message.type === "queued_message" && typeof message.id === "string" && typeof message.message === "string" &&
            !state.queuedMessages.some((item) => item.id === message.id)) {
            state.queuedMessages.push({
                id: message.id,
                message: message.message,
                reason: message.reason === "compaction" ? "compaction" : "turn",
            });
        }
        if ((message.type === "queued_message_sent" || message.type === "queued_message_failed" || message.type === "queued_message_cancelled") &&
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
            if (state.isCompacting)
                state.compactionStartedAt ??= Date.now();
            else
                state.compactionStartedAt = undefined;
            if (state.state === "running")
                state.runningStartedAt ??= Date.now();
            else if (state.state === "idle" || state.state === "failed") {
                state.runningStartedAt = undefined;
                state.lastPiActivityAt = undefined;
                state.activeToolNames.clear();
            }
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
            if (eventSessionId && eventSessionId !== activeSessionId)
                return;
        }
        else if (eventSessionId !== activeSessionId) {
            if (message.type === "compaction_end")
                deferredCompactionEventsBySession.delete(eventSessionId);
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
            if (typeof message.state === "string") {
                setRunState(message.state, typeof message.error === "string" ? message.error : undefined);
                renderSessions();
            }
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
                compactionNoticesBySession.set(owningSessionId, { message: "Compaction complete.", state: "complete" });
                if (typeof message.entry === "object" && message.entry !== null &&
                    message.entry.type === "compaction" && typeof message.entry.id === "string" &&
                    typeof message.entry.createdAt === "string") {
                    renderCompactionEntry(message.entry.id, message.entry.createdAt, message.entry.anchorId, message.entry.afterId,
                        message.entry.reason, message.entry.tokensBefore, message.entry.estimatedTokensAfter);
                }
            }
            else if (message.informational === true) {
                compactionNoticesBySession.set(owningSessionId, { message: "Nothing to compact yet.", state: "info" });
            }
            else {
                const reason = message.aborted === true
                    ? "Pi native compaction was aborted. Big Pi chunk compression is reported separately."
                    :
                    typeof message.error === "string" ? message.error : "Compaction failed; the session is still available.";
                compactionNoticesBySession.set(owningSessionId, { message: reason, state: "error" });
                setStatus(reason, "error");
            }
            renderCompactionNotice(owningSessionId);
            flushDeferredCompactionEvents(owningSessionId);
            break;
        case "queued_message":
            if (typeof message.id === "string" && typeof message.message === "string") {
                const reason = message.reason === "compaction" ? "compaction" : "turn";
                if (!queuedMessages.some((queued) => queued.id === message.id)) {
                    queuedMessages.push({ id: message.id, message: message.message, reason });
                }
                const imageCount = Number.isInteger(message.imageCount) && message.imageCount > 0
                    ? message.imageCount
                    : 0;
                addUserMessage(message.message, message.id, "queued", imageCount, [], undefined, reason);
                setTransientStatus(reason === "compaction"
                    ? "Message queued until compaction completes."
                    : "Message queued for its own Pi turn.");
                updateSessionControls();
            }
            break;
        case "queued_message_sent":
            if (typeof message.id === "string") {
                queuedMessages = queuedMessages.filter((queued) => queued.id !== message.id);
                const userMessage = userMessages.get(message.id);
                if (userMessage?.article.parentElement === queuedMessageList)
                    moveQueuedMessageToConversation(message.id);
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
        case "queued_message_cancelled":
            if (typeof message.id === "string" && (!eventSessionId || eventSessionId === activeSessionId))
                removeQueuedMessageFromUi(message.id);
            break;
        case "assistant_start":
            if (typeof message.messageId === "string")
                assistantStart(message.messageId, message.createdAt);
            break;
        case "assistant_delta": {
            const assistant = typeof message.messageId === "string" ? assistants.get(message.messageId) : undefined;
            if (assistant && typeof message.text === "string") {
                assistant.source += message.text;
                scheduleAssistantMarkdown(assistant);
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
            if (assistant)
                completeAssistantMessage(assistant);
            if (typeof message.messageId === "string" && typeof message.thinking === "string") {
                if (message.thinking)
                    updateThinking(message.messageId, message.thinking, true);
                else {
                    const assistant = assistants.get(message.messageId);
                    if (assistant?.thinkingFrame !== undefined) {
                        cancelAnimationFrame(assistant.thinkingFrame);
                        assistant.thinkingFrame = undefined;
                    }
                    if (assistant) {
                        assistant.thinkingSource = "";
                        assistant.thinking?.parentElement?.remove();
                        assistant.thinking = undefined;
                    }
                }
            }
            break;
        }
        case "assistant_discard":
            if (typeof message.messageId === "string")
                discardAssistant(message.messageId);
            break;
        case "user_message":
            break;
        case "agent_settled":
            break;
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
                addWarning(message.message, eventSessionId ?? activeSessionId);
            break;
        case "error":
            if (typeof message.message === "string")
                setStatus(message.message, "error");
            break;
        case "input_disposition":
            if (message.disposition === "handled") {
                setStatus("Pi handled that input without starting a normal agent response.");
            }
            else if (message.disposition === "queued") {
                if (typeof message.messageId === "string" && eventSessionId === activeSessionId)
                    setDeliveryState(message.messageId, "queued");
                setTransientStatus("Message queued for its own Pi turn.");
            }
            else if (message.disposition === "steered") {
                setStatus("Message sent to steer the current run.");
            }
            break;
    }
}
function flushDeferredCompactionEvents(sessionId) {
    const deferred = deferredCompactionEventsBySession.get(sessionId);
    if (!deferred?.length)
        return;
    deferredCompactionEventsBySession.delete(sessionId);
    for (const event of deferred)
        handleEvent(event);
}
const events = new EventSource("/api/events");
events.onopen = () => {
    if (!hasReceivedInitialSnapshot && !selectedHistoryLoad)
        beginSelectedHistoryLoad(activeSessionId);
};
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
        const error = new Error(typeof result.error === "string" ? result.error : "Pi-vot could not complete the request.");
        if (typeof result.sessionId === "string")
            error.sessionId = result.sessionId;
        throw error;
    }
    return result;
}
function removeQueuedMessageFromUi(messageId) {
    queuedMessages = queuedMessages.filter((queued) => queued.id !== messageId);
    if (activeSessionId)
        queueSet(activeSessionId).delete(messageId);
    const userMessage = userMessages.get(messageId);
    if (userMessage?.article.parentElement === queuedMessageList) {
        for (const previewUrl of userMessage.previewUrls)
            URL.revokeObjectURL(previewUrl);
        userMessage.article.remove();
        userMessages.delete(messageId);
        renderedTranscriptIds.delete(messageId);
    }
    updateQueuedMessageArea();
    updateSessionControls();
}
async function cancelQueuedMessage(messageId) {
    if (userMessages.get(messageId)?.delivery.dataset.state === "failed") {
        removeQueuedMessageFromUi(messageId);
        return;
    }
    try {
        const result = await post("/api/queue/cancel", { messageId, sessionId: activeSessionId });
        const cancelledIds = Array.isArray(result.cancelledIds) ? result.cancelledIds : [];
        for (const cancelledId of cancelledIds)
            removeQueuedMessageFromUi(cancelledId);
        if (cancelledIds.length === 0)
            setTransientStatus("That message is already sending or is no longer queued.");
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "Pi-vot could not cancel that queued message.", "error");
    }
}
async function cancelAllQueuedMessages() {
    queuedMessagesClearButton.disabled = true;
    try {
        const result = await post("/api/queue/clear", { sessionId: activeSessionId });
        const cancelledIds = Array.isArray(result.cancelledIds) ? result.cancelledIds : [];
        const failedIds = [...queuedMessageList.querySelectorAll('.message-delivery[data-state="failed"]')]
            .map((delivery) => delivery.closest("[data-message-id]")?.dataset.messageId)
            .filter((id) => typeof id === "string");
        for (const cancelledId of [...cancelledIds, ...failedIds])
            removeQueuedMessageFromUi(cancelledId);
        if (cancelledIds.length === 0 && failedIds.length === 0)
            setTransientStatus("No waiting messages could be cancelled; a message may already be sending.");
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "Pi-vot could not cancel queued messages.", "error");
    }
    finally {
        queuedMessagesClearButton.disabled = false;
    }
}
queuedMessagesClearButton.addEventListener("click", () => void cancelAllQueuedMessages());
async function sessionAction(path, body = {}) {
    const selectionRequest = path === "/api/sessions/switch" ? ++selectionRequestId : null;
    const historyLoadId = selectionRequest !== null && typeof body.sessionId === "string"
        ? beginSelectedHistoryLoad(body.sessionId)
        : undefined;
    let applied = false;
    try {
        const result = await post(path, body);
        if (typeof result.projectDirectory === "string" &&
            (selectionRequest === null || selectionRequest === selectionRequestId)) {
            applySnapshot(result);
            applied = true;
        }
    }
    catch (error) {
        if (selectionRequest === null || selectionRequest === selectionRequestId)
            setStatus(error instanceof Error ? error.message : "Pi-vot could not complete the session operation.", "error");
    }
    finally {
        if (historyLoadId !== undefined && !applied)
            completeSelectedHistoryLoad(body.sessionId, historyLoadId);
    }
}
async function openProjectDirectory(directory) {
    const previousDirectory = displayedProjectDirectory;
    try {
        const result = await post("/api/project/select", { directory });
        if (typeof result.projectDirectory === "string") {
            navigationRevision++;
            applySnapshot(result);
            displayedProjectDirectory = result.projectDirectory;
            renderProjectDirectory();
            rememberRecentProjects([result.projectDirectory, previousDirectory]);
        }
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "Pi-vot could not open that project directory.", "error");
    }
}
async function chooseProjectDirectory() {
    try {
        const result = await post("/api/project/pick", {});
        if (typeof result.directory === "string" && result.directory.trim())
            await openProjectDirectory(result.directory);
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "The directory picker is unavailable.", "error");
    }
}
async function wakeSession(sessionId) {
    if (wakeRequests.has(sessionId))
        return;
    const selectionRequest = ++selectionRequestId;
    const historyLoadId = beginSelectedHistoryLoad(sessionId);
    let historyLoadApplied = false;
    navigationRevision++;
    wakeRequests.add(sessionId);
    updateSessionControls();
    try {
        const result = await post("/api/sessions/wake", { sessionId });
        if (typeof result.projectDirectory === "string" && selectionRequest === selectionRequestId) {
            applySnapshot(result);
            historyLoadApplied = true;
        }
    }
    catch (error) {
        if (selectionRequest === selectionRequestId)
            setStatus(error instanceof Error ? error.message : "Pi-vot could not wake this session.", "error");
    }
    finally {
        if (!historyLoadApplied)
            completeSelectedHistoryLoad(sessionId, historyLoadId);
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
projectTrigger.addEventListener("click", (event) => {
    const open = projectMenu.hidden;
    setProjectMenuOpen(open, open && event.detail === 0 ? 0 : undefined);
});
projectTrigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (projectMenu.hidden)
            setProjectMenuOpen(true, event.key === "ArrowUp" || event.key === "End" ? projectMenuItems().length - 1 : 0);
        else
            moveProjectMenuFocus(event.key);
    }
    else if (event.key === "Escape") {
        closeProjectMenu();
    }
});
projectMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        event.preventDefault();
        closeProjectMenu(true);
    }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        moveProjectMenuFocus(event.key);
    }
});
projectMenu.addEventListener("click", (event) => {
    const item = event.target.closest("button[role=menuitem]");
    if (!item)
        return;
    closeProjectMenu(true);
    if (item.dataset.action === "choose")
        void chooseProjectDirectory();
    else if (item.dataset.directory)
        void openProjectDirectory(item.dataset.directory);
});
document.addEventListener("click", (event) => {
    if (!projectPicker.contains(event.target))
        closeProjectMenu();
});
projectPicker.addEventListener("focusout", (event) => {
    if (!updatingProjectMenu &&
        (!(event.relatedTarget instanceof Node) || !projectPicker.contains(event.relatedTarget)))
        closeProjectMenu();
});
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = sendButton.dataset.mode;
    if (mode === "compacting" || isCompacting || (mode !== "send" && mode !== "queue" && mode !== "steer"))
        return;
    const composerText = input.value;
    const messages = composerText.split(/^[ \t]*;;;;;[ \t]*\r?$/m).map((part) => part.trim()).filter(Boolean);
    const sessionId = activeSessionId;
    const draftKey = composerKey();
    const directory = sessionId ? undefined : displayedProjectDirectory || projectDirectory;
    const composerAttachments = [...pendingAttachments(draftKey)];
    if (messages.length === 0 && composerAttachments.length === 0)
        return;
    if (messages.length === 0)
        messages.push("");
    draftsBySession.set(draftKey, input.value);
    updateSendButton();
    let lastAttempt;
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        const promptMode = mode === "queue" || index > 0 ? "queue" : mode;
        const attachments = index === 0 ? composerAttachments : [];
        const messageId = crypto.randomUUID();
        const attempt = { sessionId, originSessionId: sessionId, draftKey, projectDirectory: directory, navigationRevision, messageId, message, composerText, attachments, mode: promptMode, responsePending: true, queueSettled: null, messageProcessed: false };
        lastAttempt = attempt;
        sendAttempts.set(messageId, attempt);
        try {
            const images = await Promise.all(attachments.map(encodeAttachment));
            const pendingSessionId = directory ? pendingSessionIds.get(draftKey) : undefined;
            const result = await post("/api/message", {
                message,
                images,
                messageId,
                ...(sessionId || pendingSessionId ? { sessionId: sessionId || pendingSessionId } : {}),
                ...(directory ? { projectDirectory: directory } : {}),
                mode: promptMode,
            });
            rememberPrompt(draftKey, message);
            if (directory) {
                attempt.sessionId = result.sessionId ?? pendingSessionId ?? null;
                pendingSessionIds.delete(draftKey);
                if (result.snapshot && navigationRevision === attempt.navigationRevision)
                    applySnapshot(result.snapshot);
            }
            attempt.responsePending = false;
            const resultId = typeof result.messageId === "string" ? result.messageId : messageId;
            const deliveryState = result.disposition === "queued"
                ? attempt.queueSettled === true ? "sent" : attempt.queueSettled === false ? "failed" : "queued"
                : "sending";
            const ownsVisibleView = sendAttemptOwnsVisibleView(attempt);
            if (ownsVisibleView) {
                addUserMessage(message, resultId, deliveryState, attachments.length, attachments);
                if (result.disposition === "handled")
                    setStatus("Pi handled that input without starting a normal agent response.");
            }
            if (result.disposition === "queued") {
                if (attempt.queueSettled === null && ownsVisibleView)
                    setDeliveryState(resultId, "queued");
                if (promptMode === "queue") {
                    clearSentComposer(attempt);
                    if (attempt.queueSettled === true)
                        sendAttempts.delete(messageId);
                }
                else if (attempt.queueSettled === null) {
                    const targetSessionId = attempt.sessionId ?? sessionId;
                    if (targetSessionId)
                        queueSet(targetSessionId).add(resultId);
                }
                else
                    sendAttempts.delete(messageId);
            }
            else {
                if (ownsVisibleView)
                    setDeliveryState(resultId, "sent");
                clearSentComposer(attempt);
                attempt.queueSettled = true;
                sendAttempts.delete(messageId);
            }
        }
        catch (error) {
            attempt.responsePending = false;
            const detail = error instanceof Error ? error.message : undefined;
            if (directory && typeof error?.sessionId === "string")
                pendingSessionIds.set(draftKey, error.sessionId);
            const currentAttachments = pendingAttachments(draftKey);
            const sentAttachmentIds = new Set(attempt.attachments.map((attachment) => attachment.id));
            const retainedAttachments = [
                ...attempt.attachments,
                ...currentAttachments.filter((attachment) => !sentAttachmentIds.has(attachment.id)),
            ];
            if (retainedAttachments.length)
                attachmentsBySession.set(draftKey, retainedAttachments);
            const ownsVisibleView = sendAttemptOwnsVisibleView(attempt);
            if (attempt.queueSettled !== true && ownsVisibleView) {
                addUserMessage(message, messageId, "failed", attachments.length, attachments);
                setDeliveryState(messageId, "failed", detail);
                setStatus(error instanceof Error ? error.message : "Could not connect to Pi-vot.", "error");
            }
            if (ownsVisibleView)
                renderPendingAttachments();
            sendAttempts.delete(messageId);
            if (index > 0 && composerKey() === draftKey && !input.value.trim()) {
                input.value = messages.slice(index).join("\n;;;;;\n");
                draftsBySession.set(draftKey, input.value);
            }
            break;
        }
    }
    updateSendButton();
    if (lastAttempt && sendAttemptOwnsVisibleView(lastAttempt))
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
    draftsBySession.set(composerKey(), input.value);
    promptHistoryCursorByComposer.set(composerKey(), (promptHistoryByComposer.get(composerKey()) ?? []).length);
    updatePromptTemplateSuggestions();
    updateSendButton();
    renderMessagePreview();
});
input.addEventListener("keydown", (event) => {
    if (!promptTemplateSuggestions.hidden) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            movePromptTemplateSuggestion(event.key === "ArrowDown" ? 1 : -1);
            return;
        }
        if (event.key === "Tab" && promptTemplateSuggestionIndex >= 0) {
            const option = promptTemplateSuggestions.querySelector(`#prompt-template-option-${promptTemplateSuggestionIndex}`);
            const name = option?.querySelector("strong")?.textContent?.replace(/^\//, "");
            if (name) {
                event.preventDefault();
                insertPromptTemplate(name);
                return;
            }
        }
        if (event.key === "Escape") {
            event.preventDefault();
            closePromptTemplateSuggestions();
            return;
        }
    }
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        navigatePromptHistory(event.key === "ArrowUp" ? -1 : 1);
        return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing)
        return;
    event.preventDefault();
    form.requestSubmit();
});
input.addEventListener("blur", () => {
    setTimeout(() => {
        if (document.activeElement !== input)
            closePromptTemplateSuggestions();
    }, 0);
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
