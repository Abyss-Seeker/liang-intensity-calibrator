import { afterEach, describe, expect, it, vi } from "vitest";
import { castVote } from "./vote";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("castVote", () => {
  it("只发送投票方向，不发送客户端 resetAt", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          up: 1,
          down: 0,
          net: 1,
          level: 16,
          weightedUp: 1,
          weightedDown: 0,
          events: [{ t: 1, d: "up" }],
          gaps: [],
          voted: true,
          votedDirection: "up",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await castVote("up");

    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({ direction: "up" });
  });

  it("保留后端 429 的具体错误信息", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "rate_limited",
          reason: "请求过于频繁，请一分钟后再试",
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(castVote("up")).rejects.toThrow("请求过于频繁");
  });
});
