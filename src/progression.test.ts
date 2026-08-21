import { describe, expect, it } from "vitest";

import {
  clampPosition,
  communityLevelFromTally,
  consensusFactor,
  DEFAULT_HALF_LIFE_HOURS,
  getProgression,
  halfLifeMsFromHours,
  levelSeries,
  singleVoteImpact,
  tallyFromEvents,
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

  it("缓冲带内负数/超界等级如实保留，阶段按边界展示", () => {
    expect(getProgression(-3)).toMatchObject({
      level: -3,
      stage: "小难梁",
      stageIndex: 0,
    });
    expect(getProgression(40)).toMatchObject({
      level: 40,
      stage: "梁祖",
      stageIndex: 5,
    });
  });

  it("限制超出显示范围的输入（缓冲带 [-30, 60]）", () => {
    expect(getProgression(-35).level).toBe(-30);
    expect(getProgression(70).level).toBe(60);
  });

  it("保留范围内的连续位置", () => {
    expect(clampPosition(12.35)).toBe(12.35);
    expect(clampPosition(-0.5)).toBe(-0.5);
    expect(clampPosition(30.5)).toBe(30.5);
    expect(clampPosition(-35)).toBe(-30);
    expect(clampPosition(65)).toBe(60);
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

  it("恰好 20 张全赞成登顶梁祖 30 级（阈值处与旧算法一致）", () => {
    expect(communityLevelFromTally(20, 0)).toBe(30);
  });

  it("超额票数突破 30 进入缓冲带（不再被 clamp）", () => {
    expect(communityLevelFromTally(100, 0)).toBeCloseTo(31.3459, 3);
  });

  it("20 张全反对触底小难梁 0 级", () => {
    expect(communityLevelFromTally(0, 20)).toBe(0);
  });

  it("净票不超过满级阈值时，与旧算法完全一致（0~30 内相同票数相同分数）", () => {
    // 旧公式：15 + 15·sqrt(|net|/20)·consensus·sign(net)
    const oldLevel = (up: number, down: number): number => {
      const net = up - down;
      if (net === 0) return 15;
      return (
        15 +
        15 *
          Math.min(1, Math.sqrt(Math.abs(net)) / Math.sqrt(20)) *
          consensusFactor(up, down) *
          Math.sign(net)
      );
    };
    for (const [up, down] of [
      [10, 0],
      [0, 10],
      [5, 0],
      [3, 3],
      [12, 7],
      [0, 15],
    ] as const) {
      expect(communityLevelFromTally(up, down)).toBeCloseTo(
        oldLevel(up, down),
        5,
      );
    }
  });

  it("超额净票进入 0 以下缓冲带（log 曲线，无上限）", () => {
    // 超额 200 → 4·ln(1+200/200) = 4·ln2 ≈ 2.77
    expect(communityLevelFromTally(0, 220)).toBeCloseTo(-2.7726, 3);
    // 超额 800 → 4·ln(1+800/200) = 4·ln5 ≈ 6.44
    expect(communityLevelFromTally(0, 820)).toBeCloseTo(-6.4378, 3);
    // 缓冲无饱和：票越多负得越多（边际递减但不清零）
    expect(communityLevelFromTally(0, 5000)).toBeLessThan(
      communityLevelFromTally(0, 1000),
    );
  });

  it("超额净票进入 30 以上缓冲带（与下方对称）", () => {
    expect(communityLevelFromTally(220, 0)).toBeCloseTo(32.7726, 3);
    expect(communityLevelFromTally(820, 0)).toBeCloseTo(36.4378, 3);
  });

  it("缓冲带同样受共识度打折：一边倒才深，争议大时浅", () => {
    // 净票 -100、up 500/down 600：共识度 ≈0.1136 → 缓冲只加约 0.15
    const disputed = communityLevelFromTally(500, 600);
    expect(disputed).toBeGreaterThan(13);
    expect(disputed).toBeLessThan(13.5);
    // 同样的净票但一边倒（0/100）：共识度 1 → 缓冲约 4·ln(1+80/200) ≈ 1.35
    const lopsided = communityLevelFromTally(0, 100);
    expect(lopsided).toBeLessThan(-1.3);
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

  it("满级后顺风票进入缓冲带：影响不为零但很小", () => {
    // (21,0) 超额 1 票 → 缓冲 ≈ 4·ln(1+1/200) ≈ 0.02
    const impact = singleVoteImpact(20, 0);
    expect(impact).toBeGreaterThan(0);
    expect(impact).toBeLessThan(0.1);
  });

  it("等级关于上下对称（浮点精度内）", () => {
    expect(singleVoteImpact(0, 20)).toBeCloseTo(singleVoteImpact(20, 0), 10);
  });

  it("缓冲带深处每票影响力递减（不归零）", () => {
    // 深处再投一票的边际影响小于浅处
    expect(singleVoteImpact(0, 500)).toBeLessThan(singleVoteImpact(0, 100));
  });
});

describe("voteWeight", () => {
  it("age 为 0 时权重为 1", () => {
    expect(voteWeight(0, halfLifeMsFromHours(DEFAULT_HALF_LIFE_HOURS))).toBe(1);
  });

  it("一个半衰期后权重约 0.5", () => {
    expect(
      voteWeight(
        halfLifeMsFromHours(DEFAULT_HALF_LIFE_HOURS),
        halfLifeMsFromHours(DEFAULT_HALF_LIFE_HOURS),
      ),
    ).toBeCloseTo(0.5, 5);
  });
});

describe("levelSeries", () => {
  const halfLifeMs = halfLifeMsFromHours(DEFAULT_HALF_LIFE_HOURS);

  it("空事件流返回空序列", () => {
    expect(levelSeries([], halfLifeMs)).toEqual([]);
  });

  it("全赞成票累积，等级单调上升（无死区，首票即有效果）", () => {
    const now = Date.now();
    const events = [0, 1, 2, 3, 4].map((i) => ({
      t: now + i * 1000,
      d: "up" as const,
    }));
    const series = levelSeries(events, halfLifeMs);
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

describe("tallyFromEvents", () => {
  const now = Date.now();

  it("空事件流返回 15 级", () => {
    const t = tallyFromEvents([], halfLifeMsFromHours(DEFAULT_HALF_LIFE_HOURS), now);
    expect(t.level).toBe(15);
    expect(t.up).toBe(0);
    expect(t.down).toBe(0);
  });

  it("半衰期越短，旧票淡化越快、等级越低", () => {
    const events = [
      { t: now - 24 * 3600 * 1000, d: "up" as const }, // 24 小时前的 up 票
    ];
    const long = tallyFromEvents(events, halfLifeMsFromHours(120), now);
    const short = tallyFromEvents(events, halfLifeMsFromHours(24), now);
    // 120h 半衰期下，24h 旧票权重 ≈0.87；24h 半衰期下权重 ≈0.5，等级更低
    expect(long.level).toBeGreaterThan(short.level);
  });

  it("返回原始票数与加权票数", () => {
    const events = [
      { t: now, d: "up" as const },
      { t: now, d: "up" as const },
      { t: now, d: "down" as const },
    ];
    const t = tallyFromEvents(events, halfLifeMsFromHours(120), now);
    expect(t.up).toBe(2);
    expect(t.down).toBe(1);
    expect(t.weightedUp).toBeCloseTo(2, 5);
    expect(t.weightedDown).toBeCloseTo(1, 5);
  });
});
