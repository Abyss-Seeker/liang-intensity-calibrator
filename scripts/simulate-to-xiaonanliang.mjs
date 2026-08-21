import fs from "fs";

// —— 从线上拉取的事件作为起点 ——
const tally = JSON.parse(fs.readFileSync("/tmp/vote-now.json", "utf8"));
const events = tally.events.map((e) => ({ t: e.t, d: e.d }));

// —— 与 worker 一致的算法 ——
const HALF_LIFE_MS = 18 * 3600 * 1000;
const WINDOW_MS = 30 * 24 * 3600 * 1000;
const BASE_LEVEL = 15;
const VOTE_FULL_NET = 20;
const CONSENSUS_FLOOR = 0.1;
const CONSENSUS_R_FULL = 0.1;
const CONSENSUS_N_FULL = 20;

const voteWeight = (ageMs) => Math.pow(0.5, ageMs / HALF_LIFE_MS);

function consensusFactor(upW, downW) {
  const n = upW + downW;
  if (n <= 0) return 0;
  const r = Math.min(upW, downW) / n;
  const raw = (0.5 - r) / (0.5 - CONSENSUS_R_FULL);
  const floored = Math.max(raw, CONSENSUS_FLOOR);
  const capped = Math.min(floored, 1);
  const sample = Math.min(1, n / CONSENSUS_N_FULL);
  return capped * sample;
}

function levelFromTally(upW, downW) {
  const net = upW - downW;
  if (net === 0) return BASE_LEVEL;
  const strength = Math.min(1, Math.sqrt(Math.abs(net)) / Math.sqrt(VOTE_FULL_NET));
  const consensus = consensusFactor(upW, downW);
  return Math.min(30, Math.max(0, BASE_LEVEL + BASE_LEVEL * strength * consensus * Math.sign(net)));
}

function computeLevel(events, now) {
  let upW = 0, downW = 0;
  for (const e of events) {
    const age = now - e.t;
    if (age < 0 || age > WINDOW_MS) continue;
    const w = voteWeight(age);
    if (e.d === "up") upW += w;
    else downW += w;
  }
  return { upW, downW, net: upW - downW, level: levelFromTally(upW, downW) };
}

// —— 模拟：从当前状态起，每小时按 R 票/h、down 占比 p 投新票 ——
// 返回 { enterHours, bottomHours }：进小难梁(<6) 与触底(<=0.5) 的小时数，null 表示模拟期内达不到
function simulate(ratePerHour, downRatio, maxHours = 720) {
  const ev = events.map((e) => ({ ...e }));
  const now0 = Date.now();
  let enterHours = null;
  let bottomHours = null;
  for (let k = 1; k <= maxHours; k += 1) {
    const now = now0 + k * 3600 * 1000;
    const nNew = Math.round(ratePerHour);
    for (let i = 0; i < nNew; i += 1) {
      ev.push({ t: now, d: Math.random() < downRatio ? "down" : "up" });
    }
    const r = computeLevel(ev, now);
    if (enterHours === null && r.level < 6) enterHours = k;
    if (bottomHours === null && r.level <= 0.5) bottomHours = k;
    if (enterHours !== null && bottomHours !== null) break;
  }
  return { enterHours, bottomHours };
}

const fmt = (h) => (h === null ? "—（模拟期内达不到）" : `${h}h ≈ ${(h / 24).toFixed(1)}天`);

console.log("当前状态: level = " + tally.level.toFixed(3) + "，加权 net = " + tally.net.toFixed(1));
console.log("当前速率基准: 66 票/h（最近 24h 实测，down 67%）\n");
console.log("模拟参数: 半衰期 18h、30 天窗口、每小时按指定速率与 down 占比投票，跑 30 天\n");
console.log("down 占比      进小难梁(<6)       触底(0级,<=0.5)");
console.log("──────────────────────────────────────────────");

const scenarios = [
  [66, 0.67, "当前比例持续(67%)"],
  [66, 0.70, "70%"],
  [66, 0.75, "75%"],
  [66, 0.80, "80%"],
  [66, 0.85, "85%"],
  [66, 0.90, "90%"],
  [66, 1.00, "100%全踩"],
  [132, 0.80, "80% × 双倍速"],
  [132, 1.00, "100% × 双倍速"],
  [33, 0.90, "90% × 半速"],
];

for (const [rate, down, label] of scenarios) {
  const { enterHours, bottomHours } = simulate(rate, down);
  const pad = label.padEnd(16);
  console.log(`${pad} ${fmt(enterHours).padEnd(22)} ${fmt(bottomHours)}`);
}
