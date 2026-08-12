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

// 社区投票 → 等级映射：从中间 15 级起，每 1 张净票（up - down）移动 0.5 级。
export const COMMUNITY_BASE_LEVEL = 15;
export const COMMUNITY_VOTE_STEP = 0.5;

export function communityLevelFromTally(up: number, down: number): number {
  return clampPosition(COMMUNITY_BASE_LEVEL + (up - down) * COMMUNITY_VOTE_STEP);
}
