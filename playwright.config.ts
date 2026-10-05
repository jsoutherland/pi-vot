import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "node --experimental-strip-types scripts/browser-test-server.ts",
    url: "http://127.0.0.1:4174/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
