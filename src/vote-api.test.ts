import { describe, expect, it } from "vitest";
// @ts-expect-error generated worker is plain JavaScript
import worker from "../dist/server/index.js";

function makeEnv() {
  const store = new Map<string, string | null>();
  const VOTES = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
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
    body: JSON.stringify({ direction }),
  });
}

describe("vote api", () => {
  it("GET 返回初始 0 票和中间等级", async () => {
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
    expect(data.history).toEqual([]);
  });

  it("POST up 增加 up 票并记录历史", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(postVote("up"), env);
    const data = await response.json();
    expect(data.up).toBe(1);
    expect(data.down).toBe(0);
    expect(data.voted).toBe(true);
    expect(data.level).toBeGreaterThan(15);
    expect(data.history).toHaveLength(1);
    expect(data.history[0].level).toBe(data.level);
  });

  it("同 IP 一天内重复投票被拒绝", async () => {
    const { env } = makeEnv();
    await worker.fetch(postVote("up"), env);
    const response = await worker.fetch(postVote("down"), env);
    const data = await response.json();
    expect(data.voted).toBe(false);
    expect(data.up).toBe(1);
    expect(data.down).toBe(0);
  });

  it("非法方向返回 400", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(postVote("sideways"), env);
    expect(response.status).toBe(400);
  });
});
