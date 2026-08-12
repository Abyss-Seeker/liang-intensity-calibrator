import {
  clampPosition,
  getProgression,
  levelFromNet,
  levelSeries,
  MAX_LEVEL,
  singleVoteImpact,
  STAGES,
} from "./progression";
import type { VoteDirection, VoteEvent } from "./vote";

export interface AppController {
  readonly canvas: HTMLCanvasElement;
  readonly slider: HTMLInputElement;
  readonly level: number;
  setLevel(level: number): void;
  setLoading(loaded: number, total: number): void;
  setReady(): void;
  setError(message: string): void;
  setVotes(up: number, down: number, net: number): void;
  setVoteState(state: VoteState, message?: string): void;
  setEvents(events: VoteEvent[]): void;
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

type RangeKey = "tick" | "1h" | "6h" | "24h" | "7d" | "30d" | "1y" | "all";

const RANGES: Record<RangeKey, number | null> = {
  tick: null,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  "1y": 31_536_000_000,
  all: null,
};

const CHART_W = 600;
const CHART_H = 200;
const CHART_PAD = { top: 14, right: 12, bottom: 22, left: 32 };

function formatTime(t: number, rangeKey: RangeKey): string {
  const d = new Date(t);
  if (rangeKey === "1y" || rangeKey === "all") {
    return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  if (rangeKey === "7d" || rangeKey === "30d") {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderChart(
  svg: SVGSVGElement,
  events: VoteEvent[],
  rangeKey: RangeKey,
): void {
  const series = levelSeries(events);
  const now = Date.now();

  // 决定 x 轴映射：tick 视图按票序，其余按时间。
  let points: { x: number; y: number }[];
  let from: number;
  let to: number;
  let tickLabels: string[];

  if (rangeKey === "tick") {
    // 每票视图：x = 票序号，y = 该票投出后的等级
    points = series.map((p, i) => ({ x: i, y: p.level }));
    from = 0;
    to = Math.max(0, series.length - 1);
    tickLabels = Array.from({ length: 5 }, (_, i) => {
      const idx = Math.round((from + ((to - from) * i) / 4));
      return `#${idx + 1}`;
    });
  } else {
    const rangeMs = RANGES[rangeKey]!;
    const visible = rangeKey === "all"
      ? series
      : series.filter((p) => p.t >= now - rangeMs);
    points = visible.map((p) => ({ x: p.t, y: p.level }));
    from = rangeKey === "all"
      ? (series.length ? series[0].t : now)
      : now - rangeMs;
    to = now;
    tickLabels = Array.from({ length: 5 }, (_, i) => {
      const t = from + ((to - from) * i) / 4;
      return formatTime(t, rangeKey);
    });
  }

  const plotW = CHART_W - CHART_PAD.left - CHART_PAD.right;
  const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;

  const levels = points.map((p) => p.y);
  const minL = levels.length ? Math.min(...levels) : 15;
  const maxL = levels.length ? Math.max(...levels) : 15;
  const yMin = Math.max(0, Math.floor(minL - 1));
  const yMax = Math.min(30, Math.ceil(maxL + 1));
  const yRange = Math.max(1, yMax - yMin);

  const xSpan = Math.max(1, to - from);
  const xOf = (x: number): number =>
    CHART_PAD.left + ((x - from) / xSpan) * plotW;

  const parts: string[] = [];

  for (let i = 0; i <= 4; i++) {
    const level = yMin + (yRange * i) / 4;
    const y = CHART_PAD.top + plotH - ((level - yMin) / yRange) * plotH;
    parts.push(
      `<line class="chart-grid" x1="${CHART_PAD.left}" y1="${y.toFixed(1)}" x2="${
        CHART_W - CHART_PAD.right
      }" y2="${y.toFixed(1)}" />`,
    );
    parts.push(
      `<text class="chart-tick chart-tick--y" x="${
        CHART_PAD.left - 6
      }" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(level)}</text>`,
    );
  }

  for (let i = 0; i <= 4; i++) {
    const x = CHART_PAD.left + (plotW * i) / 4;
    parts.push(
      `<line class="chart-grid" x1="${x.toFixed(1)}" y1="${CHART_PAD.top}" x2="${x.toFixed(
        1,
      )}" y2="${CHART_H - CHART_PAD.bottom}" />`,
    );
    parts.push(
      `<text class="chart-tick" x="${x.toFixed(1)}" y="${
        CHART_H - 8
      }" text-anchor="middle">${tickLabels[i]}</text>`,
    );
  }

  if (points.length > 0) {
    const poly = points
      .map((p) => `${xOf(p.x).toFixed(1)},${(
        CHART_PAD.top + plotH - ((p.y - yMin) / yRange) * plotH
      ).toFixed(1)}`)
      .join(" ");
    parts.push(`<polyline class="chart-line" points="${poly}" />`);
    const last = points[points.length - 1];
    const lastX = xOf(last.x);
    const lastY = CHART_PAD.top + plotH - ((last.y - yMin) / yRange) * plotH;
    parts.push(
      `<circle class="chart-dot" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" />`,
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
          <div class="load-state" role="status">正在加载…</div>
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
          <span class="vote-state" role="status" data-state="idle">检查中…</span>
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

        <div class="vote-chart">
          <div class="chart-toolbar">
            <span class="chart-current">—</span>
            <div class="chart-ranges" role="group" aria-label="查看区间">
              <button type="button" data-range="tick">每票</button>
              <button type="button" data-range="1h">1h</button>
              <button type="button" data-range="6h">6h</button>
              <button type="button" data-range="24h" class="is-active">24h</button>
              <button type="button" data-range="7d">7d</button>
              <button type="button" data-range="30d">30d</button>
              <button type="button" data-range="1y">1y</button>
              <button type="button" data-range="all">全部</button>
            </div>
          </div>
          <svg class="vote-chart-svg" viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label="评级历史走势"></svg>
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
        <span class="footer-links">
          <a href="https://github.com/Lichtspektrum/liang-intensity-calibrator" target="_blank" rel="noopener noreferrer">原项目</a>
          <a href="https://github.com/Abyss-Seeker/liang-intensity-calibrator" target="_blank" rel="noopener noreferrer">本项目</a>
        </span>
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
  const chartCurrent = root.querySelector<HTMLElement>(".chart-current")!;
  const chartSvg = root.querySelector<SVGSVGElement>(".vote-chart-svg")!;
  const rangeButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".chart-ranges button"),
  );
  const upCount = root.querySelector<HTMLElement>('[data-count="up"]')!;
  const downCount = root.querySelector<HTMLElement>('[data-count="down"]')!;
  const voteButtons = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".vote-btn"),
  );
  const showCommunityButton = root.querySelector<HTMLButtonElement>(
    '[data-action="show-community"]',
  )!;

  let currentPosition = 0;
  let currentEvents: VoteEvent[] = [];
  let currentRange: RangeKey = "24h";

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
    const strength = position / MAX_LEVEL;
    experience.style.setProperty("--strength", String(strength));
    experience.style.setProperty("--strength-pct", `${strength * 100}%`);
    const inkPct = strength >= 0.75 ? 1 : 0;
    experience.style.setProperty("--ink-pct", `${inkPct * 100}%`);
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

  const setVotes = (up: number, down: number, net: number): void => {
    upCount.textContent = String(up);
    downCount.textContent = String(down);
    const level = levelFromNet(net);
    const state = getProgression(level);
    voteCommunityLevel.textContent = `${state.stage} · ${state.level} 级`;
    chartCurrent.textContent = `${state.stage} ${state.level} 级`;

    const impact = singleVoteImpact(net);
    voteImpactValue.textContent =
      impact <= 0.005 ? "已达极限" : `≈ ${impact.toFixed(1)} 级`;
  };

  const setEvents = (events: VoteEvent[]): void => {
    currentEvents = events;
    renderChart(chartSvg, currentEvents, currentRange);
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

  rangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentRange = button.dataset.range as RangeKey;
      rangeButtons.forEach((b) => b.classList.toggle("is-active", b === button));
      renderChart(chartSvg, currentEvents, currentRange);
    });
  });

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
    setEvents,
    onVote,
    onShowCommunity,
    setLoading(loaded, total) {
      loadState.textContent = loaded >= total ? "连续祖力已就绪" : "正在加载…";
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
