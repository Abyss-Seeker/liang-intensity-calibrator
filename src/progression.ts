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

// 社区投票 → 等级映射。
// 等级 = 方向(净票符号) × 强度(净票规模) × 共识度(少数方占比 + 样本因子)。
// 时间衰减在 worker 端完成（按票加权），前端拿到的是加权后的 up/down。
export const COMMUNITY_BASE_LEVEL = 15;
export const VOTE_FULL_NET = 20; // 20 净票满级（强度维度）
export const CONSENSUS_FLOOR = 0.1; // 共识度下限：对半附近每票仍有微弱影响（无死区）
export const CONSENSUS_R_FULL = 0.1; // 满级容忍带：少数方占比 ≤10%（即 9:1 以上）即满级
export const CONSENSUS_N_FULL = 20; // 样本满级门槛：总票数 ≥20 才精确满级

// 共识度：少数方占比容忍带 × 样本因子，输出 0~1，无死区。
// 反对 ≤10%（9:1 以上）→ 满分；对半 → 下限 0.1；总票数 ≥20 → 样本因子 1（满级可达）。
export function consensusFactor(up: number, down: number): number {
  const n = up + down;
  if (n <= 0) return 0;
  const r = Math.min(up, down) / n; // 少数方占比 0~0.5
  const raw = (0.5 - r) / (0.5 - CONSENSUS_R_FULL); // r=0.1 满分，r=0.5 对半=0
  const floored = Math.max(raw, CONSENSUS_FLOOR);
  const capped = Math.min(floored, 1);
  const sample = Math.min(1, n / CONSENSUS_N_FULL);
  return capped * sample;
}

// 由加权票数计算等级：方向(净票符号) × 强度(净票规模) × 共识度(多数方占比)。
export function levelFromTally(up: number, down: number): number {
  const net = up - down;
  if (net === 0) return COMMUNITY_BASE_LEVEL;
  const strength = Math.min(
    1,
    Math.sqrt(Math.abs(net)) / Math.sqrt(VOTE_FULL_NET),
  );
  const consensus = consensusFactor(up, down);
  return clampPosition(
    COMMUNITY_BASE_LEVEL +
      COMMUNITY_BASE_LEVEL * strength * consensus * Math.sign(net),
  );
}

export function communityLevelFromTally(up: number, down: number): number {
  return levelFromTally(up, down);
}

// 单票影响力：顺着当前净票方向再投一票，等级约变化多少。
export function singleVoteImpact(up: number, down: number): number {
  const net = up - down;
  const current = levelFromTally(up, down);
  const next =
    net >= 0 ? levelFromTally(up + 1, down) : levelFromTally(up, down + 1);
  return Math.abs(next - current);
}

// —— 时间衰减（与 worker 端保持一致）——
export const DEFAULT_HALF_LIFE_HOURS = 120; // 默认半衰期 120 小时（5 天）
export const VOTE_WINDOW_MS = 30 * 24 * 3600 * 1000; // 只统计最近 30 天

// 半衰期（小时）→ 毫秒
export function halfLifeMsFromHours(hours: number): number {
  return hours * 3600 * 1000;
}

// 单票在 age 毫秒前的权重（指数半衰期）
export function voteWeight(ageMs: number, halfLifeMs: number): number {
  return Math.pow(0.5, ageMs / halfLifeMs);
}

export interface VoteEventPoint {
  t: number;
  d: "up" | "down";
}

// 事件流 → 走势序列：按时间排序，累计加权净票，返回每个时间点的等级。
// 用滑动窗口（30 天）逐点推进，均摊 O(n)。半衰期由调用方传入。
export function levelSeries(
  events: VoteEventPoint[],
  halfLifeMs: number,
): { t: number; level: number }[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const points: { t: number; level: number }[] = [];
  let upW = 0;
  let downW = 0;
  let lastT = -1;
  const active: { t: number; d: "up" | "down" }[] = [];
  let head = 0;

  for (const e of sorted) {
    if (lastT >= 0 && e.t > lastT) {
      // 所有活跃票统一随时间衰减
      const w = voteWeight(e.t - lastT, halfLifeMs);
      upW *= w;
      downW *= w;
    }
    // 移除超出 30 天窗口的旧票
    while (head < active.length && e.t - active[head].t > VOTE_WINDOW_MS) {
      const w = voteWeight(e.t - active[head].t, halfLifeMs);
      if (active[head].d === "up") upW -= w;
      else downW -= w;
      head += 1;
    }
    // 加入新票（age = 0，权重 = 1）
    if (e.d === "up") upW += 1;
    else downW += 1;
    active.push({ t: e.t, d: e.d });
    lastT = e.t;
    points.push({ t: e.t, level: levelFromTally(upW, downW) });
  }
  return points;
}

// 从事件流 + 本地半衰期直接算加权票数与等级（前端本地重算用，
// 让"社区评定/单票影响力"跟随用户自己设定的半衰期，而非后端全局值）。
export function tallyFromEvents(
  events: VoteEventPoint[],
  halfLifeMs: number,
  now: number,
): { up: number; down: number; weightedUp: number; weightedDown: number; level: number } {
  let up = 0;
  let down = 0;
  let upW = 0;
  let downW = 0;
  for (const e of events) {
    const age = now - e.t;
    if (age < 0 || age > VOTE_WINDOW_MS) continue;
    const w = voteWeight(age, halfLifeMs);
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
    weightedUp: upW,
    weightedDown: downW,
    level: levelFromTally(upW, downW),
  };
}
