import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import type { CommentItem } from "../src/comments-shared";

async function board(page: Page, options: { failPost?: boolean; failVote?: boolean; expiresSoon?: boolean } = {}) {
  const now = Date.now();
  let items: CommentItem[] = [
    { id: "00000000-0000-4000-8000-000000000001", body: "今天的梁系浓度刚刚好。", createdAt: now - 10000, expiresAt: now + (options.expiresSoon ? 2000 : 7200000), up: 0, down: 0, score: 0, myVote: null },
    { id: "00000000-0000-4000-8000-000000000002", body: "新来的匿名留言", createdAt: now - 5000, expiresAt: now + 7200000, up: 0, down: 0, score: 0, myVote: null },
  ];
  let posts = 0;
  let firstLoad = true;
  await page.route("**/api/comments**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      if (firstLoad && options.expiresSoon) items[0].expiresAt = Date.now() + 60000;
      firstLoad = false;
      const comments = [...items].filter(item => item.expiresAt > Date.now()).sort((a, b) => url.searchParams.get("sort") === "new" ? b.createdAt - a.createdAt : b.score - a.score || b.createdAt - a.createdAt);
      await route.fulfill({ json: { comments, hasMore: false, serverTime: Date.now() } }); return;
    }
    if (url.pathname.endsWith("/vote")) {
      if (options.failVote) { await route.fulfill({ status: 503, json: { reason: "评论服务暂时不可用，请稍后重试" } }); return; }
      const item = items.find(item => url.pathname.includes(item.id))!;
      const direction = request.postDataJSON().direction;
      item.up += Number(direction === "up") - Number(item.myVote === "up");
      item.down += Number(direction === "down") - Number(item.myVote === "down");
      item.score = item.up - item.down; item.myVote = direction;
      await route.fulfill({ json: { comment: item, serverTime: Date.now() } }); return;
    }
    posts++;
    if (options.failPost || posts > 1) { await route.fulfill({ status: 429, json: { reason: "每 5 分钟可以发布一条评论", retryAt: Date.now() + 300000 } }); return; }
    const item: CommentItem = { id: "00000000-0000-4000-8000-000000000003", body: request.postDataJSON().body, createdAt: Date.now(), expiresAt: Date.now() + 259200000, up: 0, down: 0, score: 0, myVote: null };
    items = [...items, item];
    await route.fulfill({ status: 201, json: { comment: item, serverTime: Date.now() } });
  });
}

test("发布纯文本、热门排序、赞踩撤销和改票", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await board(page); await page.goto("/");
  await expect(page).toHaveTitle(/梁|滑动/);
  const panel = page.locator(".comments-panel");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole("heading", { name: "匿名留言" })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await panel.getByLabel("说点什么").fill("<img src=x onerror=alert(1)>鲸鱼娘来了🐳");
  await panel.getByRole("button", { name: "匿名发布" }).click();
  await expect(panel.locator(".comment-text").first()).toHaveText("<img src=x onerror=alert(1)>鲸鱼娘来了🐳");
  await expect(panel.locator(".comment-text img")).toHaveCount(0);
  const old = panel.locator("li").filter({ hasText: "今天的梁系浓度" });
  await old.getByRole("button", { name: /^点赞/ }).click();
  await expect(panel.locator("li").first()).toContainText("今天的梁系浓度");
  await expect(old.getByRole("button", { name: /^撤销点赞/ })).toHaveAttribute("aria-pressed", "true");
  if (process.env.COMMENTS_SCREENSHOT_DIR) {
    await page.screenshot({ path: join(process.env.COMMENTS_SCREENSHOT_DIR, `${testInfo.project.name}-comments.png`) });
  }
  await old.getByRole("button", { name: /^点踩/ }).click();
  await expect(old.locator(".comment-score")).toHaveText("净赞 -1");
  await old.getByRole("button", { name: /^撤销点踩/ }).click();
  await expect(old.locator(".comment-score")).toHaveText("净赞 0");
  await panel.getByRole("button", { name: "最新", exact: true }).click();
  await expect(panel.locator("li").first()).toContainText("鲸鱼娘来了");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("限频后保留草稿并禁止重复提交", async ({ page }) => {
  await board(page, { failPost: true }); await page.goto("/");
  const textarea = page.getByLabel("说点什么");
  await textarea.fill("不要丢掉我的草稿");
  await page.getByRole("button", { name: "匿名发布" }).click();
  await expect(page.locator(".comments-status")).toContainText("每 5 分钟");
  await expect(textarea).toHaveValue("不要丢掉我的草稿");
  await expect(page.getByRole("button", { name: "匿名发布" })).toBeDisabled();
});

test("键盘可点赞且成功后保留操作焦点", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await board(page); await page.goto("/");
  const row = page.locator(".comments-list li").first();
  await row.getByRole("button", { name: /^点赞/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".comments-status")).toHaveText("已点赞");
  await expect(page.getByRole("button", { name: /^撤销点赞/ })).toBeFocused();
});

test("投票失败不改票数，可重试", async ({ page }) => {
  await board(page, { failVote: true }); await page.goto("/");
  const row = page.locator(".comments-list li").first();
  await row.getByRole("button", { name: /^点赞/ }).click();
  await expect(page.locator(".comments-status")).toContainText("暂时不可用");
  await expect(row.locator(".comment-score")).toHaveText("净赞 0");
  await expect(row.getByRole("button", { name: /^点赞/ })).toBeEnabled();
});

test("页面保持打开时移除刚到期的评论", async ({ page }) => {
  await page.clock.install();
  await board(page, { expiresSoon: true }); await page.goto("/");
  await expect(page.locator(".comment-text").filter({ hasText: "今天的梁系浓度" })).toHaveCount(1);
  await page.clock.fastForward(61000);
  await expect(page.locator(".comment-text").filter({ hasText: "今天的梁系浓度" })).toHaveCount(0, { timeout: 6000 });
});

test("静态 HTML 回退不会被误认为评论数据", async ({ page }) => {
  await page.route("**/api/comments**", route => route.fulfill({ contentType: "text/html", body: "<html>静态站点</html>" }));
  await page.goto("/");
  await expect(page.locator(".comments-status")).toContainText("暂不支持评论服务");
  await expect(page.locator("#strength-slider")).toBeEnabled();
});

test("真实本地后端无需手工来源头即可发布、赞踩和刷新，伪造来源不能绕过限频", async ({ page }, testInfo) => {
  // Both viewport projects share the same local IP quota. Run this one real
  // write flow once; mocked interaction coverage still runs in both viewports.
  test.skip(testInfo.project.name !== "desktop-chromium", "真实后端每个本地 IP 每 5 分钟一条，写入流程只运行一次");
  await page.goto("/");
  const text = `浏览器直连本地后端 ${Date.now()}`;
  await page.getByLabel("说点什么").fill(text);
  const published = page.waitForResponse(response => response.url().endsWith("/api/comments") && response.request().method() === "POST");
  await page.getByRole("button", { name: "匿名发布" }).click();
  expect((await published).status()).toBe(201);
  const row = page.locator(".comments-list li").filter({ hasText: text });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^点赞/ }).click();
  await expect(row.locator(".comment-score")).toHaveText("净赞 1");
  await page.reload();
  await expect(row.getByRole("button", { name: /^撤销点赞/ })).toHaveAttribute("aria-pressed", "true");
  await row.getByRole("button", { name: /^点踩/ }).click();
  await expect(row.locator(".comment-score")).toHaveText("净赞 -1");
  await row.getByRole("button", { name: /^撤销点踩/ }).click();
  await expect(row.locator(".comment-score")).toHaveText("净赞 0");
  const forged = await page.request.post("/api/comments", {
    headers: { "CF-Connecting-IP": "192.0.2.250", "X-Forwarded-For": "192.0.2.251", "X-Local-Comment-IP": "192.0.2.252" },
    data: { body: "伪造来源尝试" },
  });
  expect(forged.status()).toBe(429);
});
