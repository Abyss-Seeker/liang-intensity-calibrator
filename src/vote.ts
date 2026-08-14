export interface VoteEvent {
  t: number;
  d: "up" | "down";
}

export interface VoteTally {
  up: number;
  down: number;
  net: number;
  level: number;
  weightedUp: number;
  weightedDown: number;
  events: VoteEvent[];
  voted: boolean;
  votedDirection: "up" | "down" | null;
}

export type VoteDirection = "up" | "down";

export interface VoteResponse extends VoteTally {
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

export async function fetchVotes(): Promise<VoteTally> {
  const response = await fetch("/api/vote");
  if (!response.ok) {
    throw new Error("读取社区票数失败");
  }
  const data = (await response.json()) as VoteTally;
  return {
    up: data.up ?? 0,
    down: data.down ?? 0,
    net: data.net ?? 0,
    level: data.level ?? 15,
    weightedUp: data.weightedUp ?? data.up ?? 0,
    weightedDown: data.weightedDown ?? data.down ?? 0,
    events: data.events ?? [],
    voted: data.voted ?? false,
    votedDirection: data.votedDirection ?? null,
  };
}

export async function castVote(direction: VoteDirection): Promise<VoteResponse> {
  // 用户本地时区的下一个午夜（今天 24:00），让每天的投票在本地 0 点重置
  const now = new Date();
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  const response = await fetch("/api/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction, resetAt: nextMidnight.getTime() }),
  });
  let data: VoteResponse;
  try {
    data = (await response.json()) as VoteResponse;
  } catch {
    throw new Error("投票服务暂时异常，请稍后重试");
  }
  if (!response.ok) {
    // 后端识别到 KV 写入配额耗尽（503 + code），抛出专属错误让页面弹 banner
    if (response.status === 503 && data.code === "kv_quota") {
      throw new VoteQuotaExceededError(
        data.reason ?? "今天的投票额度用完了，站长正在加急扩容",
      );
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
    events: data.events ?? [],
    voted: data.voted ?? false,
    votedDirection: data.votedDirection ?? null,
    reason: data.reason,
  };
}
