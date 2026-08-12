export interface VoteTally {
  up: number;
  down: number;
}

export type VoteDirection = "up" | "down";

export interface VoteResponse extends VoteTally {
  voted?: boolean;
  reason?: string;
}

export async function fetchVotes(): Promise<VoteTally> {
  const response = await fetch("/api/vote");
  if (!response.ok) {
    throw new Error("读取社区票数失败");
  }
  const data = (await response.json()) as VoteTally;
  return { up: data.up ?? 0, down: data.down ?? 0 };
}

export async function castVote(direction: VoteDirection): Promise<VoteResponse> {
  const response = await fetch("/api/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction }),
  });
  const data = (await response.json()) as VoteResponse;
  if (!response.ok) {
    throw new Error(data.reason ?? "投票失败");
  }
  return data;
}
