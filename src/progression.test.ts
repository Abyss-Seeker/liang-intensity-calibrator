import { describe, expect, it } from "vitest";

import {
  clampPosition,
  communityLevelFromTally,
  consensusFactor,
  getProgression,
  levelSeries,
  singleVoteImpact,
  voteWeight,
} from "./progression";

describe("getProgression", () => {
  it("把 0 级映射到小难梁与第一段起点", () => {
    expect(getProgression(0)).toMatchObject({
      level: 0,
      stage: "小难梁",
      fromIndex: 0,
      toIndex: 1,
      localProgress: 0,
    });
  });

  it("让每个命名节点之间保留五个中间等级", () => {
    expect(getProgression(5)).toMatchObject({
      stage: "小难梁",
      fromIndex: 0,
      toIndex: 1,
    });
    expect(getProgression(6)).toMatchObject({
      stage: "牢梁",
      fromIndex: 1,
      toIndex: 2,
      localProgress: 0,
    });
  });

  it("把 30 级固定到梁祖终点", () => {
    expect(getProgression(30)).toMatchObject({
      level: 30,
      stage: "梁祖",
      fromIndex: 5,
      toIndex: 5,
      localProgress: 0,
    });
  });

  it("限制超出范围的输入", () => {
    expect(getProgression(-3).level).toBe(0);
    expect(getProgression(40).level).toBe(30);
  });

  it("保留范围内的连续位置", () => {
    expect(clampPosition(12.35)).toBe(12.35);
    expect(clampPosition(-0.5)).toBe(0);
    expect(clampPosition(30.5)).toBe(30);
  });
});

describe("consensusFactor", () => {
  it("空样本共识度为 0", () => {
    expect(consensusFactor(0, 0)).toBe(0);
  });

  it("小样本有下限 0.1（无死区）", () => {
    expect(consensusFactor(2, 0)).toBeCloseTo(0.1, 5);
  });

  it("接近对半（44% 反对）时共识度很低但不为零", () => {
    const c = consensusFactor(100, 80);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(0.2);
  });

  it("全赞成且样本足够（≥20）时共识度为 1", () => {
    expect(consensusFactor(20, 0)).toBe(1);
    expect(consensusFactor(100, 0)).toBe(1);
  });

  it("反对≤10%（9:1 以上）仍视为满级，共识度为 1", () => {
    expect(consensusFactor(90, 10)).toBe(1);
    expect(consensusFactor(20, 1)).toBe(1);
  });
});

describe("communityLevelFromTally", () => {
  it("净票为 0 时停留在中间 15 级", () => {
    expect(communityLevelFromTally(0, 0)).toBe(15);
  });

  it("小样本（1~3 票全赞成）有微弱影响但不虚高", () => {
    expect(communityLevelFromTally(1, 0)).toBeGreaterThan(15);
    expect(communityLevelFromTally(1, 0)).toBeLessThan(16);
    expect(communityLevelFromTally(3, 0)).toBeLessThan(17);
  });

  it("20 张全赞成登顶梁祖 30 级", () => {
    expect(communityLevelFromTally(20, 0)).toBe(30);
    expect(communityLevelFromTally(100, 0)).toBe(30);
  });

  it("20 张全反对触底小难梁 0 级", () => {
    expect(communityLevelFromTally(0, 20)).toBe(0);
  });

  it("44% 反对时等级平滑落到 16 附近，而非硬卡 15", () => {
    const disputed = communityLevelFromTally(100, 80);
    expect(disputed).toBeGreaterThan(15);
    expect(disputed).toBeLessThan(18);
  });

  it("5% 反对仍登顶梁祖 30 级", () => {
    expect(communityLevelFromTally(20, 1)).toBeGreaterThan(29.5);
  });
});

describe("singleVoteImpact", () => {
  it("全认可且样本足够时，顺风票影响力随接近满级递减", () => {
    expect(singleVoteImpact(10, 0)).toBeGreaterThan(singleVoteImpact(20, 0));
  });

  it("满级后顺风票影响力归零", () => {
    expect(singleVoteImpact(20, 0)).toBe(0);
  });

  it("等级关于上下对称", () => {
    expect(singleVoteImpact(0, 20)).toBe(singleVoteImpact(20, 0));
  });
});

describe("voteWeight", () => {
  it("age 为 0 时权重为 1", () => {
    expect(voteWeight(0)).toBe(1);
  });

  it("一个半衰期后权重约 0.5", () => {
    expect(voteWeight(5 * 24 * 3600 * 1000)).toBeCloseTo(0.5, 5);
  });
});

describe("levelSeries", () => {
  it("空事件流返回空序列", () => {
    expect(levelSeries([])).toEqual([]);
  });

  it("全赞成票累积，等级单调上升（无死区，首票即有效果）", () => {
    const now = Date.now();
    const events = [0, 1, 2, 3, 4].map((i) => ({
      t: now + i * 1000,
      d: "up" as const,
    }));
    const series = levelSeries(events);
    expect(series).toHaveLength(5);
    // 无死区：第一票就有微弱影响
    expect(series[0].level).toBeGreaterThan(15);
    expect(series[0].level).toBeLessThan(16);
    // 第 5 票更高
    expect(series[4].level).toBeGreaterThan(series[0].level);
    // 单调不减
    for (let i = 1; i < series.length; i++) {
      expect(series[i].level).toBeGreaterThanOrEqual(series[i - 1].level);
    }
  });
});
