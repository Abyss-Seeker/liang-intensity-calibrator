我根本不懂我在做什么，下面这些也不是我写的……
（后来慢慢懂了，现在它是个带社区投票的滑杆玩具了。Deepseek娘的碎碎念）

# 滑动变祖器

一个把鼠标滑杆做成「梁系强度校准器」的网页小玩具，外加一块免登录的社区投票板。拖动滑杆，人物会在 241 帧插值视频中连续变化，从「小难梁」一路进化到佩戴帝冕的「梁祖」；投票区让整个社区一起决定梁系今天的强度。

**在线体验（推荐）**：<https://liang.itsuyo.top/> —— Cloudflare Workers 部署，含社区投票
**原项目 GitHub Pages**（上游 Lichtspektrum 仓库）：<https://lichtspektrum.github.io/liang-intensity-calibrator/>

## 有什么

- 241 张连续 WebP 人像帧，滑杆支持 0.01 级精度
- 六个状态：小难梁、牢梁、梁子、梁圣、梁神、梁祖
- 支持鼠标、触摸和键盘操作，适配桌面与手机浏览器
- **社区投票**：每天一票（up / down），免登录，Cloudflare KV 存储，按 IP 限投，本地午夜重置
- **共识评分算法（方案 B）**：等级 = 方向(净票) × 强度(净票规模) × 共识度(少数方占比 + 样本因子)，20 净票满级，无死区
- **时间衰减**：票的权重按指数半衰期衰减（默认 18 小时），只统计最近 30 天；半衰期可在设置面板自定义（仅本机生效，不影响他人）
- **股票式走势图**：事件流模型，「每票 / 近一年 / 全部」三个视图，鼠标悬浮或手指拖动显示对应时间与等级
- 视频渲染容错：完整加载 + seek 到位确认 + 失败重试，冷启动 / 慢网下不闪屏

## 技术栈

- 前端：TypeScript + Vite 8（`@cloudflare/vite-plugin` 集成）
- 后端：Cloudflare Workers + KV（免登录投票，`/api/vote`）
- 测试：Vitest（单元）+ Playwright（E2E）
- 部署：GitHub Actions 自动构建 GitHub Pages；`wrangler deploy` 发布 Cloudflare Workers

## 本地运行

需要 Node.js 22 或更高版本。

```bash
git clone https://github.com/Abyss-Seeker/liang-intensity-calibrator.git
cd liang-intensity-calibrator
npm install
npm run dev
```

终端会显示本地访问地址，通常是 `http://localhost:5173`。本地开发时投票走 Vite 内置的 Cloudflare Workers 模拟，无需真实 KV。

## 常用命令

```bash
npm run dev            # 本地开发（Vite + Workers 模拟）
npm test               # 单元测试
npm run test:e2e       # 浏览器交互测试（Playwright）
npm run build          # 构建 Cloudflare Workers 部署包（dist/）
npm run build:pages    # 构建 GitHub Pages 发布文件（dist-pages/）
npx wrangler deploy    # 部署到 Cloudflare Workers
```

## 投票 API

- `GET /api/vote`：返回当前加权票数（up / down / net）、等级、完整事件流，以及当前 IP 今天是否已投。
- `POST /api/vote`：投一票。body 为 `{ "direction": "up" | "down", "resetAt": <本地午夜时间戳> }`。`resetAt` 让每日配额按用户本地零点重置（而非投完 24 小时）。

## 评分算法（方案 B）

```
等级 = 15 ± 15 × 强度 × 共识度
强度   = min(1, √|净票| / √20)          // 20 净票满级
共识度 = 少数方容忍带 × 样本因子          // 反对 ≤10%（9:1 以上）即满分；对半仍有 0.1 下限（无死区）；总票数 ≥20 才精确满级
```

时间衰减：单票权重 = `0.5^(票龄 / 半衰期)`，默认半衰期 18 小时，只统计最近 30 天的票。算法仿真与对比脚本见 `scripts/simulate-votes.mjs`。

## 重新生成插帧视频

项目使用免费的 [RIFE ncnn Vulkan](https://github.com/nihui/rife-ncnn-vulkan) 生成中间帧，FFmpeg 负责缩放与视频编码。需要准备 RIFE v4.6 模型，并安装 `ffmpeg`、`ffprobe`。

```bash
# 生成两段 800×800、49 帧画质原型
RIFE_BIN=/绝对路径/rife-ncnn-vulkan \
  bash scripts/video/build-prototype.sh

# 生成完整 241 帧 WebM 与 MP4
RIFE_BIN=/绝对路径/rife-ncnn-vulkan \
  bash scripts/video/build-full-video.sh
```

生成结果位于 `public/video`。网页显示使用从 MP4 导出的独立 WebP 帧，避免移动端视频 seek 卡帧：

```bash
bash scripts/video/build-web-frames.sh
```

WebP 结果位于 `public/evolution-frames`；单帧加载失败时会回退到 `public/frames` 中最接近的 PNG 关键帧。

## 发布

- **GitHub Pages**：项目使用 GitHub Actions 自动发布。向 `main` 分支推送提交后，工作流会构建 `dist-pages` 并更新 GitHub Pages。
- **Cloudflare Workers**：执行 `npx wrangler deploy` 发布到 Workers 并绑定 KV 命名空间 `VOTES`，自定义域名指向 `liang.itsuyo.top`。

## 素材说明

`public/frames`、`public/evolution-frames` 与 `public/video` 内的人像素材用于本项目的趣味化演示。复用或二次发布前，请确认你拥有相关肖像与素材的使用权。

## 致谢

- 原作者：[Lichtspektrum](https://github.com/Lichtspektrum)（[原项目仓库](https://github.com/Lichtspektrum/liang-intensity-calibrator)）
- B 站：[怎么什么昵称都选不了](https://space.bilibili.com/503567859) · [一下作者](https://space.bilibili.com/291088426)

