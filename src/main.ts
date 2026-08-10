import "./styles.css";

import { type AppController, mountApp } from "./app";
import { drawPortrait, preloadPortraits } from "./portrait-renderer";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("找不到应用挂载节点");
}

let controller: AppController | null = null;
let portraits: HTMLImageElement[] | null = null;
let pendingFrame = 0;

const requestDraw = (level: number): void => {
  if (!controller || !portraits) {
    return;
  }

  cancelAnimationFrame(pendingFrame);
  pendingFrame = requestAnimationFrame(() => {
    drawPortrait(controller!.canvas, portraits!, level);
  });
};

controller = mountApp(app, requestDraw);

preloadPortraits((loaded, total) => {
  controller?.setLoading(loaded, total);
})
  .then((loadedPortraits) => {
    portraits = loadedPortraits;
    controller?.setReady();
    requestDraw(controller?.level ?? 0);
  })
  .catch(() => {
    controller?.setError("图像加载失败，请刷新重试");
  });

window.addEventListener("resize", () => {
  requestDraw(controller?.level ?? 0);
});
