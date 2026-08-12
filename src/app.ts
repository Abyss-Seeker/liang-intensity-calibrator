import {
  clampPosition,
  communityLevelFromTally,
  getProgression,
  MAX_LEVEL,
  singleVoteImpact,
  STAGES,
} from "./progression";
import type { HistoryEntry, VoteDirection } from "./vote";

export interface AppController {
  readonly canvas: HTMLCanvasElement;
  readonly slider: HTMLInputElement;
  readonly level: number;
  setLevel(level: number): void;
  setLoading(loaded: number, total: number): void;
  setReady(): void;
  setError(message: string): void;
  setVotes(up: number, down: number): void;
  setVoteState(state: VoteState, message?: string): void;
  setHistory(history: HistoryEntry[]): void;
  onVote(handler: VoteHandler): void;
  onShowCommunity(handler: () => void): void;
}

export type LevelChangeHandler = (level: number) => void;
export type VoteState = "idle" | "voting" | "voted" | "error";
export type VoteHandler = (direction: VoteDirection) => void;

function createTicks(): string {
  return Array.from(
    { length: MAX_LEVEL + 1 },
    (_, level) => `<i class="tick" data-level="${level}" aria-hidden="true"></i>`,
  ).join("");
}

function createStageMarkers(): string {
  return STAGES.map(
    (stage, index) =>
      `<li class="stage-marker" data-level="${index * 6}" style="--marker-index: ${index}">${stage}</li>`,
  ).join("");
}

const CHART_WIDTH = 600;
const CHART_HEIGHT = 140;
const CHART_PAD = { left: 10, right: 10, top: 10, bottom: 10 };

function renderChart(svg: SVGSVGElement, history: HistoryEntry[]): void {
  const plotW = CHART_WIDTH - CHART_PAD.left - CHART_PAD.right;
  const plotH = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const parts: string[] = [];

  for (let stage = 0; stage <= 5; stage++) {
    const level = stage * 6;
    const y = CHART_PAD.top + plotH - (level / MAX_LEVEL) * plotH;
    parts.push(
      `<line x1="${CHART_PAD.left}" y1="${y.toFixed(1)}" x2="${
        CHART_WIDTH - CHART_PAD.right
      }" y2="${y.toFixed(1)}" class="chart-stage-line" data-stage="${stage}" />`,
    );
  }

  if (history.length > 0) {
    const tMin = history[0].t;
    const tMax = history[history.length - 1].t;
    const tRange = Math.max(1, tMax - tMin);
    const points = history.map((entry) => {
      const level = communityLevelFromTally(entry.up, entry.down);
      const x = CHART_PAD.left + ((entry.t - tMin) / tRange) * plotW;
      const y = CHART_PAD.top + plotH - (level / MAX_LEVEL) * plotH;
      return { x, y };
    });
    const polylinePoints = points
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    parts.push(`<polyline class="chart-line" points="${polylinePoints}" />`);

    const last = points[points.length - 1];
    parts.push(
      `<circle class="chart-dot" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.5" />`,
    );
  }

  svg.innerHTML = parts.join("");
}

export function mountApp(
  root: HTMLElement,
  onLevelChange: LevelChangeHandler = () => undefined,
): AppController {
  root.innerHTML = `
    <div class="experience" data-stage="0">
      <header class="masthead">
        <div>
          <p class="eyebrow">LIANG INTENSITY CALIBRATOR</p>
          <h1>滑动变祖器</h1>
        </div>
        <div class="level-meter" aria-live="polite">
          <span>梁系强度</span>
          <output class="level-output" for="strength-slider">00 / 30</output>
        </div>
      </header>

      <section class="portrait-zone" aria-labelledby="current-stage-label">
        <p class="stage-ghost" aria-hidden="true">小难梁</p>
        <div class="portrait-shell">
          <div class="imperial-halo" aria-hidden="true"></div>
          <canvas class="portrait-canvas" role="img" aria-label="当前形态：小难梁"></canvas>
          <div class="scan-grid" aria-hidden="true"></div>
          <span class="frame-corner frame-corner--tl" aria-hidden="true"></span>
          <span class="frame-corner frame-corner--tr" aria-hidden="true"></span>
          <span class="frame-corner frame-corner--bl" aria-hidden="true"></span>
          <span class="frame-corner frame-corner--br" aria-hidden="true"></span>
          <div class="load-state" role="status">载入连续祖力…</div>
        </div>

        <div class="stage-readout">
          <span id="current-stage-label">当前状态</span>
          <p class="stage-name" aria-live="polite">小难梁</p>
          <span class="stage-index">阶段 01 / 06</span>
        </div>
      </section>

      <section class="control-panel" aria-label="梁系强度控制">
        <div class="range-wrap">
          <div class="tick-track">${createTicks()}</div>
          <input
            id="strength-slider"
            class="strength-slider"
            type="range"
            min="0"
            max="30"
            step="0.01"
            value="0"
            aria-label="梁系强度"
            aria-valuetext="小难梁，0 级，共 30 级"
            disabled
          />
        </div>
        <ol class="stage-markers">${createStageMarkers()}</ol>
        <p class="drag-hint"><span aria-hidden="true">←</span> 拖动以增强梁系浓度 <span aria-hidden="true">→</span></p>
      </section>

      <section class="vote-panel" aria-label="社区梁系投票">
        <div class="vote-head">
          <span class="vote-title">社区梁系裁决</span>
          <span class="vote-state" role="status" data-state="idle">未投票</span>
        </div>

        <div class="vote-chart">
          <svg class="vote-chart-svg" viewBox="0 0 600 140" preserveAspectRatio="none" role="img" aria-label="评级历史走势"></svg>
        </div>

        <div class="vote-actions">
          <button class="vote-btn vote-btn--down" type="button" data-direction="down">
            <span class="vote-arrow" aria-hidden="true">▼</span>
            <span class="vote-label">往下</span>
            <span class="vote-count" data-count="down">0</span>
          </button>
          <button class="vote-btn vote-btn--up" type="button" data-direction="up">
            <span class="vote-arrow" aria-hidden="true">▲</span>
            <span class="vote-label">往上</span>
            <span class="vote-count" data-count="up">0</span>
          </button>
        </div>

        <div class="vote-meta">
          <p class="vote-community">
            社区评定：<strong class="vote-community-level">—</strong>
          </p>
          <p class="vote-impact">
            单票影响力 <strong class="vote-impact-value">—</strong>
          </p>
        </div>

        <button class="vote-show-community" type="button" data-action="show-community">
          查看社区评价
        </button>
      </section>

      <footer class="footer-note">
        <span>31 级连续进化</span>
        <span>正脸识别协议：已启用</span>
      </footer>
    </div>
  `;

  const experience = root.querySelector<HTMLElement>(".experience")!;
  const canvas = root.querySelector<HTMLCanvasElement>(".portrait-canvas")!;
  const slider = root.querySelector<HTMLInputElement>("#strength-slider")!;
  const output = root.querySelector<HTMLOutputElement>(".level-output")!;
  const stageName = root.querySelector<HTMLElement>(".stage-name")!;
  const stageGhost = root.querySelector<HTMLElement>(".stage-ghost")!;
  const stageIndex = root.querySelector<HTMLElement>(".stage-index")!;
  const loadState = root.querySelector<HTMLElement>(".load-state")!;
  const ticks = Array.from(root.querySelectorAll<HTMLElement>(".tick"));
  const markers = Array.from(root.querySelectorAll<HTMLElement>(".stage-marker"));

  const voteState = root.querySelector<HTMLElement>(".vote-state")!;
  const voteCommunityLevel = root.querySelector<HTMLElement>(
    ".vote-community-level",
  )!;
  const voteImpactValue = root.querySelector<HTMLElement>(".vote-impact-value")!;
  const chartSvg = root.querySelector<SVGSVGElement>(".vote-chart-svg")!;
  const upCount = root.querySelector<HTMLElement>('[data-count="up"]')!;
  const downCount = root.querySelector<HTMLElement>('[data-count="down"]')!;
  const voteButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".vote-btn"),
  );
  const showCommunityButton = root.querySelector<HTMLButtonElement>(
    '[data-action="show-community"]',
  )!;

  let currentPosition = 0;

  const setLevel = (rawLevel: number): void => {
    const position = clampPosition(rawLevel);
    const state = getProgression(position);
    currentPosition = position;
    slider.value = String(position);
    slider.setAttribute(
      "aria-valuetext",
      `${state.stage}，${state.level} 级，共 ${MAX_LEVEL} 级`,
    );
    output.textContent = `${String(state.level).padStart(2, "0")} / ${MAX_LEVEL}`;
    stageName.textContent = state.stage;
    stageGhost.textContent = state.stage;
    stageIndex.textContent = `阶段 ${String(state.stageIndex + 1).padStart(2, "0")} / 06`;
    canvas.setAttribute("aria-label", `当前形态：${state.stage}`);
    experience.dataset.stage = String(state.stageIndex);
    experience.style.setProperty("--strength", String(position / MAX_LEVEL));
    experience.style.setProperty("--stage-progress", String(state.localProgress));

    ticks.forEach((tick, index) => {
      tick.classList.toggle("is-active", index <= state.level);
    });
    markers.forEach((marker, index) => {
      marker.classList.toggle("is-current", index === state.stageIndex);
      marker.classList.toggle("is-passed", index < state.stageIndex);
    });

    onLevelChange(position);
  };

  const setVotes = (up: number, down: number): void => {
    upCount.textContent = String(up);
    downCount.textContent = String(down);
    const level = communityLevelFromTally(up, down);
    const state = getProgression(level);
    voteCommunityLevel.textContent = `${state.stage} · ${state.level} 级`;

    const impact = singleVoteImpact(up, down);
    voteImpactValue.textContent =
      impact <= 0.005 ? "已达极限" : `≈ ${impact.toFixed(1)} 级`;
  };

  const setHistory = (history: HistoryEntry[]): void => {
    renderChart(chartSvg, history);
  };

  const setVoteState = (state: VoteState, message?: string): void => {
    voteState.dataset.state = state;
    const defaults: Record<VoteState, string> = {
      idle: "未投票",
      voting: "投票中…",
      voted: "已投票",
      error: "出错了",
    };
    voteState.textContent = message ?? defaults[state];
    voteButtons.forEach((button) => {
      button.disabled = state === "voting";
    });
  };

  const onVote = (handler: VoteHandler): void => {
    voteButtons.forEach((button) => {
      button.addEventListener("click", () => {
        handler(button.dataset.direction as VoteDirection);
      });
    });
  };

  const onShowCommunity = (handler: () => void): void => {
    showCommunityButton.addEventListener("click", handler);
  };

  slider.addEventListener("input", () => {
    setLevel(Number(slider.value));
  });

  setLevel(0);

  return {
    canvas,
    slider,
    get level() {
      return currentPosition;
    },
    setLevel,
    setVotes,
    setVoteState,
    setHistory,
    onVote,
    onShowCommunity,
    setLoading(loaded, total) {
      loadState.textContent = loaded >= total ? "连续祖力已就绪" : "载入连续祖力…";
    },
    setReady() {
      slider.disabled = false;
      loadState.hidden = true;
    },
    setError(message) {
      slider.disabled = true;
      loadState.hidden = false;
      loadState.classList.add("is-error");
      loadState.textContent = message;
    },
  };
}
