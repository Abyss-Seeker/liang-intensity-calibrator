import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

// mock /api/vote：造 24h 内事件，缺口段（UTC 01:53~04:11）内无票
const gapStart = Date.UTC(2026, 7, 14, 1, 53, 0);
const gapEnd = Date.UTC(2026, 7, 14, 4, 11, 0);
const now = Date.now();
const events = [];
const ts = [];
for (let i = 0; i < 40; i += 1) {
  const t = now - i * 40 * 60 * 1000; // 每 40 分钟一票
  if (t >= gapStart && t <= gapEnd) continue; // 缺口内不录
  events.push({ t, d: i % 3 === 0 ? "down" : "up" });
}
events.sort((a, b) => a.t - b.t);
const mockTally = {
  up: events.filter((e) => e.d === "up").length,
  down: events.filter((e) => e.d === "down").length,
  net: 8,
  level: 21.4,
  weightedUp: 12,
  weightedDown: 4,
  events,
  gaps: [
    { start: gapStart, end: gapEnd, reason: "网页限额爆了，数据未录入，不准确" },
  ],
  voted: false,
  votedDirection: null,
};
await page.route("**/api/vote", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockTally) }),
);

await page.goto("http://127.0.0.1:4199/", { waitUntil: "networkidle" });
const svg = page.locator(".vote-chart-svg");
await svg.waitFor({ state: "visible" });
await page.waitForTimeout(2000);

const result = await page.evaluate(() => {
  const svg = document.querySelector(".vote-chart-svg");
  const gapEl = document.querySelector(".chart-tooltip-gap");
  const tip = document.querySelector(".chart-tooltip");
  if (!svg || !gapEl || !tip) return { error: "missing nodes" };
  const r = svg.getBoundingClientRect();
  const fromT = Number(svg.dataset.fromT);
  const toT = Number(svg.dataset.toT);
  const plotW = Number(svg.dataset.plotW);
  const gapStart = Date.UTC(2026, 7, 14, 1, 53, 0);
  const gapEnd = Date.UTC(2026, 7, 14, 4, 11, 0);
  const padLeft = 34;
  const xOf = (t) => padLeft + ((t - fromT) / (toT - fromT)) * plotW;
  return {
    fromT,
    toT,
    plotW,
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    gapMidX: xOf((gapStart + gapEnd) / 2),
    outsideX: Math.max(padLeft + 10, xOf(gapStart) - 120),
  };
});
console.log("图表:", JSON.stringify(result));

// 悬停缺口段中间
await page.mouse.move(result.rect.left + result.gapMidX, result.rect.top + 60);
await page.waitForTimeout(400);
const inGap = await page.evaluate(() => ({
  tipHidden: document.querySelector(".chart-tooltip").hidden,
  gapHidden: document.querySelector(".chart-tooltip-gap").hidden,
  gapText: document.querySelector(".chart-tooltip-gap").textContent,
  timeText: document.querySelector(".chart-tooltip-time").textContent,
}));
console.log("缺口内:", JSON.stringify(inGap));

// 悬停缺口外（更早的时间）
await page.mouse.move(result.rect.left + result.outsideX, result.rect.top + 60);
await page.waitForTimeout(400);
const outGap = await page.evaluate(() => ({
  tipHidden: document.querySelector(".chart-tooltip").hidden,
  gapHidden: document.querySelector(".chart-tooltip-gap").hidden,
}));
console.log("缺口外:", JSON.stringify(outGap));

console.log("页面错误:", errors.length ? errors : "无");
await page.screenshot({ path: "output/gap-tooltip-check.png", clip: { x: 0, y: 0, width: 1000, height: 800 } });
await browser.close();
