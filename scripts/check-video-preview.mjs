import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto("http://127.0.0.1:4199/", { waitUntil: "domcontentloaded" });

const video = page.locator(".evolution-video");
const canvas = page.locator(".portrait-canvas");

async function waitReadyState(target, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await video.evaluate((el) => el.readyState);
    if (v >= target) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("readyState poll timeout");
}

await waitReadyState(2, 20000);
console.log("video readyState >= 2 就绪");

await page.waitForTimeout(1500);
const initial = await canvas.evaluate((el) => ({
  w: el.width,
  h: el.height,
  frame: el.dataset.frame,
}));
console.log("首帧 canvas:", JSON.stringify(initial));

await page.locator("#strength-slider").evaluate((el) => {
  const i = el;
  i.value = "12.35";
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(1200);
const mid = await video.evaluate((el) => ({
  currentTime: el.currentTime,
  duration: el.duration,
  seeking: el.seeking,
}));
const frameMid = await canvas.getAttribute("data-frame");
const expectedMid = (12.35 / 30) * mid.duration;
console.log(
  "拖 12.35: data-frame=" +
    frameMid +
    ", currentTime=" +
    mid.currentTime.toFixed(3) +
    "/" +
    mid.duration.toFixed(2) +
    " (期望 " +
    expectedMid.toFixed(3) +
    "), seeking=" +
    mid.seeking,
);
console.log(
  Math.abs(mid.currentTime - expectedMid) < 0.2 ? "OK seek 到位" : "FAIL seek 不到位",
);

await page.locator("#strength-slider").evaluate((el) => {
  const i = el;
  for (const l of [2, 27, 4, 22, 8, 30]) {
    i.value = String(l);
    i.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await page.waitForTimeout(1500);
const last = await video.evaluate((el) => ({
  currentTime: el.currentTime,
  duration: el.duration,
}));
const frameLast = await canvas.getAttribute("data-frame");
console.log(
  "快速拖到 30: data-frame=" +
    frameLast +
    ", currentTime=" +
    last.currentTime.toFixed(3) +
    "/" +
    last.duration.toFixed(2) +
    " (期望 " +
    (last.duration - 1 / 30).toFixed(3) +
    ")",
);
console.log(
  frameLast === "240" && Math.abs(last.currentTime - (last.duration - 1 / 30)) < 0.3
    ? "OK 最后一帧上屏"
    : "FAIL 最后一帧未上屏",
);

const pixels = await canvas.evaluate((el) => {
  const c = el.getContext("2d");
  if (!c) return null;
  const d = c.getImageData(0, 0, Math.min(el.width, 80), Math.min(el.height, 80)).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  return sum / (d.length / 4);
});
console.log(
  "canvas 平均像素亮度: " + (pixels ? pixels.toFixed(1) : "null"),
  pixels && pixels > 0 ? "OK 有内容" : "FAIL 空白",
);
console.log("页面错误:", errors.length ? errors : "无");
await page.screenshot({
  path: "output/video-preview-check.png",
  clip: { x: 0, y: 0, width: 900, height: 700 },
});
await browser.close();
