import { describe, expect, it } from "vitest";

import {
  clampPosition,
  communityLevelFromTally,
  getProgression,
  singleVoteImpact,
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

  it("能到达梁祖 30 级（不会被锁死在中间）", () => {
    expect(communityLevelFromTally(100, 0)).toBe(30);
    expect(communityLevelFromTally(1000, 0)).toBe(30);
  });

  it("能到达小难梁 0 级", () => {
    expect(communityLevelFromTally(0, 100)).toBe(0);
  });

  it("单票影响力随票数增加而递减，满级后归零", () => {
    const early = singleVoteImpact(0, 0);
    const late = singleVoteImpact(80, 0);
    expect(early).toBeGreaterThan(late);
    expect(singleVoteImpact(200, 0)).toBe(0);
  });
});
