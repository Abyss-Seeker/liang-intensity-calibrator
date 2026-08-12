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
// 用平方根压缩：投票人越少、每票影响力越大，随票数增加逐渐放缓，
// 但累计仍能到达两个极端（0 级「小难梁」/ 30 级「梁祖」），不会永远卡在中间。
export const COMMUNITY_BASE_LEVEL = 15;
export const VOTE_FULL_NET = 100; // 到达满级所需的净票数（可调）

export function communityLevelFromTally(up: number, down: number): number {
  const net = up - down;
  if (net === 0) return COMMUNITY_BASE_LEVEL;
  const magnitude = Math.min(
    1,
    Math.sqrt(Math.abs(net)) / Math.sqrt(VOTE_FULL_NET),
  );
  return clampPosition(
    COMMUNITY_BASE_LEVEL + COMMUNITY_BASE_LEVEL * magnitude * Math.sign(net),
  );
}

// 单票影响力：在当前票数下，再投一票（顺风方向）能改变约多少级。
// 用于向用户展示「你的一票现在有多重」——票越少时这个值越大。
export function singleVoteImpact(up: number, down: number): number {
  const net = up - down;
  const current = communityLevelFromTally(up, down);
  const next =
    net >= 0
      ? communityLevelFromTally(up + 1, down)
      : communityLevelFromTally(up, down + 1);
  return Math.abs(next - current);
}
