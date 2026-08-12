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
let isFirstSync = true;
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
    // 进入页面第一时间根据后端返回的 voted 状态设置提示文字
    if (tally.voted) {
      controller?.setVoteState(
        "voted",
        `已投票（${tally.votedDirection === "up" ? "往上" : "往下"}）`,
      );
    } else {
      controller?.setVoteState("idle", "未投票");
    }
    if (isFirstSync) {
      isFirstSync = false;
      controller?.setLevel(communityLevel);
      requestDraw(communityLevel);
    }
  } catch {
    controller?.setVoteState("error", "社区票数加载失败");
  }
};

controller = mountApp(app, requestDraw);
renderer = createEvolutionVideoRenderer(controller.canvas);
controller.setLoading(0, 1);

controller.onVote(async (direction: VoteDirection) => {
  controller?.setVoteState("voting");
  try {
    const result = await castVote(direction);
    applyTally(result.up, result.down, result.net, result.level, result.events);
    if (result.reason) {
      // 重复投票：保持已投票状态，不抢滑杆
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

renderer
  .load()
  .then(() => {
    // 视频加载完成后再读社区票数，两者都就绪才隐藏加载层，
    // 避免首屏卡在小难梁第一帧。
    void syncVotes().finally(() => {
      controller?.setReady();
    });
  })
  .catch(() => {
    controller?.setError("图像加载失败，请刷新重试");
  });

window.addEventListener("resize", () => {
  renderer?.redraw();
});
