const languageAliases = new Map([
    ["bash", "bash"],
    ["c", "c"],
    ["c++", "cpp"],
    ["cpp", "cpp"],
    ["css", "css"],
    ["go", "go"],
    ["golang", "go"],
    ["html", "xml"],
    ["java", "java"],
    ["javascript", "javascript"],
    ["js", "javascript"],
    ["json", "json"],
    ["md", "markdown"],
    ["markdown", "markdown"],
    ["py", "python"],
    ["python", "python"],
    ["rust", "rust"],
    ["sh", "bash"],
    ["shell", "bash"],
    ["sql", "sql"],
    ["text", null],
    ["textile", null],
    ["plaintext", null],
    ["plain", null],
    ["ts", "typescript"],
    ["typescript", "typescript"],
    ["xml", "xml"],
]);

export function normalizeMarkdownLanguage(info) {
    if (typeof info !== "string")
        return null;
    const language = info.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (!language || !/^[a-z0-9+#.-]+$/.test(language))
        return null;
    return languageAliases.has(language) ? languageAliases.get(language) : language;
}

export function supportedMarkdownLanguage(info, supportsLanguage) {
    const language = normalizeMarkdownLanguage(info);
    return language && supportsLanguage(language) ? language : null;
}

export function safeMarkdownHref(href, baseUrl = "http://localhost/") {
    if (typeof href !== "string" || /[\u0000-\u001f\u007f]/.test(href))
        return null;
    try {
        const url = new URL(href.trim(), baseUrl);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    }
    catch {
        return null;
    }
}
