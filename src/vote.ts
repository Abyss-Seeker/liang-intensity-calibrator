export interface VoteEvent {
  t: number;
  d: "up" | "down";
  /** 聚合票数（服务端把较早的事件按小时合并后给出），缺省视为 1 票 */
  n?: number;
}

// 数据缺口：某时间段内投票因 KV 配额耗尽而未被记录，走势图悬停时应提示。
export interface VoteGap {
  start: number;
  end: number | null;
  reason: string;
}

export interface VoteTally {
  up: number;
  down: number;
  net: number;
  level: number;
  weightedUp: number;
  weightedDown: number;
  events: VoteEvent[];
  gaps?: VoteGap[];
  voted: boolean;
  votedDirection: "up" | "down" | null;
}

export type VoteDirection = "up" | "down";

export interface VoteResponse extends VoteTally {
  reason?: string;
  code?: string;
}

/** POST /api/vote 的返回：不再包含全量事件流（见 worker.ts 注释） */
export interface VoteCastResult extends Omit<VoteTally, "events"> {
  events?: VoteEvent[];
  reason?: string;
  code?: string;
}

/** KV 写入配额耗尽（免费版 1000 次/天）时的专属错误，前端据此弹 banner */
export class VoteQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoteQuotaExceededError";
  }
}

/**
 * 网络层故障（连接被重置 / 超时 / 断网）。
 * 内地访问 Cloudflare 时连接被 RST 是常态，这类错误值得重试；
 * 服务端按「IP + 北京时间当日」去重，重复提交不会多算票，所以重试是安全的。
 */
export class VoteNetworkError extends Error {
  constructor(message = "网络连接中断") {
    super(message);
    this.name = "VoteNetworkError";
  }
}

const VOTE_TIMEOUT_MS = 12_000;
const VOTE_FETCH_TIMEOUT_MS = 25_000;
const VOTE_RETRIES = 2;
const FETCH_RETRIES = 1;
const RETRY_DELAY_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** 包一层超时：fetch 本身不会因为「连上了但不回包」而失败 */
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch {
    // 连接重置 / 超时 / DNS 失败统一归为网络层故障
    throw new VoteNetworkError();
  } finally {
    window.clearTimeout(timer);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    // 200 已到但 body 传输途中被 RST，也会走到这里
    throw new VoteNetworkError();
  }
}

function emptyTally(): VoteTally {
  return {
    up: 0,
    down: 0,
    net: 0,
    level: 15,
    weightedUp: 0,
    weightedDown: 0,
    events: [],
    gaps: [],
    voted: false,
    votedDirection: null,
  };
}

export async function fetchVotes(): Promise<VoteTally> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
    try {
      const response = await fetchWithTimeout(
        "/api/vote",
        { cache: "no-store" },
        VOTE_FETCH_TIMEOUT_MS,
      );
      if (!response.ok) throw new Error("读取社区票数失败");
      const data = await readJson<VoteTally>(response);
      const base = emptyTally();
      return {
        up: data.up ?? base.up,
        down: data.down ?? base.down,
        net: data.net ?? base.net,
        level: data.level ?? base.level,
        weightedUp: data.weightedUp ?? data.up ?? base.weightedUp,
        weightedDown: data.weightedDown ?? data.down ?? base.weightedDown,
        events: data.events ?? [],
        gaps: data.gaps ?? [],
        voted: data.voted ?? false,
        votedDirection: data.votedDirection ?? null,
      };
    } catch (error) {
      lastError = error;
      if (!(error instanceof VoteNetworkError)) throw error;
    }
  }
  throw lastError;
}

async function postVoteOnce(direction: VoteDirection): Promise<VoteCastResult> {
  // 不再发送 resetAt：每日投票重置由服务端按北京时间午夜固定计算，
  // 客户端无法再干预 TTL（防止 1 秒 TTL 无限刷票）。
  const response = await fetchWithTimeout(
    "/api/vote",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
      // 不缓存：投票是写操作，且响应带 no-store
      cache: "no-store",
    },
    VOTE_TIMEOUT_MS,
  );
  const data = await readJson<VoteCastResult>(response);
  if (!response.ok) {
    // 后端识别到 KV 写入配额耗尽（503 + code），抛出专属错误让页面弹 banner
    if (response.status === 503 && data.code === "kv_quota") {
      throw new VoteQuotaExceededError(
        data.reason ?? "今天的投票额度用完了，站长正在加急扩容",
      );
    }
    // 网关层 5xx 值得重试一次
    if (response.status === 502 || response.status === 504) {
      throw new VoteNetworkError();
    }
    throw new Error(data.reason ?? "投票失败");
  }
  return {
    up: data.up ?? 0,
    down: data.down ?? 0,
    net: data.net ?? 0,
    level: data.level ?? 15,
    weightedUp: data.weightedUp ?? data.up ?? 0,
    weightedDown: data.weightedDown ?? data.down ?? 0,
    events: data.events,
    gaps: data.gaps ?? [],
    voted: data.voted ?? false,
    votedDirection: data.votedDirection ?? null,
    reason: data.reason,
  };
}

export async function castVote(direction: VoteDirection): Promise<VoteCastResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= VOTE_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
    try {
      return await postVoteOnce(direction);
    } catch (error) {
      lastError = error;
      // 只有网络层故障重试；配额/参数/业务错误立即上抛
      if (!(error instanceof VoteNetworkError)) throw error;
    }
  }
  throw lastError;
}
