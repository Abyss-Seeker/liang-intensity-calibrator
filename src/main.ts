import "./styles.css";

import { type AppController, mountApp } from "./app";
import {
  createEvolutionVideoRenderer,
  type EvolutionVideoRenderer,
  VideoLoadTimeoutError,
} from "./video-renderer";
import {
  castVote,
  fetchVotes,
  type VoteDirection,
  type VoteTally,
} from "./vote";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("找不到应用挂载节点");
}

let controller: AppController | null = null;
let renderer: EvolutionVideoRenderer | null = null;
let communityLevel = 15;
let animFrame = 0;
let userAdjustedLevel = false;
const FRAME_TIMEOUT_RELOAD_KEY = "liang-frame-timeout-reloaded";

const recoverFromFrameError = (error: unknown): void => {
  let alreadyReloaded = true;
  try {
    alreadyReloaded = sessionStorage.getItem(FRAME_TIMEOUT_RELOAD_KEY) === "1";
  } catch {
    // Storage can be unavailable in privacy-restricted WebViews. Avoid a
    // reload loop when the guard cannot be persisted.
  }

  if (error instanceof VideoLoadTimeoutError && !alreadyReloaded) {
    try {
      sessionStorage.setItem(FRAME_TIMEOUT_RELOAD_KEY, "1");
    } catch {
      return controller?.setError("图像加载超时，请刷新重试");
    }
    window.location.reload();
    return;
  }
  controller?.setError("图像加载失败，请刷新重试");
};

const requestDraw = (level: number): void => {
  renderer?.render(level);
};

const applyTally = (tally: VoteTally): void => {
  communityLevel = tally.level;
  controller?.setVotes(
    tally.up,
    tally.down,
    tally.level,
    tally.weightedUp,
    tally.weightedDown,
  );
  controller?.setEvents(tally.events);
};

const animateToLevel = (target: number): void => {
  if (!controller) return;
  cancelAnimationFrame(animFrame);
  const start = controller.level;
  const startTime = performance.now();
  const duration = 700;
  const step = (now: number): void => {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const level = start + (target - start) * eased;
    controller?.setLevel(level);
    if (t < 1) {
      animFrame = requestAnimationFrame(step);
    }
  };
  animFrame = requestAnimationFrame(step);
};

const syncVotes = async (): Promise<void> => {
  try {
    const tally = await fetchVotes();
    applyTally(tally);
    if (!userAdjustedLevel && controller && !controller.slider.disabled) {
      controller.setLevel(tally.level);
    }
    if (tally.voted) {
      controller?.setVoteState(
        "voted",
        `已投票（${tally.votedDirection === "up" ? "往上" : "往下"}）`,
      );
    } else {
      controller?.setVoteState("idle", "未投票");
    }
  } catch {
    controller?.setVoteState("error", "社区票数加载失败");
  }
};

// 检测是否在内置浏览器（微信/QQ/支付宝/微博等 WebView）
function isInAppBrowser(): boolean {
  const ua = navigator.userAgent || "";
  return /MicroMessenger/i.test(ua) || /WeiBo/i.test(ua) || /QQ\//i.test(ua) || /AlipayClient/i.test(ua);
}

function showInAppBrowserHint(): void {
  const hint = document.createElement("div");
  hint.className = "app-browser-hint";
  hint.setAttribute("role", "status");
  hint.textContent = "内置浏览器加载较慢，建议点右上角「···」→ 在默认浏览器中打开";
  document.body.appendChild(hint);
  // 8 秒后自动淡出
  window.setTimeout(() => {
    hint.classList.add("is-fading");
    window.setTimeout(() => hint.remove(), 500);
  }, 8000);
}

controller = mountApp(app, requestDraw);
renderer = createEvolutionVideoRenderer(controller.portrait);
controller.setLevel(communityLevel);
controller.setLoading(0, 1);
controller.slider.addEventListener("input", () => {
  userAdjustedLevel = true;
});

controller.onVote(async (direction: VoteDirection) => {
  controller?.setVoteState("voting");
  try {
    const result = await castVote(direction);
    applyTally(result);
    if (result.reason) {
      controller?.setVoteState(
        "voted",
        `已投票（${result.votedDirection === "up" ? "往上" : "往下"}）`,
      );
    } else {
      animateToLevel(result.level);
      controller?.setVoteState(
        "voted",
        `已投票（${result.votedDirection === "up" ? "往上" : "往下"}）`,
      );
    }
  } catch {
    controller?.setVoteState("error", "投票失败，请重试");
  }
});

controller.onShowCommunity(() => {
  animateToLevel(communityLevel);
});

// The portrait is the primary interaction and must never wait for the community
// API. A slow or unavailable vote request only affects the vote panel.
const framesReady = renderer.load();
void syncVotes();

framesReady
  .then(() => {
    // A successful load ends the one-reload recovery window. A later genuine
    // timeout may therefore recover in the same way again.
    try {
      sessionStorage.removeItem(FRAME_TIMEOUT_RELOAD_KEY);
    } catch {
      // The app remains usable when session storage is unavailable.
    }
    // Render the best community level available at this moment. If the API is
    // still pending, the neutral level is used and the slider is enabled.
    controller?.setReady();
    controller?.setLevel(communityLevel);
  })
  .catch(recoverFromFrameError);

if (isInAppBrowser()) {
  showInAppBrowserHint();
}

window.addEventListener("resize", () => {
  renderer?.redraw();
});
