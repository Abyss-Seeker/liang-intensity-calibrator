export const STAGES = ["小难梁", "牢梁", "梁子", "梁圣", "梁神", "梁祖"] as const;

export const MAX_LEVEL = 30;
export const LEVELS_PER_STAGE = 6;

export type StageName = (typeof STAGES)[number];

export interface ProgressionState {
  level: number;
  stage: StageName;
  stageIndex: number;
  fromIndex: number;
  toIndex: number;
  localProgress: number;
  strength: number;
}

export function clampPosition(rawPosition: number): number {
  return Math.min(MAX_LEVEL, Math.max(0, rawPosition));
}

export function getProgression(rawLevel: number): ProgressionState {
  const level = Math.round(clampPosition(rawLevel));
  const stageIndex = Math.floor(level / LEVELS_PER_STAGE);
  const isFinalStage = stageIndex === STAGES.length - 1;
  const localProgress = isFinalStage
    ? 0
    : (level - stageIndex * LEVELS_PER_STAGE) / LEVELS_PER_STAGE;

  return {
    level,
    stage: STAGES[stageIndex],
    stageIndex,
    fromIndex: stageIndex,
    toIndex: isFinalStage ? stageIndex : stageIndex + 1,
    localProgress,
    strength: level / MAX_LEVEL,
  };
}

// 社区投票 → 等级映射（流量自适应）。
// 用平方根压缩：净票越少、每票影响力越大，随净票增加逐渐放缓，
// 但累计仍能到达两个极端（0 级「小难梁」/ 30 级「梁祖」）。
// 时间衰减在 worker 端完成（按天加权），前端拿到的是加权后的 net。
export const COMMUNITY_BASE_LEVEL = 15;
export const VOTE_FULL_NET = 20; // 20 净票满级

export function levelFromNet(net: number): number {
  if (net === 0) return COMMUNITY_BASE_LEVEL;
  const magnitude = Math.min(
    1,
    Math.sqrt(Math.abs(net)) / Math.sqrt(VOTE_FULL_NET),
  );
  return clampPosition(
    COMMUNITY_BASE_LEVEL + COMMUNITY_BASE_LEVEL * magnitude * Math.sign(net),
  );
}

export function communityLevelFromTally(up: number, down: number): number {
  return levelFromNet(up - down);
}

// 单票影响力：在当前加权净票下，再投一票（顺风方向）能改变约多少级。
export function singleVoteImpact(net: number): number {
  const current = levelFromNet(net);
  const next = net >= 0 ? levelFromNet(net + 1) : levelFromNet(net - 1);
  return Math.abs(next - current);
}

// —— 时间衰减（与 worker 端保持一致）——
export const VOTE_HALF_LIFE_MS = 7 * 24 * 3600 * 1000; // 指数半衰期 7 天
export const VOTE_WINDOW_MS = 30 * 24 * 3600 * 1000; // 只统计最近 30 天

// 单票在 age 毫秒前的权重（指数半衰期）
export function voteWeight(ageMs: number): number {
  return Math.pow(0.5, ageMs / VOTE_HALF_LIFE_MS);
}

export interface VoteEventPoint {
  t: number;
  d: "up" | "down";
}

// 事件流 → 走势序列：按时间排序，累计加权净票，返回每个时间点的等级。
// 用滑动窗口（30 天）逐点推进，均摊 O(n)。
export function levelSeries(events: VoteEventPoint[]): { t: number; level: number }[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const points: { t: number; level: number }[] = [];
  let net = 0;
  let lastT = -1;
  const active: { t: number; d: "up" | "down" }[] = [];
  let head = 0;

  for (const e of sorted) {
    if (lastT >= 0 && e.t > lastT) {
      // 所有活跃票统一随时间衰减
      net *= voteWeight(e.t - lastT);
    }
    // 移除超出 30 天窗口的旧票
    while (head < active.length && e.t - active[head].t > VOTE_WINDOW_MS) {
      net -= (active[head].d === "up" ? 1 : -1) * voteWeight(e.t - active[head].t);
      head += 1;
    }
    // 加入新票（age = 0，权重 = 1）
    net += e.d === "up" ? 1 : -1;
    active.push({ t: e.t, d: e.d });
    lastT = e.t;
    points.push({ t: e.t, level: levelFromNet(net) });
  }
  return points;
}
