import { describe, expect, it } from "vitest";

import {
  clampPosition,
  communityLevelFromTally,
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

describe("communityLevelFromTally", () => {
  it("净票为 0 时停留在中间 15 级", () => {
    expect(communityLevelFromTally(0, 0)).toBe(15);
  });

  it("票少时每票影响大、随票数增加逐渐放缓", () => {
    const first =
      communityLevelFromTally(1, 0) - communityLevelFromTally(0, 0);
    const tenth =
      communityLevelFromTally(10, 0) - communityLevelFromTally(9, 0);
    expect(first).toBeGreaterThan(tenth);
  });

  it("20 净票到达梁祖 30 级", () => {
    expect(communityLevelFromTally(20, 0)).toBe(30);
    expect(communityLevelFromTally(100, 0)).toBe(30);
  });

  it("20 净票到达小难梁 0 级", () => {
    expect(communityLevelFromTally(0, 20)).toBe(0);
  });

  it("单票影响力随净票增加而递减，满级后归零", () => {
    const early = singleVoteImpact(0);
    const late = singleVoteImpact(15);
    expect(early).toBeGreaterThan(late);
    expect(singleVoteImpact(30)).toBe(0);
  });
});

describe("voteWeight", () => {
  it("age 为 0 时权重为 1", () => {
    expect(voteWeight(0)).toBe(1);
  });

  it("一个半衰期后权重约 0.5", () => {
    expect(voteWeight(7 * 24 * 3600 * 1000)).toBeCloseTo(0.5, 5);
  });
});

describe("levelSeries", () => {
  it("空事件流返回空序列", () => {
    expect(levelSeries([])).toEqual([]);
  });

  it("按时间排序累计净票，返回每个时间点的等级", () => {
    const now = Date.now();
    const series = levelSeries([
      { t: now + 1000, d: "up" as const },
      { t: now, d: "up" as const },
      { t: now + 2000, d: "down" as const },
    ]);
    expect(series).toHaveLength(3);
    // 第一票 up → 等级升高
    expect(series[0].level).toBeGreaterThan(15);
    // 第二票 up → 更高
    expect(series[1].level).toBeGreaterThan(series[0].level);
    // 第三票 down → 回落
    expect(series[2].level).toBeLessThan(series[1].level);
  });
});
