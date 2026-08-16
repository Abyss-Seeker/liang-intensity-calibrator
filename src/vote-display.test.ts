import { describe, expect, it } from "vitest";
import type { VoteTally } from "./vote";
import { resolveDisplayTally } from "./vote-display";

function tally(overrides: Partial<VoteTally> = {}): VoteTally {
  return {
    up: 2_000,
    down: 500,
    net: 12,
    level: 24,
    weightedUp: 14,
    weightedDown: 2,
    events: [{ t: 1_000, d: "up" }],
    eventsTruncated: true,
    voted: false,
    votedDirection: null,
    ...overrides,
  };
}

describe("resolveDisplayTally", () => {
  it("默认半衰期采用服务端完整聚合，不被截断事件覆盖", () => {
    expect(resolveDisplayTally(tally(), 18, 1_000)).toEqual({
      up: 2_000,
      down: 500,
      weightedUp: 14,
      weightedDown: 2,
      level: 24,
      approximate: false,
    });
  });

  it("自定义半衰期保留服务端原始总票数，并标记截断计算为近似", () => {
    const result = resolveDisplayTally(tally(), 36, 1_000);
    expect(result.up).toBe(2_000);
    expect(result.down).toBe(500);
    expect(result.approximate).toBe(true);
  });
});
