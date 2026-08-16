import type { DurableObjectState } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestStorage } from "./test-sqlite-storage";
import { VoteCoordinator } from "./vote-coordinator";

const storages: TestStorage[] = [];

function makeCoordinator(initialRaw: string | null = "[]") {
  const storage = new TestStorage();
  storages.push(storage);
  let raw = initialRaw;
  let getCalls = 0;
  const ctx = {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
  const env = {
    VOTES: {
      get: () => {
        getCalls += 1;
        return Promise.resolve(raw);
      },
    },
  };
  const coordinator = new VoteCoordinator(ctx, env);
  return {
    coordinator,
    ctx,
    env,
    storage,
    getCalls: () => getCalls,
    setRaw(value: string | null) {
      raw = value;
    },
  };
}

function request(
  method: "GET" | "POST",
  options: {
    voter?: string;
    ip?: string;
    contentType?: string;
    body?: string;
  } = {},
): Request {
  const headers = new Headers({
    "X-Liang-Voter-Id": options.voter ?? "voter-identity-0001",
    "X-Liang-Client-IP": options.ip ?? "198.51.100.10",
  });
  if (method === "POST") {
    headers.set("Content-Type", options.contentType ?? "application/json");
  }
  return new Request("https://example.com/api/vote", {
    method,
    headers,
    body: method === "POST" ? (options.body ?? '{"direction":"up"}') : null,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of storages.splice(0)) storage.close();
});

describe("VoteCoordinator", () => {
  it("经真实协调器并发提交时同一身份只写入一票", async () => {
    const { coordinator } = makeCoordinator();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => coordinator.fetch(request("POST"))),
    );
    const snapshot = (await (
      await coordinator.fetch(request("GET"))
    ).json()) as { totalEvents: number; voted: boolean };

    expect(responses.filter((response) => response.status === 200)).toHaveLength(
      5,
    );
    expect(responses.filter((response) => response.status === 429)).toHaveLength(
      7,
    );
    expect(snapshot.totalEvents).toBe(1);
    expect(snapshot.voted).toBe(true);
  });

  it("异常请求也先计入限流，且超大请求体被拒绝", async () => {
    const { coordinator } = makeCoordinator();
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      statuses.push(
        (
          await coordinator.fetch(
            request("POST", { contentType: "text/plain", body: "{}" }),
          )
        ).status,
      );
    }
    expect(statuses).toEqual([415, 415, 415, 415, 415, 429]);

    const other = makeCoordinator();
    const oversized = await other.coordinator.fetch(
      request("POST", {
        ip: "198.51.100.11",
        body: JSON.stringify({ direction: "up", padding: "x".repeat(2_000) }),
      }),
    );
    expect(oversized.status).toBe(413);
  });

  it("公开事件硬截断为 1000 条并降为分钟精度", async () => {
    const now = Date.now();
    const legacy = Array.from({ length: 1_001 }, (_, index) => ({
      t: now - (1_001 - index) * 1_001,
      d: index % 2 === 0 ? ("up" as const) : ("down" as const),
    }));
    const { coordinator } = makeCoordinator(JSON.stringify(legacy));
    const response = await coordinator.fetch(request("GET"));
    const data = (await response.json()) as {
      events: Array<{ t: number }>;
      eventsTruncated: boolean;
      totalEvents: number;
    };

    expect(data.events).toHaveLength(1_000);
    expect(data.events.every((event) => event.t % 60_000 === 0)).toBe(true);
    expect(data.eventsTruncated).toBe(true);
    expect(data.totalEvents).toBe(1_001);
  });

  it("同一维护周期内的后续成功票增量更新缓存，不再全量读取事件", async () => {
    const { coordinator, storage } = makeCoordinator();
    await coordinator.fetch(request("GET"));
    await coordinator.fetch(request("POST", { voter: "voter-one-000001" }));
    const tallyReadsAfterFirst = storage.executedQueries.filter((query) =>
      query.includes("WHERE t >= ? AND t <= ?"),
    ).length;

    const second = await coordinator.fetch(
      request("POST", { voter: "voter-two-000002" }),
    );
    const tallyReadsAfterSecond = storage.executedQueries.filter((query) =>
      query.includes("WHERE t >= ? AND t <= ?"),
    ).length;
    const data = (await second.json()) as { totalEvents: number };

    expect(second.status).toBe(200);
    expect(data.totalEvents).toBe(2);
    expect(tallyReadsAfterSecond).toBe(tallyReadsAfterFirst);
  });

  it("迁移后用 alarm 再核对来源变化，不会永久确认不完整快照", async () => {
    const now = Date.now();
    const first = JSON.stringify([{ t: now - 2_000, d: "up" }]);
    const second = JSON.stringify([
      { t: now - 2_000, d: "up" },
      { t: now - 1_000, d: "down" },
    ]);
    const { coordinator, ctx, env, getCalls, setRaw, storage } =
      makeCoordinator(first);
    await coordinator.fetch(request("GET"));
    expect(storage.scheduledAlarms).toHaveLength(1);
    expect(getCalls()).toBe(1);

    setRaw(second);
    await coordinator.alarm();
    const data = (await (
      await coordinator.fetch(request("GET"))
    ).json()) as { totalEvents: number };
    expect(data.totalEvents).toBe(2);
    expect(storage.scheduledAlarms).toHaveLength(2);

    await coordinator.alarm();
    const state = JSON.parse(
      String(
        storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM vote_metadata WHERE key = ?",
            "legacy_imported",
          )
          .toArray()[0]?.value,
      ),
    ) as { status: string };
    expect(state.status).toBe("finalized");
    expect(storage.scheduledAlarms).toHaveLength(2);

    const restarted = new VoteCoordinator(ctx, env);
    await restarted.fetch(request("GET"));
    expect(getCalls()).toBe(3);
  });

  it("Alarm 临时读取失败时显式重新调度", async () => {
    const now = Date.now();
    const { coordinator, setRaw, storage } = makeCoordinator(
      JSON.stringify([{ t: now - 1_000, d: "up" }]),
    );
    await coordinator.fetch(request("GET"));
    setRaw(null);

    await expect(coordinator.alarm()).rejects.toThrow("events 不存在");
    expect(storage.scheduledAlarms).toHaveLength(2);
  });

  it("KV 缺失或损坏时 fail-closed，不写入已迁移标记", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const raw of [null, "{}", '[{"t":1,"d":"sideways"}]']) {
      const { coordinator, storage } = makeCoordinator(raw);
      const response = await coordinator.fetch(request("GET"));
      expect(response.status).toBe(503);
      const marker = storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM vote_metadata WHERE key = ?",
          "legacy_imported",
        )
        .toArray()[0]?.count;
      expect(Number(marker ?? 0)).toBe(0);
    }
  });
});
