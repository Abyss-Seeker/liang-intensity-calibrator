import "./styles.css";

import { type AppController, mountApp } from "./app";
import {
  createEvolutionVideoRenderer,
  type EvolutionVideoRenderer,
  VideoLoadTimeoutError,
} from "./video-renderer";
import { DEFAULT_HALF_LIFE_HOURS } from "./progression";
import {
  castVote,
  fetchVotes,
  type VoteDirection,
  type VoteEvent,
  type VoteTally,
  VoteServiceUnavailableError,
} from "./vote";
import { resolveDisplayTally } from "./vote-display";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("找不到应用挂载节点");
}

const HALF_LIFE_STORAGE_KEY = "liang-half-life-hours";
const MIN_HALF_LIFE_HOURS = 1;
const MAX_HALF_LIFE_HOURS = 8760;

// 半衰期仅存用户浏览器本地（localStorage），不全局共享。
function loadLocalHalfLife(): number {
  try {
    const raw = Number(localStorage.getItem(HALF_LIFE_STORAGE_KEY));
    if (
      Number.isFinite(raw) &&
      raw >= MIN_HALF_LIFE_HOURS &&
      raw <= MAX_HALF_LIFE_HOURS
    ) {
      return raw;
    }
  } catch {
    // localStorage 不可用（隐私模式）时回退默认
  }
  return DEFAULT_HALF_LIFE_HOURS;
}

function saveLocalHalfLife(hours: number): void {
  try {
    localStorage.setItem(HALF_LIFE_STORAGE_KEY, String(hours));
  } catch {
    // 忽略存储失败，仅本次会话生效
  }
}

let controller: AppController | null = null;
let renderer: EvolutionVideoRenderer | null = null;
let communityLevel = 15;
let animFrame = 0;
let userAdjustedLevel = false;
let localHalfLifeHours = loadLocalHalfLife();
let currentEvents: VoteEvent[] = [];
let currentTally: VoteTally | null = null;
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

// 用本地半衰期重算等级 + 更新 UI（社区评分/单票影响力/走势图），
// 让半衰期只影响本机显示，不依赖后端全局值。
const recalcLocalTally = (): void => {
  if (!currentTally) return;
  const tally = resolveDisplayTally(
    currentTally,
    localHalfLifeHours,
    Date.now(),
  );
  communityLevel = tally.level;
  controller?.setVotes(
    tally.up,
    tally.down,
    tally.level,
    tally.weightedUp,
    tally.weightedDown,
  );
  controller?.setEvents(currentEvents);
  controller?.setHalfLife(localHalfLifeHours);
  if (tally.approximate) {
    controller?.setHalfLifeStatus(
      `公开历史已截断，半衰期 ${localHalfLifeHours} 小时的加权结果为近似值`,
      true,
    );
  }
};

const applyTally = (tally: VoteTally): void => {
  currentTally = tally;
  currentEvents = tally.events;
  controller?.setGaps(tally.gaps ?? []);
  recalcLocalTally();
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
      controller.setLevel(communityLevel);
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
controller.setHalfLife(localHalfLifeHours);
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
      animateToLevel(communityLevel);
      controller?.setVoteState(
        "voted",
        `已投票（${result.votedDirection === "up" ? "往上" : "往下"}）`,
      );
    }
  } catch (error) {
    if (error instanceof VoteServiceUnavailableError) {
      controller?.setVoteState("error", "投票服务暂不可用");
      controller?.showServiceBanner(error.message);
    } else {
      controller?.setVoteState(
        "error",
        error instanceof Error ? error.message : "投票失败，请重试",
      );
    }
  }
});

controller.onShowCommunity(() => {
  animateToLevel(communityLevel);
});

controller.onSaveHalfLife((hours: number) => {
  localHalfLifeHours = hours;
  saveLocalHalfLife(hours);
  controller?.setHalfLife(hours);
  controller?.setHalfLifeStatus(`已保存（仅本机生效），半衰期 ${hours} 小时`);
  recalcLocalTally();
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
