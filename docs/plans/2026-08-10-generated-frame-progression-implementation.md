# 独立图片逐帧进化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 生成 25 张中间人物图片，并将网页改为 31 张独立图片逐帧渲染。

**Architecture:** 六张现有图片作为固定锚点，按五个区间逐张生成中间图。渲染器根据整数等级读取同编号图片，Canvas 单次绘制，不使用透明度混合。

**Tech Stack:** Built-in image generation、TypeScript、Canvas 2D、Vitest、Playwright

---

### Task 1: 建立 31 帧目录与提示词清单

1. 创建 `public/frames/`。
2. 复制六张主节点到对应编号。
3. 创建 `docs/frame-prompts.md`，记录 25 张图的变化比例与约束。
4. 提交目录结构与清单。

### Task 2: 生成 `00—12` 中间帧

1. 依次生成 `frame-01` 到 `frame-05`。
2. 依次生成 `frame-07` 到 `frame-11`。
3. 检查神情、眼位、眼镜与肩线。
4. 提交十张图片。

### Task 3: 生成 `12—24` 中间帧

1. 依次生成 `frame-13` 到 `frame-17`。
2. 依次生成 `frame-19` 到 `frame-23`。
3. 检查骨相、服装与身份连续性。
4. 提交十张图片。

### Task 4: 生成 `24—30` 中间帧

1. 依次生成 `frame-25` 到 `frame-29`。
2. 检查背景、帝服、光轮、冕板和珠串数量变化。
3. 生成 31 帧接触表。
4. 提交五张图片。

### Task 5: 改为单帧渲染

1. 先修改测试，要求 31 个路径与等级一一对应，并观察失败。
2. 更新 `src/portrait-renderer.ts`，删除混合状态。
3. 更新加载提示与相关测试。
4. 运行单元测试与构建。
5. 提交渲染改动。

### Task 6: 浏览器验收

1. 更新端到端测试，覆盖 31 帧加载与节点切换。
2. 在桌面与手机视口检查 `0、6、12、18、24、30`。
3. 运行完整测试与构建。
4. 提交最终验收。

