import "./styles.css";

import { type AppController, mountApp } from "./app";
import { communityLevelFromTally } from "./progression";
import {
  createEvolutionVideoRenderer,
  type EvolutionVideoRenderer,
} from "./video-renderer";
import {
  castVote,
  fetchVotes,
  type HistoryEntry,
  type VoteDirection,
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

const applyTally = (up: number, down: number, history: HistoryEntry[]): void => {
  communityLevel = communityLevelFromTally(up, down);
  controller?.setVotes(up, down);
  controller?.setHistory(history);
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
    applyTally(tally.up, tally.down, tally.history);
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
    applyTally(result.up, result.down, result.history);
    controller?.setVoteState(
      "voted",
      result.voted === false
        ? (result.reason ?? "今天已经投过票了")
        : "投票成功",
    );
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
    controller?.setReady();
    requestDraw(controller?.level ?? 0);
    void syncVotes();
  })
  .catch(() => {
    controller?.setError("图像加载失败，请刷新重试");
  });

window.addEventListener("resize", () => {
  renderer?.redraw();
});
