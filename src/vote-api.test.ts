import { describe, expect, it } from "vitest";
// @ts-expect-error generated worker is plain JavaScript
import worker from "../dist/server/index.js";

function makeEnv(opts?: { failPuts?: boolean }) {
  const store = new Map<string, string | null>();
  const VOTES = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      if (opts?.failPuts) {
        throw new Error("KV write quota exceeded");
      }
      store.set(key, value);
    },
  };
  return {
    env: {
      ASSETS: {
        fetch: () => Promise.resolve(new Response("ok")),
      },
      VOTES,
    },
  };
}

function postVote(direction: string): Request {
  return new Request("https://example.com/api/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction, resetAt: Date.now() + 86400000 }),
  });
}

describe("vote api", () => {
  it("GET 返回初始 0 票、中间等级和未投票状态", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.com/api/vote"),
      env,
    );
    const data = await response.json();
    expect(data.up).toBe(0);
    expect(data.down).toBe(0);
    expect(data.net).toBe(0);
    expect(data.level).toBe(15);
    expect(data.events).toEqual([]);
    expect(data.voted).toBe(false);
    expect(data.votedDirection).toBe(null);
  });

  it("POST up 增加 up 票并记录事件流与已投票状态", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(postVote("up"), env);
    const data = await response.json();
    expect(data.up).toBe(1);
    expect(data.down).toBe(0);
    expect(data.voted).toBe(true);
    expect(data.votedDirection).toBe("up");
    expect(data.level).toBeGreaterThan(15);
    expect(data.events).toHaveLength(1);
    expect(data.events[0].d).toBe("up");
  });

  it("GET 能返回当前 IP 的已投票状态", async () => {
    const { env } = makeEnv();
    await worker.fetch(postVote("up"), env);
    const response = await worker.fetch(
      new Request("https://example.com/api/vote"),
      env,
    );
    const data = await response.json();
    expect(data.voted).toBe(true);
    expect(data.votedDirection).toBe("up");
  });

  it("同 IP 一天内重复投票被拒绝", async () => {
    const { env } = makeEnv();
    await worker.fetch(postVote("up"), env);
    const response = await worker.fetch(postVote("down"), env);
    const data = await response.json();
    expect(data.voted).toBe(true);
    expect(data.votedDirection).toBe("up");
    expect(data.reason).toContain("已经投过");
    expect(data.up).toBe(1);
    expect(data.down).toBe(0);
  });

  it("非法方向返回 400", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(postVote("sideways"), env);
    expect(response.status).toBe(400);
  });

  it("KV 写入失败（配额耗尽）时返回 503 + kv_quota 标识，而非 500 错误页", async () => {
    const { env } = makeEnv({ failPuts: true });
    const response = await worker.fetch(postVote("up"), env);
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.code).toBe("kv_quota");
    expect(data.reason).toContain("急头白脸");
    // 未记录事件，前端可据此弹 banner
    expect(data.up).toBe(0);
    expect(data.events).toEqual([]);
  });

  it("GET 返回已知事故缺口（2026-08-14 限额爆了的静态窗口）", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.com/api/vote"),
      env,
    );
    const data = await response.json();
    expect(Array.isArray(data.gaps)).toBe(true);
    expect(data.gaps.length).toBeGreaterThanOrEqual(1);
    const known = data.gaps.find((g: { reason: string }) =>
      g.reason.includes("限额爆了"),
    );
    expect(known).toBeTruthy();
    expect(known.start).toBe(Date.UTC(2026, 7, 14, 1, 53, 0)); // 北京 09:53
    expect(known.end).toBe(Date.UTC(2026, 7, 14, 4, 11, 0)); // 北京 12:11
  });

  it("KV 写入失败后自动收集运行期缺口（同一 isolate 内 GET 可见）", async () => {
    const { env } = makeEnv({ failPuts: true });
    const before = await (
      await worker.fetch(new Request("https://example.com/api/vote"), env)
    ).json();
    const fail = await worker.fetch(postVote("up"), env);
    expect(fail.status).toBe(503);
    const after = await (
      await worker.fetch(new Request("https://example.com/api/vote"), env)
    ).json();
    // 失败要么新建缺口，要么延续已有的进行中缺口，绝不减少
    expect(after.gaps.length).toBeGreaterThanOrEqual(before.gaps.length);
    const lastGap = after.gaps[after.gaps.length - 1];
    expect(lastGap.end).toBeNull(); // 进行中
    expect(lastGap.reason).toContain("限额爆了");
  });

  it("未注册 /api/settings 端点（半衰期改为前端本地）", async () => {
    const { env } = makeEnv();
    // 应回退到 ASSETS 静态资源（200），而非 settings JSON 处理
    const response = await worker.fetch(
      new Request("https://example.com/api/settings"),
      env,
    );
    expect(response.status).toBe(200);
  });
});
