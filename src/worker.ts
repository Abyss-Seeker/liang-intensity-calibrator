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

interface VoteEvent {
  t: number;
  d: "up" | "down";
}

const BASE_LEVEL = 15;
const VOTE_FULL_NET = 20; // 20 净票满级（梁祖/小难梁）
const HALF_LIFE_MS = 7 * 24 * 3600 * 1000; // 指数半衰期 7 天
const WINDOW_MS = 30 * 24 * 3600 * 1000; // 只统计最近 30 天
const EVENTS_KEY = "events";
const EVENTS_MAX = 100000; // 事件流上限，超出丢弃最旧
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

// 单票在 age 毫秒前的权重（指数半衰期）
function voteWeight(ageMs: number): number {
  return Math.pow(0.5, ageMs / HALF_LIFE_MS);
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function readEvents(env: Env): Promise<VoteEvent[]> {
  const raw = await env.VOTES.get(EVENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as VoteEvent[]) : [];
  } catch {
    return [];
  }
}

// 计算当前加权净票（时间衰减后），供等级映射使用。
function computeTally(events: VoteEvent[], now: number) {
  let up = 0;
  let down = 0;
  let weightedNet = 0;
  for (const e of events) {
    const age = now - e.t;
    if (age < 0 || age > WINDOW_MS) continue;
    const w = voteWeight(age);
    if (e.d === "up") {
      up += 1;
      weightedNet += w;
    } else {
      down += 1;
      weightedNet -= w;
    }
  }
  return {
    up,
    down,
    net: weightedNet,
    level: levelFromNet(weightedNet),
  };
}

async function handleVote(request: Request, env: Env): Promise<Response> {
  const ip = clientIp(request);
  const votedKey = `voted:${ip}`;
  const alreadyVoted = await env.VOTES.get(votedKey);

  if (request.method === "GET") {
    const events = await readEvents(env);
    const tally = computeTally(events, Date.now());
    return json({
      ...tally,
      events,
      voted: Boolean(alreadyVoted),
      votedDirection: alreadyVoted ?? null,
    });
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

  if (alreadyVoted) {
    const events = await readEvents(env);
    const tally = computeTally(events, Date.now());
    return json({
      ...tally,
      events,
      voted: true,
      votedDirection: alreadyVoted,
      reason: "今天已经投过票了，明天再来吧",
    });
  }

  const events = await readEvents(env);
  events.push({ t: Date.now(), d: direction });
  const trimmed = events.slice(-EVENTS_MAX);
  await env.VOTES.put(EVENTS_KEY, JSON.stringify(trimmed));
  await env.VOTES.put(votedKey, direction, { expirationTtl: VOTE_TTL_SECONDS });

  const tally = computeTally(trimmed, Date.now());
  return json({ ...tally, events: trimmed, voted: true, votedDirection: direction });
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
