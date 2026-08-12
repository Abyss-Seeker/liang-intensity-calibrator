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

interface HistoryEntry {
  t: number;
  up: number;
  down: number;
}

const COUNTS_KEY = "counts";
const HISTORY_KEY = "history";
const HISTORY_MAX_ENTRIES = 200;
const VOTE_TTL_SECONDS = 24 * 60 * 60; // 同 IP 每 24 小时（一天）一票

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

async function readHistory(env: Env): Promise<HistoryEntry[]> {
  const raw = await env.VOTES.get(HISTORY_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function handleVote(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const counts = await readCounts(env);
    const history = await readHistory(env);
    return json({ ...counts, history });
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
      history: await readHistory(env),
      voted: false,
      reason: "今天已经投过票了，明天再来吧",
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

  const history = await readHistory(env);
  history.push({ t: Date.now(), up: counts.up, down: counts.down });
  const trimmedHistory = history.slice(-HISTORY_MAX_ENTRIES);
  await env.VOTES.put(HISTORY_KEY, JSON.stringify(trimmedHistory));

  return json({ ...counts, voted: true, history: trimmedHistory });
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
