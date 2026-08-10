import { getProgression } from "./progression";

export const PORTRAIT_PATHS = [
  "/portraits/00-laoliang.png",
  "/portraits/01-xiaoliang.png",
  "/portraits/02-liangzi.png",
  "/portraits/03-liangsheng.png",
  "/portraits/04-liangshen.png",
  "/portraits/05-liangzu.png",
] as const;

export interface RenderFrame {
  fromIndex: number;
  toIndex: number;
  mix: number;
}

export function getRenderFrame(level: number): RenderFrame {
  const state = getProgression(level);
  const progress = state.localProgress;
  const mix = progress * progress * (3 - 2 * progress);

  return {
    fromIndex: state.fromIndex,
    toIndex: state.toIndex,
    mix,
  };
}

export async function preloadPortraits(
  onProgress?: (loaded: number, total: number) => void,
): Promise<HTMLImageElement[]> {
  let loaded = 0;

  return Promise.all(
    PORTRAIT_PATHS.map(async (path) => {
      const image = new Image();
      image.src = path;
      await image.decode();
      loaded += 1;
      onProgress?.(loaded, PORTRAIT_PATHS.length);
      return image;
    }),
  );
}

export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);

  if (canvas.width === width && canvas.height === height) {
    return false;
  }

  canvas.width = width;
  canvas.height = height;
  return true;
}

export function drawPortrait(
  canvas: HTMLCanvasElement,
  images: readonly HTMLImageElement[],
  level: number,
): void {
  if (images.length !== PORTRAIT_PATHS.length) {
    throw new Error("人物图片数量不完整");
  }

  resizeCanvasToDisplaySize(canvas);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器不支持 Canvas 2D");
  }

  const { fromIndex, toIndex, mix } = getRenderFrame(level);
  const strength = getProgression(level).strength;
  const scale = 0.98 + strength * 0.06;
  const width = canvas.width * scale;
  const height = canvas.height * scale;
  const x = (canvas.width - width) / 2;
  const y = (canvas.height - height) / 2 - canvas.height * strength * 0.008;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  context.globalAlpha = 1;
  context.drawImage(images[fromIndex], x, y, width, height);

  if (toIndex !== fromIndex && mix > 0) {
    context.globalAlpha = mix;
    context.drawImage(images[toIndex], x, y, width, height);
  }

  context.globalAlpha = 1;
}
