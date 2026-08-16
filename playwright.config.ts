import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const testPort = 5187;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  // 241 帧媒体用例并发过高会争抢解码资源，导致加载超时型假失败。
  workers: 4,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${testPort}`,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${testPort}`,
    url: `http://127.0.0.1:${testPort}`,
    reuseExistingServer: true,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
      },
    },
  ],
});
