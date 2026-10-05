import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMarkdownLanguage, safeMarkdownHref, supportedMarkdownLanguage } from "../web/markdown-security.js";

test("Markdown links allow web URLs and reject executable or unsupported schemes", () => {
  assert.equal(safeMarkdownHref("https://example.com/path"), "https://example.com/path");
  assert.equal(safeMarkdownHref("http://example.com/path"), "http://example.com/path");
  assert.equal(safeMarkdownHref("/relative/path", "https://pi-vot.test/chat"), "https://pi-vot.test/relative/path");
  assert.equal(safeMarkdownHref("javascript:alert(1)"), null);
  assert.equal(safeMarkdownHref("data:text/html,<script>"), null);
  assert.equal(safeMarkdownHref("mailto:person@example.com"), null);
  assert.equal(safeMarkdownHref("https://example.com/\npath"), null);
});

test("code fence language aliases normalize and unknown languages fall back to plaintext", () => {
  assert.equal(normalizeMarkdownLanguage(" JS title=demo"), "javascript");
  assert.equal(normalizeMarkdownLanguage("ts"), "typescript");
  assert.equal(normalizeMarkdownLanguage("plaintext"), null);
  assert.equal(supportedMarkdownLanguage("python", (language) => language === "python"), "python");
  assert.equal(supportedMarkdownLanguage("unknown-parser", () => false), null);
  assert.equal(supportedMarkdownLanguage("unknown parser", () => true), "unknown");
});
