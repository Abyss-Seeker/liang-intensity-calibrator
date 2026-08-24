# 贡献者

## yzke

**贡献：** 对社区投票系统进行了系统性安全审查，发现并报告了多个关键漏洞
（PR #1：*fix: harden community vote storage and migration*）：

- **客户端可控 `resetAt` 无限刷票**：`voted:{IP}` 键的 TTL 由客户端提交的
  `resetAt` 决定，攻击者可将其设为"当前时间 + 1 秒"，使每日一票限制
  1 秒后即失效，从而同一 IP 无限刷票。
- **KV 并发读改写竞态（TOCTOU）**：并发请求下事件流可能丢票或重复计票。
- **跨站简单请求可触发投票写入**：无需 CORS 预检的 `text/plain` POST
  即可向 `/api/vote` 写入投票。
- **KV 免费版写配额放大**：每票两次写入，免费版每日 1000 次写额度
  在高流量下被快速耗尽（2026-08-14 事故）。

**采纳情况：** 本仓库已基于其思路落地"服务端固定 TTL（北京时间午夜重置）"
修复（commit 见 git log），彻底堵住 `resetAt` 无限刷票路径，并补充了
回归测试。其提出的完整加固方案（SQLite Durable Object 事务化存储、
HttpOnly Cookie 匿名身份、请求校验与限流、KV 历史迁移）见 PR #1，
目前暂缓合并，后续评估。
