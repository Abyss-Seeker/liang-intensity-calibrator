import { clampPosition, MAX_LEVEL } from "./progression";

const VIDEO_FPS = 30;
const INTERPOLATION_FACTOR = 8;
const LOAD_TIMEOUT_MS = 20_000; // blob 下载 + 媒体就绪总超时
const DURATION_READY_TIMEOUT_MS = 5_000; // duration 解析超时
const SEEK_TIMEOUT_MS = 3_000; // seek 确认超时（超时则用当前帧兜底）
const RVFC_FALLBACK_MS = 100; // rVFC 未触发时的 rAF 兜底延迟
const SEEK_RETRY = 2; // seek 不到位时的重试次数

export class VideoLoadTimeoutError extends Error {
  constructor() {
    super("连续人像视频加载超时");
    this.name = "VideoLoadTimeoutError";
  }
}

export interface EvolutionVideoRenderer {
  readonly video: HTMLVideoElement;
  load(): Promise<void>;
  render(position: number, onRendered?: () => void): void;
  redraw(): void;
}

export function positionToVideoTime(position: number, duration: number): number {
  return (clampPosition(position) / MAX_LEVEL) * duration;
}

function videoAssetPath(filename: string): string {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}video/${filename}`;
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

/**
 * 主渲染层：全量 blob 视频（fetch 完整 mp4 → object URL），冷启动也不依赖
 * HTTP 缓存，seek 数据必然完整。seek 完成后显式确认 currentTime 到位，
 * 画帧用 rVFC，rVFC 不触发时 rAF 兜底——把「卡第一帧」变成不可能事件。
 */
export function createEvolutionVideoRenderer(
  canvas: HTMLCanvasElement,
): EvolutionVideoRenderer {
  const video = document.createElement("video");
  video.className = "evolution-video";
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.tabIndex = -1;
  video.setAttribute("aria-hidden", "true");
  canvas.after(video);

  let requestedPosition = 0;
  let requestVersion = 0;
  let loaded = false;
  let loadPromise: Promise<void> | undefined;
  let objectUrl: string | undefined;
  let renderedCallbacks: Array<() => void> = [];
  let seekRetries = 0;

  const drawNow = (): boolean => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    resizeCanvasToDisplaySize(canvas);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器不支持 Canvas 2D");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return true;
  };

  const targetTime = (): number => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    return Math.min(
      positionToVideoTime(requestedPosition, duration),
      Math.max(0, duration - 1 / VIDEO_FPS),
    );
  };

  // 画最新请求对应的帧。rVFC 存在但不回调的环境（部分 WebView），
  // 用短超时回退到 rAF，保证帧一定能画出来。
  const finishLatestFrame = (version: number): void => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (version !== requestVersion) return;
      drawNow();
      const callbacks = renderedCallbacks;
      renderedCallbacks = [];
      callbacks.forEach((callback) => callback());
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(finish);
      window.setTimeout(() => {
        if (done || version !== requestVersion) return;
        requestAnimationFrame(finish);
      }, RVFC_FALLBACK_MS);
    } else {
      requestAnimationFrame(finish);
    }
  };

  const seekTo = (target: number): void => {
    const version = requestVersion;
    if (Math.abs(video.currentTime - target) < 0.001 && !video.seeking) {
      finishLatestFrame(version);
      return;
    }

    const onSeeked = (): void => {
      video.removeEventListener("seeked", onSeeked);
      if (version !== requestVersion) return;
      if (Math.abs(video.currentTime - target) >= 0.001 && seekRetries < SEEK_RETRY) {
        seekRetries += 1;
        seekTo(target);
        return;
      }
      seekRetries = 0;
      finishLatestFrame(version);
    };
    video.addEventListener("seeked", onSeeked);

    try {
      video.currentTime = target;
    } catch {
      video.removeEventListener("seeked", onSeeked);
      finishLatestFrame(version);
      return;
    }

    // seek 确认超时兜底：seeked 迟迟不来就画当前帧（至少有一张脸）
    window.setTimeout(() => {
      if (version !== requestVersion) return;
      video.removeEventListener("seeked", onSeeked);
      finishLatestFrame(version);
    }, SEEK_TIMEOUT_MS);
  };

  const seekLatest = (): void => {
    if (!loaded) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    seekTo(targetTime());
  };

  const render = (position: number, onRendered?: () => void): void => {
    requestedPosition = clampPosition(position);
    requestVersion += 1;
    canvas.dataset.frame = String(
      Math.round(requestedPosition * INTERPOLATION_FACTOR),
    ).padStart(3, "0");
    if (onRendered) renderedCallbacks.push(onRendered);
    if (!loaded) return; // 加载完成（loaded=true）时会立即 seek 一次
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      video.addEventListener("durationchange", seekLatest, { once: true });
      return;
    }
    seekLatest();
  };

  // 等 duration 有效。faststart mp4 通常在 loadedmetadata 时已就绪，
  // 个别容器可能延迟到 durationchange，这里显式等有效值，杜绝
  // 「loadeddata 已到但 duration 还是 NaN」导致的静默放弃。
  const waitForDuration = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const ready = (): boolean =>
        Number.isFinite(video.duration) && video.duration > 0;
      if (ready()) {
        resolve();
        return;
      }
      const timer = window.setTimeout(
        () => reject(new VideoLoadTimeoutError()),
        DURATION_READY_TIMEOUT_MS,
      );
      const cleanup = (): void => window.clearTimeout(timer);
      const onReady = (): void => {
        if (!ready()) return;
        cleanup();
        video.removeEventListener("durationchange", onReady);
        video.removeEventListener("loadedmetadata", onReady);
        resolve();
      };
      video.addEventListener("durationchange", onReady);
      video.addEventListener("loadedmetadata", onReady);
    });

  const waitForMedia = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new VideoLoadTimeoutError()),
        LOAD_TIMEOUT_MS,
      );
      const cleanup = (): void => window.clearTimeout(timeout);
      video.addEventListener(
        "loadeddata",
        () => {
          cleanup();
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        "error",
        () => {
          cleanup();
          reject(new Error("连续人像视频加载失败"));
        },
        { once: true },
      );
      video.load();
    });

  return {
    video,
    load() {
      if (loadPromise) return loadPromise;
      loadPromise = (async () => {
        let response: Response | null = null;
        for (let attempt = 0; attempt < 2 && !response?.ok; attempt += 1) {
          response = await fetch(videoAssetPath("liang-evolution.mp4"));
        }
        if (!response || !response.ok) {
          throw new Error(
            `连续人像视频加载失败 (${response?.status ?? "network"})`,
          );
        }
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        video.src = objectUrl;
        await waitForMedia();
        await waitForDuration();
        loaded = true;
        seekLatest();
      })();
      return loadPromise;
    },
    render,
    redraw: () => {
      drawNow();
    },
  };
}
