export { VoteCoordinator } from "./vote-coordinator";

import type { DurableObjectNamespace } from "cloudflare:workers";

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetsBinding;
  VOTE_COORDINATOR: DurableObjectNamespace;
}

const VOTER_COOKIE = "liang_voter";
const VOTER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

function apiError(reason: string, status: number, code?: string): Response {
  return new Response(JSON.stringify({ ...(code ? { code } : {}), reason }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function validVoterId(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{16,128}$/.test(value));
}

function voterCookie(value: string): string {
  return [
    `${VOTER_COOKIE}=${value}`,
    `Max-Age=${VOTER_COOKIE_MAX_AGE}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

async function handleVote(request: Request, env: Env): Promise<Response> {
  const suppliedVoterId = readCookie(request, VOTER_COOKIE);
  const hasVoterCookie = validVoterId(suppliedVoterId);
  const voterId = hasVoterCookie ? suppliedVoterId : crypto.randomUUID();

  // 外层 Worker 始终覆盖内部身份头，客户端无法伪造 cookie/IP 哈希输入。
  const headers = new Headers(request.headers);
  headers.set("X-Liang-Voter-Id", voterId);
  headers.set("X-Liang-Client-IP", clientIp(request));
  const internalRequest = new Request(request, { headers });
  let response: Response;
  try {
    const objectId = env.VOTE_COORDINATOR.idFromName(
      "global-vote-coordinator",
    );
    response = await env.VOTE_COORDINATOR.get(objectId).fetch(internalRequest);
  } catch (error) {
    console.error("[vote] Durable Object 请求失败", error);
    response = apiError(
      "投票服务暂时不可用，请稍后再试",
      503,
      "vote_storage_unavailable",
    );
  }

  if (hasVoterCookie) return response;
  const responseHeaders = new Headers(response.headers);
  responseHeaders.append("Set-Cookie", voterCookie(voterId));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/vote") {
      if (request.method !== "GET" && request.method !== "POST") {
        return apiError("不支持的请求方法", 405);
      }
      if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) {
          return apiError("不允许跨站提交投票", 403);
        }
        const contentType = request.headers
          .get("Content-Type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (contentType !== "application/json") {
          return apiError("投票请求必须使用 application/json", 415);
        }
        const contentLength = Number(request.headers.get("Content-Length"));
        if (Number.isFinite(contentLength) && contentLength > 1_024) {
          return apiError("投票请求体过大", 413);
        }
      }
      return handleVote(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
