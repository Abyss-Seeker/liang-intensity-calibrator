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
