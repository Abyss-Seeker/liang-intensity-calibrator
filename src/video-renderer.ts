import { clampPosition, MAX_LEVEL } from "./progression";

const VIDEO_FPS = 30;
const INTERPOLATION_FACTOR = 8;
// seek 超时兜底：移动端慢网络下，seek 到未缓冲区域可能长时间不触发
// seeked 事件（video.seeking 一直为 true），导致画面卡死在第一帧。
const SEEK_TIMEOUT_MS = 2500;

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

  const webmSource = document.createElement("source");
  webmSource.src = videoAssetPath("liang-evolution.webm");
  webmSource.type = 'video/webm; codecs="vp9"';

  const mp4Source = document.createElement("source");
  mp4Source.src = videoAssetPath("liang-evolution.mp4");
  mp4Source.type = 'video/mp4; codecs="avc1.64001f"';

  video.append(webmSource, mp4Source);
  canvas.after(video);

  let requestedTime = 0;
  let renderedCallbacks: (() => void)[] = [];
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  // 是否已降级为 blob 完整加载（首次 seek 卡死时触发）
  let blobLoaded = false;

  const flushRendered = (): void => {
    if (renderedCallbacks.length === 0) return;
    const cbs = renderedCallbacks;
    renderedCallbacks = [];
    for (const cb of cbs) cb();
  };

  const drawNow = (): void => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    resizeCanvasToDisplaySize(canvas);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("当前浏览器不支持 Canvas 2D");
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  };

  const drawDecodedFrame = (): void => {
    drawNow();
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => drawNow());
    }
  };

  // 完整下载视频到 blob 后重新加载。移动端（iOS Safari / 微信内置浏览器）
  // 对未缓冲区域的 seek 可能卡死，blob 完整加载后 seek 到任意帧都秒完成，
  // 彻底规避"卡在第一帧"。
  const reloadFromBlob = (target: number): void => {
    fetch(videoAssetPath("liang-evolution.mp4"))
      .then((r) => r.blob())
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        video.src = objectUrl;
        video.load();
        return new Promise<void>((resolve, reject) => {
          video.addEventListener(
            "loadeddata",
            () => resolve(),
            { once: true },
          );
          video.addEventListener("error", () => reject(new Error("blob 加载失败")), {
            once: true,
          });
        });
      })
      .then(() => {
        try {
          video.currentTime = target;
        } catch {
          /* ignore */
        }
        drawNow();
        // seeked 事件会 flush；这里也兜底一次，确保不卡 loading
        flushRendered();
      })
      .catch(() => {
        drawNow();
        flushRendered();
      });
  };

  const scheduleSeekTimeout = (target: number): void => {
    if (seekTimer) clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      // seek 超时：说明 target 帧的数据还没就绪，移动端可能一直卡 seeking。
      if (!blobLoaded) {
        blobLoaded = true;
        reloadFromBlob(target);
      } else {
        // 已经 blob 加载过还超时，画当前帧放行，避免永久卡在 loading
        drawNow();
        flushRendered();
      }
    }, SEEK_TIMEOUT_MS);
  };

  const seekToRequestedTime = (): void => {
    if (!Number.isFinite(requestedTime) || video.readyState < 1) {
      return;
    }

    const lastFrameTime = Math.max(0, video.duration - 1 / VIDEO_FPS);
    const target = Math.min(requestedTime, lastFrameTime);
    if (Math.abs(video.currentTime - target) < 0.001) {
      drawNow();
      flushRendered();
      return;
    }
    if (video.seeking) {
      // 正在 seek：只记目标，等 seeked 后追；设超时兜底
      scheduleSeekTimeout(target);
      return;
    }
    video.currentTime = target;
    scheduleSeekTimeout(target);
  };

  video.addEventListener("seeked", () => {
    if (seekTimer) clearTimeout(seekTimer);
    drawDecodedFrame();
    flushRendered();
    seekToRequestedTime();
  });

  const render = (position: number, onRendered?: () => void): void => {
    const clampedPosition = clampPosition(position);
    requestedTime = positionToVideoTime(clampedPosition, video.duration || 0);
    canvas.dataset.frame = String(
      Math.round(clampedPosition * INTERPOLATION_FACTOR),
    ).padStart(3, "0");
    if (onRendered) renderedCallbacks.push(onRendered);
    seekToRequestedTime();
  };

  return {
    video,
    load() {
      return new Promise((resolve, reject) => {
        const handleReady = (): void => {
          drawNow();
          resolve();
        };
        const handleError = (): void => {
          reject(new Error("连续人像视频加载失败"));
        };

        video.addEventListener("loadeddata", handleReady, { once: true });
        video.addEventListener("error", handleError, { once: true });
        video.load();
      });
    },
    render,
    redraw: drawNow,
  };
}
