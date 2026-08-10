# 视频抽帧进化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用首尾帧约束视频为 `牢梁 → 小梁` 生成五张中间帧，并让网页在 `0—6` 级使用七张独立图片。

**Architecture:** Veo 3.1 根据现有两张端点图生成短视频，FFmpeg 等距抽取中间帧。渲染器按整数等级选择单张图片，不再计算混合比例。

**Tech Stack:** Vertex AI Veo 3.1、FFmpeg、WebP、TypeScript、Canvas 2D、Vitest、Playwright

---

### Task 1: 准备视频生成访问

**Files:**
- Create: `scripts/generate-transition-video.py`

**Steps:**

1. 确认 Google Cloud 项目、Vertex AI 权限和结算状态。
2. 安装 `google-genai`。
3. 写入只读取环境变量的生成脚本，不保存凭证。
4. 使用 `public/portraits/00-laoliang.png` 与 `01-xiaoliang.png` 作为首尾帧。
5. 提交脚本。

### Task 2: 生成并验收样片

**Files:**
- Create: `artifacts/transitions/00-06-source.mp4`

**Steps:**

1. 生成固定机位、无动作的首尾帧约束视频。
2. 检查人物身份、眼镜、背景和头部位置。
3. 若出现换脸或镜头运动，只调整一项提示词后重试。
4. 保存通过的原始样片。

### Task 3: 抽取五张中间帧

**Files:**
- Create: `public/frames/frame-00.webp` 到 `frame-06.webp`
- Create: `scripts/extract-transition-frames.sh`

**Steps:**

1. 写抽帧脚本并验证时间点计算。
2. 保留原始端点图作为 `frame-00` 与 `frame-06`。
3. 从样片等距抽取 `frame-01` 到 `frame-05`。
4. 统一 WebP 尺寸、色彩与轻量锐化。
5. 生成七帧接触表并进行视觉检查。

### Task 4: 改为单帧渲染

**Files:**
- Modify: `src/portrait-renderer.test.ts`
- Modify: `src/portrait-renderer.ts`
- Modify: `src/main.ts`

**Steps:**

1. 先写失败测试，要求 `0—6` 映射到七张独立文件。
2. 删除 `fromIndex、toIndex、mix` 渲染状态。
3. 每次清空 Canvas 后只绘制当前等级图片。
4. 运行单元测试与构建。

### Task 5: 浏览器样片验收

**Files:**
- Modify: `tests/slider.spec.ts`

**Steps:**

1. 增加 `0—6` 各等级图片索引测试。
2. 在桌面与手机视口逐级截图。
3. 检查横向溢出与加载状态。
4. 运行 `npm test -- --run && npm run build && npm run test:e2e`。

