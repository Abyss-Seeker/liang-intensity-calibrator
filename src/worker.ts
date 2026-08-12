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
  level: number;
}

const BASE_LEVEL = 15;
const VOTE_FULL_NET = 20; // 20 净票满级（梁祖/小难梁）
const WINDOW_DAYS = 30; // 只统计最近 30 天
const HALF_LIFE_DAYS = 7; // 指数半衰期 7 天，久远的票影响力淡化
const HISTORY_KEY = "history";
const HISTORY_MAX_ENTRIES = 500;
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

function dayKey(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return `d:${d.toISOString().slice(0, 10)}`;
}

function levelFromNet(net: number): number {
  if (net === 0) return BASE_LEVEL;
  const magnitude = Math.min(
    1,
    Math.sqrt(Math.abs(net)) / Math.sqrt(VOTE_FULL_NET),
  );
  return Math.min(
    30,
    Math.max(0, BASE_LEVEL + BASE_LEVEL * magnitude * Math.sign(net)),
  );
}

async function readTally(
  env: Env,
): Promise<{ up: number; down: number; net: number; level: number }> {
  let weightedUp = 0;
  let weightedDown = 0;
  let totalUp = 0;
  let totalDown = 0;
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const raw = await env.VOTES.get(dayKey(i));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { up?: number; down?: number };
      const up = parsed.up ?? 0;
      const down = parsed.down ?? 0;
      const weight = Math.pow(0.5, i / HALF_LIFE_DAYS);
      weightedUp += up * weight;
      weightedDown += down * weight;
      totalUp += up;
      totalDown += down;
    } catch {
      // 忽略损坏数据
    }
  }
  const net = weightedUp - weightedDown;
  return { up: totalUp, down: totalDown, net, level: levelFromNet(net) };
}

async function readHistory(env: Env): Promise<HistoryEntry[]> {
  const raw = await env.VOTES.get(HISTORY_KEY);
  if (!raw) return [];
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
    const tally = await readTally(env);
    const history = await readHistory(env);
    return json({ ...tally, history });
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
    const tally = await readTally(env);
    return json({
      ...tally,
      history: await readHistory(env),
      voted: false,
      reason: "今天已经投过票了，明天再来吧",
    });
  }

  const todayKey = dayKey(0);
  const raw = await env.VOTES.get(todayKey);
  let up = 0;
  let down = 0;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { up?: number; down?: number };
      up = parsed.up ?? 0;
      down = parsed.down ?? 0;
    } catch {
      // 忽略损坏数据
    }
  }
  if (direction === "up") up += 1;
  else down += 1;
  await env.VOTES.put(todayKey, JSON.stringify({ up, down }));
  await env.VOTES.put(votedKey, direction, { expirationTtl: VOTE_TTL_SECONDS });

  const tally = await readTally(env);
  const history = await readHistory(env);
  history.push({ t: Date.now(), level: tally.level });
  const trimmed = history.slice(-HISTORY_MAX_ENTRIES);
  await env.VOTES.put(HISTORY_KEY, JSON.stringify(trimmed));

  return json({ ...tally, voted: true, history: trimmed });
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
