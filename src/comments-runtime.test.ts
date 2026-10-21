import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("真实 Workers/SQLite DO 并发请求不丢票，同 IP 并发发布只接受一次", async () => {
  const mf = new Miniflare({
    modules: true, scriptPath: resolve("dist/server/index.js"),
    compatibilityDate: "2026-08-08",
    durableObjects: { COMMENTS: { className: "Comments", useSQLite: true } },
    kvNamespaces: ["VOTES"],
  });
  try {
    const forged = await mf.dispatchFetch("http://localhost/api/comments", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Local-Comment-IP": "192.0.2.254" }, body: JSON.stringify({ body: "伪造开发来源" }),
    });
    expect(forged.status).toBe(403);
    const post = (path: string, body: unknown, ip: string) => mf.dispatchFetch(`http://localhost/api/comments${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body),
    });
    const publications = await Promise.all(Array.from({ length: 8 }, () => post("", { body: "并发测试" }, "192.0.2.1")));
    expect(publications.filter(r => r.status === 201)).toHaveLength(1);
    expect(publications.filter(r => r.status === 429)).toHaveLength(7);
    const { comment } = await publications.find(r => r.status === 201)!.json() as any;
    const votes = await Promise.all(Array.from({ length: 24 }, (_, i) => post(`/${comment.id}/vote`, { direction: "up" }, `192.0.2.${i + 2}`)));
    expect(votes.every(r => r.status === 200)).toBe(true);
    await Promise.all(Array.from({ length: 8 }, () => post(`/${comment.id}/vote`, { direction: "down" }, "192.0.2.2")));
    const response = await mf.dispatchFetch("http://localhost/api/comments", { headers: { "CF-Connecting-IP": "192.0.2.2" } });
    const data = await response.json() as any;
    expect(data.comments[0]).toMatchObject({ up: 23, down: 1, score: 22, myVote: "down" });
  } finally { await mf.dispose(); }
}, 30000);
