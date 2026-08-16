import { env } from "cloudflare:workers";
import {
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

function request(
  method: "GET" | "POST",
  voter = "worker-voter-0001",
): Request {
  return new Request("https://example.com/api/vote", {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Liang-Voter-Id": voter,
      "X-Liang-Client-IP": "198.51.100.20",
    },
    body: method === "POST" ? JSON.stringify({ direction: "up" }) : null,
  });
}

function stub(name: string) {
  const id = env.VOTE_COORDINATOR.idFromName(name);
  return env.VOTE_COORDINATOR.get(id);
}

describe("VoteCoordinator in workerd", () => {
  it("用单个 JSON 参数迁移超过平台绑定上限的事件批次", async () => {
    const now = Date.now();
    const legacy = Array.from({ length: 1_001 }, (_, index) => ({
      t: now - (1_001 - index) * 1_000,
      d: index % 2 === 0 ? "up" : "down",
    }));
    await env.VOTES.put("events", JSON.stringify(legacy));

    const response = await stub("json-batch-migration").fetch(request("GET"));
    const data = (await response.json()) as {
      totalEvents: number;
      events: unknown[];
    };
    expect(response.status).toBe(200);
    expect(data.totalEvents).toBe(1_001);
    expect(data.events).toHaveLength(1_000);
  });

  it("Alarm 核对稳定后持久化 finalized 并停止调度", async () => {
    await env.VOTES.put("events", "[]");
    const coordinator = stub("finalized-migration");
    expect((await coordinator.fetch(request("GET"))).status).toBe(200);
    expect(await runDurableObjectAlarm(coordinator)).toBe(true);

    await runInDurableObject(coordinator, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM vote_metadata WHERE key = ?",
          "legacy_imported",
        )
        .one();
      expect(JSON.parse(row.value)).toMatchObject({ status: "finalized" });
    });
    expect(await runDurableObjectAlarm(coordinator)).toBe(false);
  });

  it("真实 Durable Object 并发门控下同一身份只产生一票", async () => {
    await env.VOTES.put("events", "[]");
    const coordinator = stub("concurrent-vote");
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        coordinator.fetch(request("POST", "same-worker-voter")),
      ),
    );
    const data = (await (
      await coordinator.fetch(request("GET", "same-worker-voter"))
    ).json()) as { totalEvents: number };

    expect(responses.filter((response) => response.status === 200)).toHaveLength(
      5,
    );
    expect(responses.filter((response) => response.status === 429)).toHaveLength(
      7,
    );
    expect(data.totalEvents).toBe(1);
  });
});
