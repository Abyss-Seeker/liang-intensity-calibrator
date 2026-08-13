import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

// 模拟慢网：mp4 响应延迟 3 秒（冷启动最坏情况）
await page.route("**/video/liang-evolution.mp4", async (route) => {
  await new Promise((r) => setTimeout(r, 3000));
  await route.continue();
});

const t0 = Date.now();
await page.goto("http://127.0.0.1:4199/", { waitUntil: "domcontentloaded" });
const slider = page.locator("#strength-slider");
await slider.waitFor({ state: "visible" });

// 慢网期间：滑块立即可用（不等视频）
console.log("domcontentloaded 后滑块可用，用时", Date.now() - t0, "ms");

const video = page.locator(".evolution-video");
const canvas = page.locator(".portrait-canvas");

const start = Date.now();
while (Date.now() - start < 15000) {
  const v = await video.evaluate((el) => el.readyState);
  if (v >= 2) break;
  await new Promise((r) => setTimeout(r, 200));
}
const readyMs = Date.now() - t0;
const rs = await video.evaluate((el) => el.readyState);
console.log("视频就绪: readyState=" + rs + "，耗时 " + readyMs + "ms（mp4 延迟 3s，期望 >3000）");

// 就绪后立即渲染
await page.locator("#strength-slider").evaluate((el) => {
  const i = el;
  i.value = "21.5";
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(1000);
const state = await video.evaluate((el) => ({
  currentTime: el.currentTime,
  duration: el.duration,
}));
const frame = await canvas.getAttribute("data-frame");
const expected = (21.5 / 30) * state.duration;
console.log(
  "慢网后拖 21.5: data-frame=" + frame + ", currentTime=" + state.currentTime.toFixed(2) + " (期望 " + expected.toFixed(2) + ")",
);
console.log(
  Math.abs(state.currentTime - expected) < 0.3 ? "OK 慢网冷启动渲染正常" : "FAIL 慢网渲染异常",
);
console.log("页面错误:", errors.length ? errors : "无");
await browser.close();
