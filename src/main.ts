import "./styles.css";

import { type AppController, mountApp } from "./app";
import {
  createEvolutionVideoRenderer,
  type EvolutionVideoRenderer,
} from "./video-renderer";
import {
  castVote,
  fetchVotes,
  type VoteDirection,
  type VoteEvent,
} from "./vote";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("找不到应用挂载节点");
}

let controller: AppController | null = null;
let renderer: EvolutionVideoRenderer | null = null;
let communityLevel = 15;
let animFrame = 0;

const requestDraw = (level: number): void => {
  renderer?.render(level);
};

const applyTally = (
  up: number,
  down: number,
  net: number,
  level: number,
  events: VoteEvent[],
): void => {
  communityLevel = level;
  controller?.setVotes(up, down, net);
  controller?.setEvents(events);
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
    requestDraw(level);
    if (t < 1) {
      animFrame = requestAnimationFrame(step);
    }
  };
  animFrame = requestAnimationFrame(step);
};

const syncVotes = async (): Promise<void> => {
  try {
    const tally = await fetchVotes();
    applyTally(tally.up, tally.down, tally.net, tally.level, tally.events);
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
renderer = createEvolutionVideoRenderer(controller.canvas);
controller.setLoading(0, 1);

controller.onVote(async (direction: VoteDirection) => {
  controller?.setVoteState("voting");
  try {
    const result = await castVote(direction);
    applyTally(result.up, result.down, result.net, result.level, result.events);
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

// 视频加载 与 社区票数请求 并行，缩短首屏时间（原先串行：等视频 loadeddata 后才请求票数）。
const videoReady = renderer.load();
const votesReady = syncVotes();

Promise.all([videoReady, votesReady])
  .then(() => {
    // 两者都就绪后，渲染社区等级对应的帧；等目标帧真正画出来再撤掉加载层，
    // 避免出现"分数/样式都到位但图片卡在第一帧"的情况。
    controller?.setLevel(communityLevel);
    renderer?.render(communityLevel, () => {
      controller?.setReady();
    });
  })
  .catch(() => {
    controller?.setError("图像加载失败，请刷新重试");
  });

if (isInAppBrowser()) {
  showInAppBrowserHint();
}

window.addEventListener("resize", () => {
  renderer?.redraw();
});
