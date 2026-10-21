# 最近三日匿名评论

全站共用一个评论区，位于社区投票下方。无需注册或昵称，作者统一显示“匿名”。

- 时间范围为服务端当前时间往前滚动 72 小时。到期内容及对应赞踩从业务存储中删除，客户端打开期间也会移除到期评论。
- 每条 1–500 个 Unicode 码点，去除首尾空白，仅作纯文本展示。不支持 HTML、Markdown、回复、编辑或作者删除。
- 同一 IP 每 5 分钟最多发布一条，滚动 24 小时最多 5 条。拒绝时返回 `429`、`Retry-After` 和 `retryAt`。
- 每个 IP 对每条评论最多保留一票，赞踩互斥，可以撤销或改票。共享公网出口的访客共享额度和投票；这不是一人一票身份验证。
- 默认热门按 `赞数 - 踩数` 降序，同分时新评论优先，再按 ID 确定顺序；也可切换最新。每页 20 条，支持翻页和手动刷新。动态排序下翻页结果可能随他人投票变化。
- 点赞成功仅更新按钮、票数、排序和状态提示，不播放特效。

## 存储与部署

评论使用独立的 SQLite Durable Object `Comments`，绑定名 `COMMENTS`，迁移标签 `comments-v1`。评论、限频和赞踩计数在同一个对象内事务更新，保留现有 `VOTES` KV 社区强度投票的行为。无需手工创建 D1 数据库或设置新的密钥。

`wrangler.json` 已包含绑定及 `new_sqlite_classes` 迁移。部署时使用包含这些配置和 `Comments` 导出的完整 Workers 构建：

```sh
npm ci
npm run build
npm test -- --run
npx wrangler deploy --config dist/wrangler.json
```

首次部署会创建新的 DO 命名空间。不要删除已发布的迁移标签。此功能尚需由站点维护者发布到 Cloudflare；本地验证不代表线上部署成功。GitHub Pages 是纯静态产物，会明确显示评论未开放并禁用输入，不向不存在的后端提交。

使用受 Cloudflare 提供的 `CF-Connecting-IP` 标识访问者。写请求缺失该头时拒绝执行；直接暴露自行反向代理时必须确保该头不能被访客伪造。应用持久化的是使用对象内部随机密钥生成的 HMAC，不存原始 IP，API 也不返回该标识；公开匿名不等于不可关联。站点基础设施的访问日志不属于此模块的存储。

本地 `npm run dev` 不经过 Cloudflare 边缘。Vite 开发中间件仅对评论接口使用真实 TCP 连接地址补充来源头，并覆盖客户端自行传入的同名头。该中间件不进入生产 Worker，线上缺失来源头仍拒绝写入。本机多个浏览器共享本地 IP 的发布及投票额度。

到期清理由 Durable Object alarm 触发，请求时也会检查并清理。alarm 可能延迟或重试，因此业务接口始终按服务端时间排除过期评论。发布限频记录保留 24 小时，赞踩标识随评论到期清理。删除范围是当前业务存储，Cloudflare 平台备份／恢复窗口仍遵循平台策略。

## API

所有响应为 JSON，设置 `Cache-Control: no-store`，避免缓存当前 IP 的投票状态。POST 只接受 `application/json`，拒绝跨站浏览器提交，限制请求体为 4096 字节。

| 请求 | 行为 |
| --- | --- |
| `GET /api/comments?sort=hot&offset=0` | 返回 `comments`、`hasMore`、`serverTime`；`sort` 可为 `hot` 或 `new` |
| `POST /api/comments`，`{"body":"留言"}` | 返回 `201` 和新 `comment` |
| `POST /api/comments/:id/vote`，`{"direction":"up"}` | 点赞，`down` 点踩，`null` 撤销；同方向重复请求幂等 |

过期或不存在的评论返回 `404`，非法内容 `400`，非 JSON `415`，超大请求 `413`，存储未配置或不可用 `503`。此模块提供基本限频和纯文本保护，不包含人工审核、举报或完整反滥用系统。

## 验证

`npm run build` 必须在 `npm test -- --run` 之前执行，因为已有测试和运行时集成测试会读取构建后的 Worker。测试使用 Node.js 22.13+ 的 `node:sqlite` 和 Miniflare，覆盖时间边界、真实 SQL 清理、发布额度、赞踩幂等、排序、分页、请求边界以及 Workers 运行时并发请求。

`npm run test:e2e` 覆盖桌面和手机视口。评论 UI 用受控 API 响应验证纯文本、草稿保留、键盘焦点、排序、赞踩、到期和错误状态；另有一次浏览器直连本地后端的发布、赞踩、刷新及伪造来源限频回归，不拦截 API。由于两种视口共用同一 IP，该真实发布流程只运行一次。实际后端并发行为由 Miniflare 集成测试覆盖。E2E 服务使用 `e2e` 模式和临时存储，不复用普通预览服务或消耗其额度。可通过 `PLAYWRIGHT_EXECUTABLE_PATH` 使用系统 Chromium 浏览器，通过 `COMMENTS_SCREENSHOT_DIR` 将截图保存到仓库之外。

平台依据：[SQLite 存储与事务](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)。
