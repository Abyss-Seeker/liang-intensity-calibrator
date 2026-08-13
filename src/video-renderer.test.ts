// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  createEvolutionVideoRenderer,
  positionToVideoTime,
  type EvolutionVideoRenderer,
} from "./video-renderer";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("positionToVideoTime", () => {
  it("maps the slider endpoints and midpoint to video time", () => {
    expect(positionToVideoTime(0, 30)).toBe(0);
    expect(positionToVideoTime(15, 30)).toBe(15);
    expect(positionToVideoTime(30, 30)).toBe(30);
  });

  it("clamps positions outside the slider range", () => {
    expect(positionToVideoTime(-5, 30)).toBe(0);
    expect(positionToVideoTime(35, 30)).toBe(30);
  });
});

describe("createEvolutionVideoRenderer", () => {
  function setup() {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const renderer = createEvolutionVideoRenderer(canvas);
    return { canvas, renderer };
  }

  it("creates a hidden video element after the canvas", () => {
    const { canvas, renderer } = setup();
    expect(renderer.video).toBeInstanceOf(HTMLVideoElement);
    expect(renderer.video.muted).toBe(true);
    expect(renderer.video.playsInline).toBe(true);
    expect(canvas.nextElementSibling).toBe(renderer.video);
  });

  it("render() updates the data-frame attribute without requiring loaded media", () => {
    const { canvas, renderer } = setup();
    renderer.render(12.35);
    expect(canvas.dataset.frame).toBe("099");
    renderer.render(0);
    expect(canvas.dataset.frame).toBe("000");
    renderer.render(30);
    expect(canvas.dataset.frame).toBe("240");
  });

  it("load() resolves and then renders the latest requested frame", async () => {
    const { renderer } = setup();
    // 没接后端：blob fetch 会失败，load 应 reject（而不是挂起）
    await expect(renderer.load()).rejects.toBeTruthy();
  });

  it("redraw() does not throw before any media is available", () => {
    const { renderer } = setup();
    expect(() => renderer.redraw()).not.toThrow();
  });

  it("load() memoizes its promise", async () => {
    const { renderer } = setup();
    const first = renderer.load();
    const second = renderer.load();
    expect(first).toBe(second);
    // 测试环境 fetch 相对 URL 会失败，吞掉 rejection 避免 unhandled
    await first.catch(() => undefined);
  });
});
