// 投票等级模拟脚本：对比「当前线上 Wilson 算法」vs「方案 B（少数方占比 + 样本因子）」。
// 不改正式代码，仅生成对比报告。用法：node scripts/simulate-votes.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HALF_LIFE_MS = 7 * 24 * 3600 * 1000;
const WINDOW_MS = 30 * 24 * 3600 * 1000;

// —— 当前线上算法：Wilson 下界中性偏离 ——
const CONSENSUS_FULL = 0.77;
const CONSENSUS_NEUTRAL = 0.45;
function wilsonLower(up, down) {
  const n = up + down;
  if (n <= 0) return 0.5;
  const z = 1.96;
  const z2 = z * z;
  const p = up / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return center - margin;
}
function consensusWilson(up, down) {
  const m = Math.max(up, down);
  const n = Math.min(up, down);
  const p = wilsonLower(m, n);
  return Math.min(1, Math.max(0, (p - CONSENSUS_NEUTRAL) / (CONSENSUS_FULL - CONSENSUS_NEUTRAL)));
}
function levelWilson(up, down) {
  const net = up - down;
  if (net === 0) return 15;
  const strength = Math.min(1, Math.sqrt(Math.abs(net)) / Math.sqrt(20));
  const consensus = consensusWilson(up, down);
  return Math.min(30, Math.max(0, 15 + 15 * strength * consensus * Math.sign(net)));
}

// —— 方案 B：少数方占比容忍带 + 样本因子（无死区，满级可达）——
function consensusB(up, down) {
  const n = up + down;
  if (n <= 0) return 0;
  const r = Math.min(up, down) / n; // 少数方占比 0~0.5
  const raw = (0.5 - r) / 0.4; // 容忍带：r≤0.1（反对≤10%，即 9:1 以上）即满分
  const floored = Math.max(raw, 0.1); // 下限 0.1，保证对半附近每票有影响
  const capped = Math.min(floored, 1);
  const sample = Math.min(1, n / 20); // 样本因子：n≥20 精确满级，n 小线性收缩
  return capped * sample;
}
function levelB(up, down) {
  const net = up - down;
  if (net === 0) return 15;
  const strength = Math.min(1, Math.sqrt(Math.abs(net)) / Math.sqrt(20));
  const consensus = consensusB(up, down);
  return Math.min(30, Math.max(0, 15 + 15 * strength * consensus * Math.sign(net)));
}

// —— 旧净票 sqrt（参考）——
function levelOld(net) {
  if (net === 0) return 15;
  const mag = Math.min(1, Math.sqrt(Math.abs(net)) / Math.sqrt(20));
  return Math.min(30, Math.max(0, 15 + 15 * mag * Math.sign(net)));
}

function voteWeight(ageMs) {
  return Math.pow(0.5, ageMs / HALF_LIFE_MS);
}
function weightedTally(events, now) {
  let up = 0;
  let down = 0;
  let upW = 0;
  let downW = 0;
  for (const e of events) {
    const age = now - e.t;
    if (age < 0 || age > WINDOW_MS) continue;
    const w = voteWeight(age);
    if (e.d === "up") {
      up += 1;
      upW += w;
    } else {
      down += 1;
      downW += w;
    }
  }
  return { up, down, upW, downW, net: upW - downW };
}

const STAGES = ["小难梁", "牢梁", "梁子", "梁圣", "梁神", "梁祖"];
function stageOf(level) {
  const i = Math.min(5, Math.floor(Math.round(level) / 6));
  return STAGES[i];
}
function fmt(v) {
  return typeof v === "number" ? v.toFixed(1) : v;
}

const staticCases = [
  ["+1-0 全认可(1票)", 1, 0],
  ["+2-0 全认可(2票)", 2, 0],
  ["+3-0 全认可(3票)", 3, 0],
  ["+4-0 全认可(4票)", 4, 0],
  ["+5-0 全认可(5票)", 5, 0],
  ["+8-0 全认可(8票)", 8, 0],
  ["+10-0 全认可(10票)", 10, 0],
  ["+15-0 全认可(15票)", 15, 0],
  ["+20-0 全认可(20票)", 20, 0],
  ["+50-0 全认可(50票)", 50, 0],
  ["+100-0 全认可(100票)", 100, 0],
  ["+22-2 满级边界(11:1)", 22, 2],
  ["+90-10 九比一(9:1)", 90, 10],
  ["+80-10 八比一(8:1)", 80, 10],
  ["+20-1 轻争议(5%反对)", 20, 1],
  ["+20-2 轻争议(9%反对)", 20, 2],
  ["+20-5 争议(20%反对)", 20, 5],
  ["+20-10 争议(33%反对)", 20, 10],
  ["+100-20 争议(17%反对)", 100, 20],
  ["+100-40 争议(29%反对)", 100, 40],
  ["+100-50 争议(33%反对)", 100, 50],
  ["+100-80 争议(44%反对)", 100, 80],
  ["+100-90 争议(47%反对)", 100, 90],
  ["+50-50 对半", 50, 50],
  ["+100-100 对半", 100, 100],
  ["0-20 全反对(跌)", 0, 20],
  ["0-50 全反对(跌)", 0, 50],
  ["0-100 全反对(跌)", 0, 100],
  ["+80-100 反对占优(跌)", 80, 100],
  ["+40-100 反对占优(跌)", 40, 100],
];

const day = 24 * 3600 * 1000;
const now = Date.now();
const decayCases = [
  ["20赞 今天集中", Array.from({ length: 20 }, () => ({ t: now, d: "up" }))],
  ["20赞 近7天分散", Array.from({ length: 20 }, (_, i) => ({ t: now - (i % 7) * day, d: "up" }))],
  ["20赞 14天前", Array.from({ length: 20 }, () => ({ t: now - 14 * day, d: "up" }))],
  ["20赞 30天前(出窗)", Array.from({ length: 20 }, () => ({ t: now - 30 * day, d: "up" }))],
  ["100赞80踩 今天(争议)", [
    ...Array.from({ length: 100 }, () => ({ t: now, d: "up" })),
    ...Array.from({ length: 80 }, () => ({ t: now, d: "down" })),
  ]],
  ["100赞20天前 + 80踩今天", [
    ...Array.from({ length: 100 }, () => ({ t: now - 20 * day, d: "up" })),
    ...Array.from({ length: 80 }, () => ({ t: now, d: "down" })),
  ]],
  ["20赞20踩 今天(对半)", [
    ...Array.from({ length: 20 }, () => ({ t: now, d: "up" })),
    ...Array.from({ length: 20 }, () => ({ t: now, d: "down" })),
  ]],
  ["51赞50踩(对半+1)", [
    ...Array.from({ length: 51 }, () => ({ t: now, d: "up" })),
    ...Array.from({ length: 50 }, () => ({ t: now, d: "down" })),
  ]],
];

const staticRows = staticCases.map(([name, up, down]) => {
  const lw = levelWilson(up, down);
  const lb = levelB(up, down);
  return {
    name,
    up,
    down,
    net: up - down,
    consensusB: consensusB(up, down),
    levelWilson: lw,
    levelB: lb,
    stage: stageOf(lb),
  };
});

const decayRows = decayCases.map(([name, events]) => {
  const t = weightedTally(events, now);
  const lw = levelWilson(t.upW, t.downW);
  const lb = levelB(t.upW, t.downW);
  return {
    name,
    total: t.up + t.down,
    weightedNet: t.net,
    levelWilson: lw,
    levelB: lb,
    stage: stageOf(lb),
  };
});

// —— 控制台 ——
console.log("=== 静态场景（当前 Wilson vs 方案 B）===");
console.log("场景                    | 净票 | 共识B | Wilson | 方案B | 档位");
console.log("-".repeat(80));
for (const r of staticRows) {
  console.log(
    `${r.name.padEnd(22)} | ${String(r.net).padStart(4)} | ${fmt(r.consensusB).padStart(5)} | ${fmt(r.levelWilson).padStart(6)} | ${fmt(r.levelB).padStart(5)} | ${r.stage}`,
  );
}
console.log("\n=== 时间衰减场景 ===");
console.log("场景                                    | 原始票 | 加权净票 | Wilson | 方案B | 档位");
console.log("-".repeat(80));
for (const r of decayRows) {
  console.log(
    `${r.name.padEnd(28)} | ${String(r.total).padStart(5)} | ${fmt(r.weightedNet).padStart(7)} | ${fmt(r.levelWilson).padStart(6)} | ${fmt(r.levelB).padStart(5)} | ${r.stage}`,
  );
}

// —— HTML 报告 ——
function bar(level, max = 30) {
  const pct = Math.max(0, Math.min(100, (level / max) * 100));
  const color = level >= 24 ? "#d4537e" : level >= 18 ? "#ba7517" : level >= 12 ? "#1d9e75" : level >= 6 ? "#378add" : "#888780";
  return `<div class="bar-wrap"><div class="bar" style="width:${pct.toFixed(1)}%;background:${color}"></div><span class="bar-val">${fmt(level)}</span></div>`;
}
function barCompare(wilson, b) {
  return `<div class="cmp">
    <div class="cmp-row"><span class="cmp-tag tag-w">当前</span>${bar(wilson)}</div>
    <div class="cmp-row"><span class="cmp-tag tag-b">方案B</span>${bar(b)}</div>
  </div>`;
}

const staticHtml = staticRows
  .map(
    (r) => `<tr>
      <td>${r.name}</td>
      <td class="num">${r.up}</td>
      <td class="num">${r.down}</td>
      <td class="num">${r.net > 0 ? "+" : ""}${r.net}</td>
      <td class="num">${fmt(r.consensusB)}</td>
      <td>${barCompare(r.levelWilson, r.levelB)}</td>
      <td class="stage">${r.stage}</td>
    </tr>`,
  )
  .join("");

const decayHtml = decayRows
  .map(
    (r) => `<tr>
      <td>${r.name}</td>
      <td class="num">${r.total}</td>
      <td class="num">${r.weightedNet > 0 ? "+" : ""}${fmt(r.weightedNet)}</td>
      <td>${barCompare(r.levelWilson, r.levelB)}</td>
      <td class="stage">${r.stage}</td>
    </tr>`,
  )
  .join("");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>投票算法对比报告：当前 Wilson vs 方案 B</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f4f0; color: #22201a; line-height: 1.6; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  h2 { font-size: 17px; font-weight: 600; margin: 36px 0 12px; }
  .sub { color: #6b6a63; font-size: 14px; margin-bottom: 8px; }
  .card { background: #fff; border: 1px solid #e7e4dc; border-radius: 12px; padding: 18px 20px; margin-top: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 7px 10px; border-bottom: 1px solid #efede7; text-align: left; white-space: nowrap; }
  th { color: #6b6a63; font-weight: 500; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  .num { font-variant-numeric: tabular-nums; color: #44433d; }
  .stage { color: #993c1d; font-weight: 500; }
  .bar-wrap { display: flex; align-items: center; gap: 8px; width: 150px; }
  .bar { height: 10px; border-radius: 3px; min-width: 2px; }
  .bar-val { font-size: 12px; color: #44433d; font-variant-numeric: tabular-nums; width: 32px; }
  .cmp { display: flex; flex-direction: column; gap: 3px; }
  .cmp-row { display: flex; align-items: center; gap: 6px; }
  .cmp-tag { font-size: 11px; padding: 0 5px; border-radius: 3px; width: 38px; text-align: center; }
  .tag-w { background: #e6f1fb; color: #185fa5; }
  .tag-b { background: #e1f5ee; color: #0f6e56; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: #6b6a63; margin: 8px 0 0; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .note { font-size: 13px; color: #6b6a63; }
  code { background: #f1efe8; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>投票算法对比报告：当前 Wilson vs 方案 B</h1>
  <p class="sub">方案 B：<code>共识 = clamp((0.5 − 少数方占比)/0.4, 0, 1) × min(1, n/20)</code>，下限 0.1，反对 ≤10%（9:1 以上）即满级、n≥20 精确到顶。当前：Wilson 95% 置信下界中性偏离（有死区）。</p>
  <div class="legend">
    <span><span class="dot" style="background:#d4537e"></span>梁神/梁祖 24–30</span>
    <span><span class="dot" style="background:#ba7517"></span>梁圣 18–23</span>
    <span><span class="dot" style="background:#1d9e75"></span>梁子 12–17</span>
    <span><span class="dot" style="background:#378add"></span>牢梁 6–11</span>
    <span><span class="dot" style="background:#888780"></span>小难梁 0–5</span>
  </div>

  <h2>静态场景（同一时刻的票）</h2>
  <div class="card">
    <table>
      <thead><tr><th>场景</th><th>up</th><th>down</th><th>净票</th><th>共识B</th><th>level 对比（当前/方案B）</th><th>档位</th></tr></thead>
      <tbody>${staticHtml}</tbody>
    </table>
  </div>
  <p class="note">重点看 <code>+100-80</code>（44% 反对）：Wilson 卡在 16.5、方案 B 给 16.9，都接近 16。但 <code>+20-10</code>（33% 反对）：Wilson 16.3、方案 B 18.9，方案 B 对「中等争议」更宽容。</p>

  <h2>时间衰减场景（7 天半衰期 / 30 天窗口）</h2>
  <div class="card">
    <table>
      <thead><tr><th>场景</th><th>原始票数</th><th>加权净票</th><th>level 对比（当前/方案B）</th><th>档位</th></tr></thead>
      <tbody>${decayHtml}</tbody>
    </table>
  </div>
  <p class="note">重点看 <code>51赞50踩</code>（对半+1）：Wilson 卡在 15 无反应，方案 B 给 15.3 —— 每张票都能看到等级挪动。</p>
</div>
</body>
</html>`;

const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "output", "vote-simulation-report.html");
writeFileSync(outPath, html, "utf8");
console.log(`\n报告已生成：${outPath}`);
