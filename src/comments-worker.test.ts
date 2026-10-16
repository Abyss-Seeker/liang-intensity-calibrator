import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Comments, handleComments, type CommentStorage } from "./comments-worker";
import { COMMENT_COOLDOWN, COMMENT_DAY, COMMENT_TTL } from "./comments-shared";

const start = Date.UTC(2026, 9, 17);
let db: DatabaseSync;
let board: Comments;
let alarm: number | null;
function req(path = "", body?: unknown, ip = "192.0.2.1", headers = {}) {
  return new Request(`https://example.com/api/comments${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(ip ? { "CF-Connecting-IP": ip } : {}), "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function create(text = "你好", ip?: string) {
  const response = await board.fetch(req("", { body: text }, ip));
  expect(response.status).toBe(201);
  return (await response.json() as any).comment;
}
async function page(sort = "hot", ip?: string) {
  return await (await board.fetch(req(`?sort=${sort}`, undefined, ip))).json() as any;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start);
  alarm = null; db = new DatabaseSync(":memory:");
  const storage: CommentStorage = {
    sql: { exec(query, ...values) {
      if (query.includes("CREATE TABLE")) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...values);
      return { toArray: () => rows as never[] };
    } },
    transactionSync(callback) {
      db.exec("BEGIN");
      try { const result = callback(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async setAlarm(time) { alarm = time; }, async deleteAlarm() { alarm = null; },
  };
  let queue = Promise.resolve();
  board = new Comments({ storage, blockConcurrencyWhile(callback) {
    const result = queue.then(callback); queue = result.then(() => {}, () => {}); return result;
  } });
});
afterEach(() => { vi.useRealTimers(); db.close(); });

describe("匿名评论与到期清理", () => {
  it("只返回公开字段，按服务端时间保存纯文本，保留换行和 emoji", async () => {
    const item = await create("  <img src=x onerror=alert(1)>\n🐳  ");
    expect(item).toMatchObject({ body: "<img src=x onerror=alert(1)>\n🐳", createdAt: start, expiresAt: start + COMMENT_TTL, up: 0, down: 0, score: 0, myVote: null });
    expect(Object.keys(item).sort()).toEqual(["id", "body", "createdAt", "expiresAt", "up", "down", "score", "myVote"].sort());
    expect(alarm).toBe(start + COMMENT_DAY);
    const stored = db.prepare("SELECT actor FROM posts").get()!.actor;
    expect(stored).toMatch(/^[a-f0-9]{64}$/); expect(stored).not.toContain("192.0.2");
  });
  it("拒绝空内容、超长内容、错误类型，500 个 Unicode 字符可发布", async () => {
    for (const body of [{ body: " " }, { body: "a".repeat(501) }, { body: 1 }, null, []]) {
      expect((await board.fetch(req("", body))).status).toBe(400);
    }
    await create("🐳".repeat(500));
  });
  it("按 IP 执行 5 分钟冷却和滚动 24 小时 5 条额度", async () => {
    await create();
    const limited = await board.fetch(req("", { body: "重复" }));
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("300");
    await create("另一个访客", "192.0.2.2");
    for (let i = 1; i < 5; i++) { vi.setSystemTime(start + i * COMMENT_COOLDOWN); await create(); }
    vi.setSystemTime(start + 5 * COMMENT_COOLDOWN);
    expect((await board.fetch(req("", { body: "第六条" }))).status).toBe(429);
    vi.setSystemTime(start + COMMENT_DAY); await create("滚动释放第一条额度");
  });
  it("72 小时整从列表消失且不能投票，alarm 删除内容、赞踩和限频记录", async () => {
    const item = await create();
    await board.fetch(req(`/${item.id}/vote`, { direction: "up" }));
    vi.setSystemTime(start + COMMENT_TTL - 1); expect((await page()).comments).toHaveLength(1);
    vi.setSystemTime(start + COMMENT_TTL); await board.alarm();
    expect((await page()).comments).toHaveLength(0);
    expect((await board.fetch(req(`/${item.id}/vote`, { direction: "up" }))).status).toBe(404);
    for (const table of ["comments", "votes", "posts"]) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
    expect(alarm).toBeNull();
  });
  it("请求时也会清理过期数据，不依赖 alarm 准时触发", async () => {
    await create(); vi.setSystemTime(start + COMMENT_TTL);
    expect((await page()).comments).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM comments").get()!.n).toBe(0);
  });
});

describe("赞踩、排序和请求边界", () => {
  it("一条评论每 IP 一票，重复操作幂等，赞踩互斥，支持撤销和改票", async () => {
    const item = await create();
    for (const direction of ["up", "up", "down", null, null, "up"]) {
      const result = await (await board.fetch(req(`/${item.id}/vote`, { direction }))).json() as any;
      expect(result.comment).toMatchObject({ up: Number(direction === "up"), down: Number(direction === "down"), myVote: direction });
    }
    expect((await page("hot", "192.0.2.2")).comments[0].myVote).toBeNull();
    expect((await board.fetch(req(`/${item.id}/vote`, { direction: "invalid" }))).status).toBe(400);
  });
  it("净赞优先，同分新优先；最新排序独立，负分评论仍然展示", async () => {
    const older = await create("旧", "192.0.2.1");
    vi.setSystemTime(start + 1); const newer = await create("新", "192.0.2.2");
    expect((await page()).comments.map((c: any) => c.id)).toEqual([newer.id, older.id]);
    await board.fetch(req(`/${older.id}/vote`, { direction: "up" }));
    await board.fetch(req(`/${newer.id}/vote`, { direction: "down" }));
    expect((await page()).comments.map((c: any) => c.id)).toEqual([older.id, newer.id]);
    expect((await page("new")).comments.map((c: any) => c.id)).toEqual([newer.id, older.id]);
  });
  it("分页不截断整个评论池，并拒绝非法排序与偏移", async () => {
    for (let i = 0; i < 21; i++) { vi.setSystemTime(start + i); await create(`第 ${i} 条`, `192.0.2.${i + 1}`); }
    const first = await page(); expect(first.comments).toHaveLength(20); expect(first.hasMore).toBe(true);
    const second = await (await board.fetch(req("?offset=20"))).json() as any;
    expect(second.comments).toHaveLength(1); expect(second.hasMore).toBe(false);
    for (const query of ["?sort=invalid", "?offset=-1", "?offset=1.5", "?offset=Infinity"]) expect((await board.fetch(req(query))).status).toBe(400);
  });
  it("拒绝跨站、非 JSON、超大请求、缺失 IP 和非法路由", async () => {
    expect((await board.fetch(req("", { body: "x" }, "192.0.2.1", { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await board.fetch(req("", { body: "x" }, "192.0.2.1", { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect((await board.fetch(req("", { body: "x" }, "192.0.2.1", { "Content-Type": "text/plain" }))).status).toBe(415);
    expect((await board.fetch(req("", { body: "x" }, ""))).status).toBe(403);
    expect((await board.fetch(req("", { body: "x".repeat(5000) }))).status).toBe(413);
    expect((await board.fetch(req("/missing"))).status).toBe(404);
    expect((await board.fetch(new Request("https://example.com/api/comments", { method: "DELETE" }))).status).toBe(405);
    expect((await board.fetch(req())).headers.get("Cache-Control")).toBe("no-store");
  });
  it("绑定缺失或存储异常时返回可重试的 JSON 错误", async () => {
    expect((await handleComments(req())).status).toBe(503);
    const response = await handleComments(req(), { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("storage"); } }) });
    expect(response.status).toBe(503); expect(response.headers.get("content-type")).toContain("application/json");
  });
});
