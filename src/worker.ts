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
const CONSENSUS_FLOOR = 0.1; // 共识度下限：对半附近每票仍有微弱影响（无死区）
const CONSENSUS_R_FULL = 0.1; // 满级容忍带：少数方占比 ≤10%（即 9:1 以上）即满级
const CONSENSUS_N_FULL = 20; // 样本满级门槛：总票数 ≥20 才精确满级
const HALF_LIFE_MS = 18 * 3600 * 1000; // 指数半衰期，固定 18 小时
const WINDOW_MS = 30 * 24 * 3600 * 1000; // 只统计最近 30 天
const EVENTS_KEY = "events";
const EVENTS_MAX = 100000; // 事件流上限，超出丢弃最旧
const VOTE_TTL_SECONDS = 24 * 60 * 60; // 兜底：未提供 resetAt 时的默认 TTL

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// 共识度：少数方占比容忍带 × 样本因子，输出 0~1，无死区。
// 反对 ≤10%（9:1 以上）→ 满分；对半 → 下限 0.1；总票数 ≥20 → 样本因子 1（满级可达）。
function consensusFactor(up: number, down: number): number {
  const n = up + down;
  if (n <= 0) return 0;
  const r = Math.min(up, down) / n; // 少数方占比 0~0.5
  const raw = (0.5 - r) / (0.5 - CONSENSUS_R_FULL);
  const floored = Math.max(raw, CONSENSUS_FLOOR);
  const capped = Math.min(floored, 1);
  const sample = Math.min(1, n / CONSENSUS_N_FULL);
  return capped * sample;
}

// 由加权票数计算等级：方向(净票符号) × 强度(净票规模) × 共识度(多数方占比)。
function levelFromTally(upW: number, downW: number): number {
  const net = upW - downW;
  if (net === 0) return BASE_LEVEL;
  const strength = Math.min(1, Math.sqrt(Math.abs(net)) / Math.sqrt(VOTE_FULL_NET));
  const consensus = consensusFactor(upW, downW);
  return Math.min(
    30,
    Math.max(
      0,
      BASE_LEVEL + BASE_LEVEL * strength * consensus * Math.sign(net),
    ),
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

// 计算当前加权票数与等级（时间衰减后），供等级映射使用。
function computeTally(events: VoteEvent[], now: number) {
  let up = 0;
  let down = 0;
  let upW = 0;
  let downW = 0;
  for (const e of events) {
    const age = now - e.t;
    if (age < 0 || age > WINDOW_MS) continue;
    const w = voteWeight(age);
    if (e.d === "up") {
      up += 1;
      upW += w;
    } else {
      down += 1;
      downW += w;
    }
  }
  return {
    up,
    down,
    net: upW - downW,
    weightedUp: upW,
    weightedDown: downW,
    level: levelFromTally(upW, downW),
  };
}

// 根据用户本地时区的"下一个午夜"时间戳计算 voted:{ip} 的 TTL。
// resetAt 是前端传来的本地午夜绝对时间戳（毫秒）；TTL 是"离午夜还剩多少秒"，
// 让每天的投票在用户本地 0 点重置（而非投完 24h）。clamp 到 [1s, 24h]。
function voteTtlSeconds(resetAt: unknown, now: number): number {
  const ms = Number(resetAt);
  if (!Number.isFinite(ms) || ms <= now) return VOTE_TTL_SECONDS;
  const seconds = Math.round((ms - now) / 1000);
  return Math.min(Math.max(seconds, 1), VOTE_TTL_SECONDS);
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
  let resetAt: unknown;
  try {
    const body = (await request.json()) as {
      direction?: string;
      resetAt?: unknown;
    };
    direction = body.direction ?? "";
    resetAt = body.resetAt;
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

  const now = Date.now();
  const events = await readEvents(env);
  events.push({ t: now, d: direction });
  const trimmed = events.slice(-EVENTS_MAX);
  await env.VOTES.put(EVENTS_KEY, JSON.stringify(trimmed));
  await env.VOTES.put(votedKey, direction, {
    expirationTtl: voteTtlSeconds(resetAt, now),
  });

  const tally = computeTally(trimmed, now);
  return json({
    ...tally,
    events: trimmed,
    voted: true,
    votedDirection: direction,
  });
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
