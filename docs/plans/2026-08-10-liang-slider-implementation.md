# 「滑动变祖器」Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建一个可在桌面端与手机端运行的单页互动网页，让同一人物在 31 级滑杆中从「牢梁」连续进化到「梁祖」。

**Architecture:** 使用 Vite、TypeScript 与原生 Canvas。六张对齐的主形态照片放在 `public/portraits/`，滑杆状态交给纯函数计算，Canvas 负责相邻图片叠化与轻量位移。界面层只读取当前等级并更新文字、颜色与无障碍属性。

**Tech Stack:** Vite、TypeScript、Canvas 2D、CSS、Vitest、Playwright

---

### Task 1: 建立项目与测试入口

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/styles.css`
- Create: `src/vite-env.d.ts`

**Step 1: 创建最小 Vite 配置**

在 `package.json` 中加入 `dev`、`build`、`preview`、`test` 与 `test:e2e` 命令。运行依赖只使用 Vite，测试依赖使用 Vitest 与 Playwright。

**Step 2: 创建最小页面入口**

`index.html` 只保留应用挂载节点与基础元信息。`src/main.ts` 暂时渲染项目名称，`src/styles.css` 写入基础重置。

**Step 3: 安装依赖并运行构建**

Run: `npm install`

Expected: 生成 `node_modules/` 与 `package-lock.json`。

Run: `npm run build`

Expected: Vite 构建成功并生成 `dist/`。

**Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json index.html src
git commit -m "chore: scaffold liang slider app"
```

### Task 2: 实现 31 级状态模型

**Files:**
- Create: `src/progression.ts`
- Create: `src/progression.test.ts`

**Step 1: 写失败测试**

覆盖以下行为：

```ts
expect(getProgression(0)).toMatchObject({ stage: "牢梁", fromIndex: 0, toIndex: 1, localProgress: 0 });
expect(getProgression(5)).toMatchObject({ stage: "牢梁", fromIndex: 0, toIndex: 1 });
expect(getProgression(6)).toMatchObject({ stage: "小梁", fromIndex: 1, toIndex: 2, localProgress: 0 });
expect(getProgression(30)).toMatchObject({ stage: "梁祖", fromIndex: 5, toIndex: 5, localProgress: 0 });
expect(getProgression(-3).level).toBe(0);
expect(getProgression(40).level).toBe(30);
```

**Step 2: 运行测试并确认失败**

Run: `npm test -- --run src/progression.test.ts`

Expected: FAIL，原因是 `getProgression` 尚未定义。

**Step 3: 实现最小状态模型**

导出：

```ts
export const STAGES = ["牢梁", "小梁", "梁子", "梁圣", "梁神", "梁祖"] as const;
export const MAX_LEVEL = 30;
export const LEVELS_PER_STAGE = 6;
export function getProgression(rawLevel: number): ProgressionState;
```

`getProgression` 负责限制范围、计算当前文字节点、相邻图片索引与 `0—1` 的局部进度。

**Step 4: 运行测试并确认通过**

Run: `npm test -- --run src/progression.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/progression.ts src/progression.test.ts
git commit -m "feat: add 31-level progression model"
```

### Task 3: 生成并整理六张主形态照片

**Files:**
- Create: `public/portraits/00-laoliang.png`
- Create: `public/portraits/01-xiaoliang.png`
- Create: `public/portraits/02-liangzi.png`
- Create: `public/portraits/03-liangsheng.png`
- Create: `public/portraits/04-liangshen.png`
- Create: `public/portraits/05-liangzu.png`
- Create: `docs/image-prompts.md`

**Step 1: 记录统一生成约束**

在 `docs/image-prompts.md` 记录六条最终提示词。三张用户图片标记为身份与阶段参考图，统一要求正脸、1:1、同机位、同眼位、同肩线、无文字、无水印。

**Step 2: 生成基准形态**

先生成「梁子」作为身份基准，检查眼睛、鼻形、发际线、眼镜与第二张参考图的一致性。

**Step 3: 生成低阶形态**

从身份基准生成「牢梁」和「小梁」。重点检查「牢梁」的卑微、畏缩与讨好感，以及「小梁」轻微不愉快的眉眼和嘴角。

**Step 4: 生成高阶形态**

生成「梁圣」「梁神」「梁祖」。逐步增强下颌、眉骨、肩宽与服装。「梁祖」必须出现黑红帝服、冕冠和可辨认的珠串冕旒。

**Step 5: 统一画幅**

将最终图片保存为相同像素尺寸。检查眼睛高度、鼻尖位置和肩线偏差；必要时只做裁切与缩放校正，不改动人物内容。

**Step 6: Commit**

```bash
git add public/portraits docs/image-prompts.md
git commit -m "feat: add liang progression portraits"
```

### Task 4: 实现头像加载与 Canvas 混合

**Files:**
- Create: `src/portrait-renderer.ts`
- Create: `src/portrait-renderer.test.ts`

**Step 1: 写失败测试**

测试图片路径映射与绘制帧选择：

```ts
expect(PORTRAIT_PATHS).toHaveLength(6);
expect(getRenderFrame(0)).toEqual({ fromIndex: 0, toIndex: 1, mix: 0 });
expect(getRenderFrame(9)).toMatchObject({ fromIndex: 1, toIndex: 2, mix: 0.5 });
expect(getRenderFrame(30)).toEqual({ fromIndex: 5, toIndex: 5, mix: 0 });
```

**Step 2: 运行测试并确认失败**

Run: `npm test -- --run src/portrait-renderer.test.ts`

Expected: FAIL，原因是渲染模块尚未创建。

**Step 3: 实现图片预载与绘制**

`preloadPortraits` 返回六张已解码图片。`drawPortrait` 清空 Canvas，按封面裁切绘制前后两张图，并使用平滑曲线控制透明度、轻微缩放和纵向位移。

绘制约束：

- 低阶缩放约为 `0.98`，高阶逐步到 `1.04`。
- 叠化曲线使用 `mix * mix * (3 - 2 * mix)`。
- 每帧只执行两次 `drawImage`，不读取像素数据。

**Step 4: 运行测试并确认通过**

Run: `npm test -- --run src/portrait-renderer.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add src/portrait-renderer.ts src/portrait-renderer.test.ts
git commit -m "feat: add canvas portrait renderer"
```

### Task 5: 完成主界面与输入控制

**Files:**
- Modify: `src/main.ts`
- Modify: `src/styles.css`
- Create: `src/app.ts`
- Create: `src/app.test.ts`

**Step 1: 写失败测试**

使用 DOM 测试覆盖：滑杆范围为 `0—30`、初始文字是「牢梁」、输入到 `24` 后文字为「梁神」、`aria-valuetext` 与视觉文字一致。

**Step 2: 运行测试并确认失败**

Run: `npm test -- --run src/app.test.ts`

Expected: FAIL，原因是应用界面尚未创建。

**Step 3: 实现界面骨架**

渲染标题、等级读数、人物 Canvas、巨大背景状态字、当前状态文字、31 个刻度与原生 `range` 输入。隐藏原生滑杆外观后，保留其语义与键盘能力。

**Step 4: 实现视觉进化**

通过 CSS 自定义属性 `--strength`、`--stage-color` 和 `--halo-opacity` 驱动背景、刻度、光轮与文字变化。「梁祖」阶段允许帝冕图片内容突破视觉安全框，Canvas 本身仍保持固定布局。

**Step 5: 实现加载与错误状态**

图片全部解码前禁用滑杆并显示加载读数。加载失败时显示「图像加载失败，请刷新重试」，Canvas 保留人物轮廓占位。

**Step 6: 运行测试并确认通过**

Run: `npm test -- --run src/app.test.ts`

Expected: PASS。

**Step 7: Commit**

```bash
git add src/main.ts src/styles.css src/app.ts src/app.test.ts
git commit -m "feat: build interactive liang strength interface"
```

### Task 6: 响应式、动效与无障碍收尾

**Files:**
- Modify: `src/styles.css`
- Modify: `src/app.ts`

**Step 1: 加入移动端布局**

在 `760px` 以下缩小标题与头像，调整刻度标签避免互相覆盖。滑杆触摸区域不少于 `44px` 高。

**Step 2: 加入减少动态效果模式**

在 `prefers-reduced-motion: reduce` 下关闭状态字冲击、光轮呼吸和加载动画，保留头像叠化。

**Step 3: 检查焦点与对比度**

滑杆获得键盘焦点时显示清晰轮廓。低阶灰色文字与背景保持可读对比度，高阶金色只用于大字和装饰。

**Step 4: Build**

Run: `npm run build`

Expected: TypeScript 检查与 Vite 构建成功。

**Step 5: Commit**

```bash
git add src/styles.css src/app.ts
git commit -m "style: refine responsive motion and accessibility"
```

### Task 7: 浏览器验收与最终修正

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/slider.spec.ts`
- Modify: `src/styles.css`
- Modify: `src/app.ts`

**Step 1: 写端到端测试**

覆盖页面加载、滑杆键盘控制、六个主节点文字、31 级范围与移动端视口。

**Step 2: 运行端到端测试**

Run: `npm run test:e2e`

Expected: 桌面与移动端用例全部 PASS。

**Step 3: 截图检查**

分别截取 `0、6、12、18、24、30` 六个等级。检查头像中心、标签、帝冕裁切、珠帘可见度和移动端布局。

**Step 4: 执行最终测试**

Run: `npm test -- --run && npm run build && npm run test:e2e`

Expected: 单元测试、构建与端到端测试全部通过。

**Step 5: Commit**

```bash
git add playwright.config.ts tests src
git commit -m "test: verify liang slider experience"
```

