interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

interface Env {
  ASSETS: AssetsBinding;
  VOTES: KVNamespace;
}

const COUNTS_KEY = "counts";
const VOTE_TTL_SECONDS = 24 * 60 * 60;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readCounts(env: Env): Promise<{ up: number; down: number }> {
  const raw = await env.VOTES.get(COUNTS_KEY);
  if (!raw) {
    return { up: 0, down: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as { up?: number; down?: number };
    return { up: parsed.up ?? 0, down: parsed.down ?? 0 };
  } catch {
    return { up: 0, down: 0 };
  }
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function handleVote(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return json(await readCounts(env));
  }

  if (request.method !== "POST") {
    return json({ reason: "不支持的请求方法" }, 405);
  }

  let direction: string;
  try {
    const body = (await request.json()) as { direction?: string };
    direction = body.direction ?? "";
  } catch {
    return json({ reason: "请求体不是合法 JSON" }, 400);
  }

  if (direction !== "up" && direction !== "down") {
    return json({ reason: "方向必须是 up 或 down" }, 400);
  }

  const ip = clientIp(request);
  const votedKey = `voted:${ip}`;
  const alreadyVoted = await env.VOTES.get(votedKey);
  if (alreadyVoted) {
    return json({
      ...(await readCounts(env)),
      voted: false,
      reason: "这个 IP 已经投过票了",
    });
  }

  const counts = await readCounts(env);
  if (direction === "up") {
    counts.up += 1;
  } else {
    counts.down += 1;
  }
  await env.VOTES.put(COUNTS_KEY, JSON.stringify(counts));
  await env.VOTES.put(votedKey, direction, { expirationTtl: VOTE_TTL_SECONDS });

  return json({ ...counts, voted: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/vote") {
      return handleVote(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
