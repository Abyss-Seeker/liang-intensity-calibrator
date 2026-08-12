import "./styles.css";

import { type AppController, mountApp } from "./app";
import { communityLevelFromTally } from "./progression";
import {
  createEvolutionVideoRenderer,
  type EvolutionVideoRenderer,
} from "./video-renderer";
import { castVote, fetchVotes, type VoteDirection } from "./vote";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("找不到应用挂载节点");
}

let controller: AppController | null = null;
let renderer: EvolutionVideoRenderer | null = null;

const requestDraw = (level: number): void => {
  renderer?.render(level);
};

const applyTally = (up: number, down: number): void => {
  const level = communityLevelFromTally(up, down);
  controller?.setVotes(up, down);
  controller?.setLevel(level);
  requestDraw(level);
};

const syncVotes = async (): Promise<void> => {
  try {
    const tally = await fetchVotes();
    applyTally(tally.up, tally.down);
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
    applyTally(result.up, result.down);
    controller?.setVoteState(
      "voted",
      result.voted === false
        ? (result.reason ?? "这个 IP 已经投过票了")
        : "投票成功",
    );
  } catch {
    controller?.setVoteState("error", "投票失败，请重试");
  }
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
