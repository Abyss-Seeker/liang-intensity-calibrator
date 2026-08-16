import { describe, expect, it } from "vitest";
import worker from "./worker";

interface ForwardedRequest {
  method: string;
  voterId: string | null;
  clientIp: string | null;
  body: unknown;
}

function makeEnv(
  responseStatus = 200,
  options: { rejectFetch?: boolean } = {},
) {
  const forwarded: ForwardedRequest[] = [];
  const env = {
    ASSETS: {
      fetch: () => Promise.resolve(new Response("asset")),
    },
    VOTE_COORDINATOR: {
      idFromName(name: string) {
        return name;
      },
      get() {
        return {
          async fetch(request: Request) {
            if (options.rejectFetch) {
              throw new Error("Durable Object unavailable");
            }
            let body: unknown = null;
            if (request.method === "POST") body = await request.json();
            forwarded.push({
              method: request.method,
              voterId: request.headers.get("X-Liang-Voter-Id"),
              clientIp: request.headers.get("X-Liang-Client-IP"),
              body,
            });
            return new Response(
              JSON.stringify({
                up: 0,
                down: 0,
                events: [],
                voted: false,
                votedDirection: null,
              }),
              {
                status: responseStatus,
                headers: { "Content-Type": "application/json" },
              },
            );
          },
        };
      },
    },
  };
  return { env, forwarded };
}

describe("vote worker boundary", () => {
  it("首次访问签发 HttpOnly 匿名身份 cookie 并转发可信 IP", async () => {
    const { env, forwarded } = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.com/api/vote", {
        headers: {
          "CF-Connecting-IP": "198.51.100.10",
          "X-Liang-Voter-Id": "attacker-controlled-value",
          "X-Liang-Client-IP": "203.0.113.99",
        },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toMatch(
      /^liang_voter=[A-Za-z0-9-]+; Max-Age=31536000; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].voterId).not.toBe("attacker-controlled-value");
    expect(forwarded[0].clientIp).toBe("198.51.100.10");
  });

  it("复用合法匿名 cookie，不重复发送 Set-Cookie", async () => {
    const { env, forwarded } = makeEnv();
    const voterId = "12345678-1234-1234-1234-123456789abc";
    const response = await worker.fetch(
      new Request("https://example.com/api/vote", {
        headers: { Cookie: `liang_voter=${voterId}` },
      }),
      env,
    );

    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(forwarded[0].voterId).toBe(voterId);
  });

  it("POST 请求体原样交给协调器，由协调器忽略未知 resetAt", async () => {
    const { env, forwarded } = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.com/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "up", resetAt: Date.now() + 2_000 }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(forwarded[0].body).toEqual({
      direction: "up",
      resetAt: expect.any(Number),
    });
  });

  it("拒绝跨站 POST，避免用简单请求静默注入投票", async () => {
    const { env, forwarded } = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.com/api/vote", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "text/plain",
        },
        body: JSON.stringify({ direction: "up" }),
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ reason: "不允许跨站提交投票" });
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(forwarded).toEqual([]);
  });

  it("同源 POST 仍须使用 application/json", async () => {
    const { env, forwarded } = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.com/api/vote", {
        method: "POST",
        headers: {
          Origin: "https://example.com",
          "Content-Type": "text/plain",
        },
        body: JSON.stringify({ direction: "up" }),
      }),
      env,
    );

    expect(response.status).toBe(415);
    expect(forwarded).toEqual([]);
  });

  it("OPTIONS 不进入协调器且不返回跨域许可头", async () => {
    const { env, forwarded } = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.com/api/vote", {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
      env,
    );

    expect(response.status).toBe(405);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(forwarded).toEqual([]);
  });

  it("协调器错误状态与响应体不被外层吞掉", async () => {
    const { env } = makeEnv(503);
    const response = await worker.fetch(
      new Request("https://example.com/api/vote"),
      env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
  });

  it("协调器调用抛错时规范化为可识别的 JSON 503", async () => {
    const { env } = makeEnv(200, { rejectFetch: true });
    const response = await worker.fetch(
      new Request("https://example.com/api/vote"),
      env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "vote_storage_unavailable",
      reason: "投票服务暂时不可用，请稍后再试",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("非投票路径继续交给静态资源绑定", async () => {
    const { env, forwarded } = makeEnv();
    const response = await worker.fetch(
      new Request("https://example.com/not-vote"),
      env,
    );
    expect(await response.text()).toBe("asset");
    expect(forwarded).toEqual([]);
  });
});
