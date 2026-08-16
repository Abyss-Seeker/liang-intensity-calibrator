export interface VoteEvent {
  t: number;
  d: "up" | "down";
}

// 数据缺口：某时间段内投票因 KV 配额耗尽未被记录，走势图悬停时应提示。
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
  eventsTruncated?: boolean;
  totalEvents?: number;
  gaps?: VoteGap[];
  voted: boolean;
  votedDirection: "up" | "down" | null;
}

export type VoteDirection = "up" | "down";

export interface VoteResponse extends VoteTally {
  reason?: string;
  code?: string;
}

/** 投票协调器或持久化暂时不可用，前端据此弹出服务告警。 */
export class VoteServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoteServiceUnavailableError";
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
    eventsTruncated: data.eventsTruncated ?? false,
    totalEvents: data.totalEvents ?? data.events?.length ?? 0,
    gaps: data.gaps ?? [],
    voted: data.voted ?? false,
    votedDirection: data.votedDirection ?? null,
  };
}

export async function castVote(direction: VoteDirection): Promise<VoteResponse> {
  const response = await fetch("/api/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction }),
  });
  let data: VoteResponse;
  try {
    data = (await response.json()) as VoteResponse;
  } catch {
    throw new Error("投票服务暂时异常，请稍后重试");
  }
  if (!response.ok) {
    if (response.status === 503 && data.code === "vote_storage_unavailable") {
      throw new VoteServiceUnavailableError(
        data.reason ?? "投票服务暂时不可用，请稍后再试",
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
    eventsTruncated: data.eventsTruncated ?? false,
    totalEvents: data.totalEvents ?? data.events?.length ?? 0,
    gaps: data.gaps ?? [],
    voted: data.voted ?? false,
    votedDirection: data.votedDirection ?? null,
    reason: data.reason,
  };
}
