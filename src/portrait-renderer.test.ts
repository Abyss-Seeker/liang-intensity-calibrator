import { describe, expect, it } from "vitest";

import { getRenderFrame, PORTRAIT_PATHS } from "./portrait-renderer";

describe("portrait renderer state", () => {
  it("为六个主形态提供固定图片路径", () => {
    expect(PORTRAIT_PATHS).toHaveLength(6);
    expect(PORTRAIT_PATHS[0]).toContain("00-laoliang");
    expect(PORTRAIT_PATHS[5]).toContain("05-liangzu");
  });

  it("从牢梁图片开始绘制", () => {
    expect(getRenderFrame(0)).toEqual({
      fromIndex: 0,
      toIndex: 1,
      mix: 0,
    });
  });

  it("在 9 级绘制小梁和梁子的等量混合", () => {
    expect(getRenderFrame(9)).toEqual({
      fromIndex: 1,
      toIndex: 2,
      mix: 0.5,
    });
  });

  it("在 30 级只绘制梁祖", () => {
    expect(getRenderFrame(30)).toEqual({
      fromIndex: 5,
      toIndex: 5,
      mix: 0,
    });
  });
});
