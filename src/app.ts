import {
  clampPosition,
  DEFAULT_HALF_LIFE_HOURS,
  getProgression,
  halfLifeMsFromHours,
  levelSeries,
  MAX_LEVEL,
  singleVoteImpact,
  STAGES,
} from "./progression";
import type { VoteDirection, VoteEvent, VoteGap } from "./vote";

export interface AppController {
  readonly portrait: HTMLCanvasElement;
  readonly slider: HTMLInputElement;
  readonly level: number;
  setLevel(level: number): void;
  setLoading(loaded: number, total: number): void;
  setReady(): void;
  setError(message: string): void;
  setVotes(up: number, down: number, level: number, weightedUp: number, weightedDown: number): void;
  setVoteState(state: VoteState, message?: string): void;
  setEvents(events: VoteEvent[]): void;
  setGaps(gaps: VoteGap[]): void;
  setHalfLife(hours: number): void;
  setHalfLifeStatus(message: string, isError?: boolean): void;
  showQuotaBanner(message: string): void;
  onVote(handler: VoteHandler): void;
  onShowCommunity(handler: () => void): void;
  onSaveHalfLife(handler: (hours: number) => void): void;
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

// 图表内边距（像素）
const CHART_PAD = { top: 14, right: 12, bottom: 22, left: 34 };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// x 轴刻度标签
function formatTick(t: number, rangeKey: RangeKey): string {
  const d = new Date(t);
  if (rangeKey === "1y" || rangeKey === "all") {
    return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  if (rangeKey === "7d" || rangeKey === "30d") {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// tooltip 里的完整时间
function formatFullTime(t: number, rangeKey: RangeKey): string {
  const d = new Date(t);
  if (rangeKey === "tick") {
    return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  if (rangeKey === "1y" || rangeKey === "all") {
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

interface ChartPoint {
  x: number;
  y: number;
  t: number;
  idx: number;
  level: number;
}

function measure(svg: SVGSVGElement): { w: number; h: number } {
  const w = svg.clientWidth;
  const h = svg.clientHeight;
  if (w > 0 && h > 0) return { w, h };
  const rect = svg.getBoundingClientRect();
  return { w: rect.width || 600, h: rect.height || 200 };
}

function renderChart(
  svg: SVGSVGElement,
  events: VoteEvent[],
  rangeKey: RangeKey,
  halfLifeMs: number,
): ChartPoint[] {
  const series = levelSeries(events, halfLifeMs);
  const now = Date.now();

  // 逻辑坐标（x 用时间戳或票序号）
  let logical: { x: number; y: number; t: number; idx: number }[];
  let from: number;
  let to: number;
  let tickLabels: string[];

  if (rangeKey === "tick") {
    logical = series.map((p, i) => ({ x: i, y: p.level, t: p.t, idx: i }));
    from = 0;
    to = Math.max(0, series.length - 1);
    tickLabels = Array.from({ length: 5 }, (_, i) => {
      const idx = Math.round(from + ((to - from) * i) / 4);
      return `#${idx + 1}`;
    });
  } else {
    const rangeMs = RANGES[rangeKey]!;
    const visible =
      rangeKey === "all" ? series : series.filter((p) => p.t >= now - rangeMs);
    logical = visible.map((p, i) => ({ x: p.t, y: p.level, t: p.t, idx: i }));
    from =
      rangeKey === "all"
        ? series.length
          ? series[0].t
          : now
        : now - rangeMs;
    to = now;
    tickLabels = Array.from({ length: 5 }, (_, i) => {
      const t = from + ((to - from) * i) / 4;
      return formatTick(t, rangeKey);
    });
  }

  const { w, h } = measure(svg);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const plotW = w - CHART_PAD.left - CHART_PAD.right;
  const plotH = h - CHART_PAD.top - CHART_PAD.bottom;

  const levels = logical.map((p) => p.y);
  const minL = levels.length ? Math.min(...levels) : 15;
  const maxL = levels.length ? Math.max(...levels) : 15;
  const yMin = Math.max(0, Math.floor(minL - 1));
  const yMax = Math.min(30, Math.ceil(maxL + 1));
  const yRange = Math.max(1, yMax - yMin);

  const xSpan = Math.max(1, to - from);
  const xOf = (x: number): number =>
    CHART_PAD.left + ((x - from) / xSpan) * plotW;
  const yOf = (level: number): number =>
    CHART_PAD.top + plotH - ((level - yMin) / yRange) * plotH;

  const parts: string[] = [];

  for (let i = 0; i <= 4; i++) {
    const level = yMin + (yRange * i) / 4;
    const y = yOf(level);
    parts.push(
      `<line class="chart-grid" x1="${CHART_PAD.left}" y1="${y.toFixed(1)}" x2="${
        w - CHART_PAD.right
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
      )}" y2="${h - CHART_PAD.bottom}" />`,
    );
    parts.push(
      `<text class="chart-tick" x="${x.toFixed(1)}" y="${
        h - 8
      }" text-anchor="middle">${tickLabels[i]}</text>`,
    );
  }

  const points: ChartPoint[] = logical.map((p) => ({
    x: xOf(p.x),
    y: yOf(p.y),
    t: p.t,
    idx: p.idx,
    level: p.y,
  }));

  if (points.length > 0) {
    const poly = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    parts.push(`<polyline class="chart-line" points="${poly}" />`);
    const last = points[points.length - 1];
    parts.push(
      `<circle class="chart-dot" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3" />`,
    );
  }

  // hover 竖线（跟随鼠标，贯穿整个图表）
  parts.push(`<line class="chart-hover-line" x1="0" y1="0" x2="0" y2="${h}" />`);
  parts.push(`<circle class="chart-hover-dot" cx="0" cy="0" r="3.5" />`);

  svg.innerHTML = parts.join("");
  // 暴露坐标映射，供 hover 时把鼠标 x 反推成时间（判断数据缺口）
  svg.dataset.fromT = String(from);
  svg.dataset.toT = String(to);
  svg.dataset.plotW = String(plotW);
  svg.dataset.range = rangeKey;
  return points;
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
          <div class="chart-body">
            <svg class="vote-chart-svg" role="img" aria-label="评级历史走势"></svg>
            <div class="chart-tooltip" role="status" hidden>
              <span class="chart-tooltip-time"></span>
              <span class="chart-tooltip-level"></span>
              <span class="chart-tooltip-gap" hidden></span>
            </div>
          </div>
        </div>

        <div class="vote-meta">
          <p class="vote-community">
            社区评分：<strong class="vote-community-level">—</strong>
          </p>
          <p class="vote-impact">
            单票影响力 <strong class="vote-impact-value">—</strong>
          </p>
        </div>

        <button class="vote-show-community" type="button" data-action="show-community">
          查看社区评分
        </button>

        <details class="vote-settings">
          <summary class="vote-settings-toggle">半衰期设置 <span class="vote-settings-current"></span></summary>
          <div class="vote-settings-body">
            <p class="vote-settings-hint">票的权重随时间的半衰期（小时），越小旧票淡化越快。默认 18 小时，仅本机生效、不影响他人。</p>
            <div class="vote-settings-row">
              <input
                class="vote-settings-input"
                type="number"
                min="1"
                max="8760"
                step="1"
                inputmode="numeric"
                aria-label="半衰期小时数"
              />
              <button class="vote-settings-save" type="button" data-action="save-half-life">保存</button>
            </div>
            <p class="vote-settings-status" role="status"></p>
          </div>
        </details>
      </section>

      <footer class="footer-note">
        <span>31 级连续进化</span>
        <span class="footer-links">
          <span class="footer-group">
            <span class="footer-brand">GitHub ·</span>
            <a href="https://github.com/Lichtspektrum/liang-intensity-calibrator" target="_blank" rel="noopener noreferrer">原项目</a>
            <a href="https://github.com/Abyss-Seeker/liang-intensity-calibrator" target="_blank" rel="noopener noreferrer">本项目</a>
          </span>
          <a class="footer-bili" href="https://www.bilibili.com/video/BV1mVg76XEei/" target="_blank" rel="noopener noreferrer">Bilibili视频</a>
        </span>
        <span>正脸识别协议：已启用</span>
      </footer>
    </div>
  `;

  const experience = root.querySelector<HTMLElement>(".experience")!;
  const portrait = root.querySelector<HTMLCanvasElement>(".portrait-canvas")!;
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
  const chartTooltip = root.querySelector<HTMLElement>(".chart-tooltip")!;
  const chartTooltipTime = root.querySelector<HTMLElement>(".chart-tooltip-time")!;
  const chartTooltipLevel = root.querySelector<HTMLElement>(".chart-tooltip-level")!;
  const chartTooltipGap = root.querySelector<HTMLElement>(".chart-tooltip-gap")!;
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
  const halfLifeInput = root.querySelector<HTMLInputElement>(
    ".vote-settings-input",
  )!;
  const halfLifeCurrent = root.querySelector<HTMLElement>(
    ".vote-settings-current",
  )!;
  const halfLifeStatus = root.querySelector<HTMLElement>(
    ".vote-settings-status",
  )!;
  const halfLifeSaveButton = root.querySelector<HTMLButtonElement>(
    '[data-action="save-half-life"]',
  )!;

  let currentPosition = 0;
  let currentEvents: VoteEvent[] = [];
  let currentGaps: VoteGap[] = [];
  let currentRange: RangeKey = "24h";
  let currentHalfLifeMs = halfLifeMsFromHours(DEFAULT_HALF_LIFE_HOURS);
  let chartPoints: ChartPoint[] = [];

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
    portrait.setAttribute("aria-label", `当前形态：${state.stage}`);
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

  const redrawChart = (): void => {
    chartPoints = renderChart(chartSvg, currentEvents, currentRange, currentHalfLifeMs);
  };

  const setVotes = (
    up: number,
    down: number,
    level: number,
    weightedUp: number,
    weightedDown: number,
  ): void => {
    upCount.textContent = String(up);
    downCount.textContent = String(down);
    const state = getProgression(level);
    voteCommunityLevel.textContent = `${state.stage} · ${level.toFixed(4)} 级`;
    chartCurrent.textContent = `${state.stage} ${state.level} 级`;

    const impact = singleVoteImpact(weightedUp, weightedDown);
    // 永不显示「已达极限」：单票影响再小也如实展示。
    // 样本饱和时 1/n 效应会让数字趋近 0，但那是真实的边际影响，不该用文案掩盖。
    const impactText =
      impact >= 0.1 ? impact.toFixed(2) : impact.toFixed(4);
    voteImpactValue.textContent = `≈ ${impactText} 级`;
  };

  const setEvents = (events: VoteEvent[]): void => {
    currentEvents = events;
    redrawChart();
  };

  const setGaps = (gaps: VoteGap[]): void => {
    currentGaps = gaps;
  };

  const setHalfLife = (hours: number): void => {
    currentHalfLifeMs = halfLifeMsFromHours(hours);
    halfLifeInput.value = String(hours);
    halfLifeCurrent.textContent = `（当前 ${hours} 小时）`;
    redrawChart();
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

  const onSaveHalfLife = (handler: (hours: number) => void): void => {
    const submit = (): void => {
      const raw = Number(halfLifeInput.value);
      if (!Number.isFinite(raw) || raw < 1 || raw > 8760) {
        halfLifeStatus.textContent = "请输入 1~8760 之间的整数";
        return;
      }
      halfLifeStatus.textContent = "保存中…";
      handler(Math.round(raw));
    };
    halfLifeSaveButton.addEventListener("click", submit);
    halfLifeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
  };

  // 暴露半衰期保存结果的反馈（由 main.ts 在保存后调用）
  const setHalfLifeStatus = (message: string, isError: boolean): void => {
    halfLifeStatus.textContent = message;
    halfLifeStatus.classList.toggle("is-error", isError);
  };

  // 投票写入配额耗尽时的顶部告警条（挂 document.body，避免被页面 transform 影响）
  const showQuotaBanner = (message: string): void => {
    let banner = document.querySelector<HTMLElement>(".quota-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "quota-banner";
      banner.setAttribute("role", "alert");
      const text = document.createElement("span");
      text.className = "quota-banner-text";
      const close = document.createElement("button");
      close.className = "quota-banner-close";
      close.type = "button";
      close.setAttribute("aria-label", "关闭提示");
      close.textContent = "×";
      close.addEventListener("click", () => banner?.remove());
      banner.append(text, close);
      document.body.append(banner);
    }
    banner.querySelector<HTMLElement>(".quota-banner-text")!.textContent =
      message;
  };

  rangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentRange = button.dataset.range as RangeKey;
      rangeButtons.forEach((b) => b.classList.toggle("is-active", b === button));
      redrawChart();
    });
  });

  slider.addEventListener("input", () => {
    setLevel(Number(slider.value));
  });

  // hover：悬浮显示该时间片的完整时间与梁系强度
  const hideTooltip = (): void => {
    chartTooltip.hidden = true;
    const line = chartSvg.querySelector<SVGLineElement>(".chart-hover-line");
    const dot = chartSvg.querySelector<SVGCircleElement>(".chart-hover-dot");
    if (line) line.style.display = "none";
    if (dot) dot.style.display = "none";
  };

  // 统一的悬浮/触摸定位：clientX/clientY 为视口坐标，换算成图表内坐标
  const updateHover = (clientX: number, clientY: number): void => {
    if (chartPoints.length === 0) return;
    const rect = chartSvg.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    // 十字竖线：始终跟随 x、贯穿绘图区，方便对齐时间轴
    const line = chartSvg.querySelector<SVGLineElement>(".chart-hover-line");
    if (line) {
      line.style.display = "inline";
      line.setAttribute("x1", String(px));
      line.setAttribute("x2", String(px));
    }

    // 找 x 最近的采样点（用于圆点与数据提示）
    let best = chartPoints[0];
    let bestDist = Infinity;
    for (const p of chartPoints) {
      const d = Math.abs(p.x - px);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }

    const dot = chartSvg.querySelector<SVGCircleElement>(".chart-hover-dot");

    // 鼠标所指时间：非 tick 模式用 x 线性反推（缺口段内没有数据点，必须用插值）
    let hoverT = best.t;
    const svgRange = chartSvg.dataset.range;
    if (svgRange !== "tick") {
      const fromT = Number(chartSvg.dataset.fromT);
      const toT = Number(chartSvg.dataset.toT);
      const plotW = Number(chartSvg.dataset.plotW);
      if (Number.isFinite(fromT) && Number.isFinite(toT) && plotW > 0) {
        hoverT = fromT + ((px - CHART_PAD.left) / plotW) * (toT - fromT);
      }
    }

    // 数据缺口：鼠标所指时间落在「限额爆了、事件未录入」的窗口内
    const inGap = currentGaps.find((gap) => {
      const end = gap.end ?? Number.POSITIVE_INFINITY;
      return hoverT >= gap.start && hoverT <= end;
    });

    // 距离数据点太远（空白区）：缺口段内也要给提示，其余隐藏数据提示
    if (bestDist > 60) {
      if (dot) dot.style.display = "none";
      if (!inGap) {
        chartTooltip.hidden = true;
        return;
      }
      chartTooltipTime.textContent = formatFullTime(hoverT, currentRange);
      chartTooltipLevel.textContent = "";
      chartTooltipGap.textContent = inGap.reason;
      chartTooltipGap.hidden = false;
      chartTooltip.hidden = false;
      positionTooltip(px, py);
      return;
    }

    if (dot) {
      dot.style.display = "inline";
      dot.setAttribute("cx", String(best.x));
      dot.setAttribute("cy", String(best.y));
    }

    const state = getProgression(best.level);
    chartTooltipTime.textContent = currentRange === "tick"
      ? `第 ${best.idx + 1} 票 · ${formatFullTime(best.t, currentRange)}`
      : formatFullTime(best.t, currentRange);
    chartTooltipLevel.textContent = `${state.stage} · ${state.level} 级`;

    if (inGap) {
      chartTooltipGap.textContent = inGap.reason;
      chartTooltipGap.hidden = false;
    } else {
      chartTooltipGap.hidden = true;
    }

    chartTooltip.hidden = false;
    positionTooltip(best.x, best.y);
  };

  // 定位 tooltip（相对 chart-body），跟随锚点、避免溢出
  const positionTooltip = (anchorX: number, anchorY: number): void => {
    const body = chartTooltip.parentElement!;
    const bodyRect = body.getBoundingClientRect();
    const tipW = chartTooltip.offsetWidth || 140;
    const tipH = chartTooltip.offsetHeight || 44;
    let left = anchorX + 12;
    let top = anchorY - tipH - 8;
    if (left + tipW > bodyRect.width - 4) left = anchorX - tipW - 12;
    if (top < 4) top = anchorY + 12;
    chartTooltip.style.left = `${left}px`;
    chartTooltip.style.top = `${top}px`;
  };

  chartSvg.addEventListener("mousemove", (event) => {
    updateHover(event.clientX, event.clientY);
  });

  chartSvg.addEventListener("mouseleave", hideTooltip);

  // 移动端：手指拖动竖线跟随（无 hover，只能靠触摸）。touch-action: pan-y
  // 让垂直滚动仍归浏览器，水平拖动交给这里处理竖线。
  chartSvg.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    if (touch) updateHover(touch.clientX, touch.clientY);
  }, { passive: true });

  chartSvg.addEventListener("touchmove", (event) => {
    event.preventDefault();
    const touch = event.touches[0];
    if (touch) updateHover(touch.clientX, touch.clientY);
  }, { passive: false });

  // 手指离开后保留竖线在最后位置（同股票软件），便于查看最终值

  // 窗口尺寸变化时重绘（保持文字不拉伸）
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => redrawChart());
    observer.observe(chartSvg);
  }

  setLevel(0);

  return {
    portrait,
    slider,
    get level() {
      return currentPosition;
    },
    setLevel,
    setVotes,
    setVoteState,
    setEvents,
    setGaps,
    setHalfLife,
    setHalfLifeStatus,
    showQuotaBanner,
    onVote,
    onShowCommunity,
    onSaveHalfLife,
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
