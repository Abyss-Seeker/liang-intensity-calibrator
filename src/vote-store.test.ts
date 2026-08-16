import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_DAILY_VOTES_PER_IP,
  VoteRepository,
  parseLegacyEvents,
  utcDay,
} from "./vote-store";
import { TestStorage } from "./test-sqlite-storage";

const storages: TestStorage[] = [];

function makeRepository(): VoteRepository {
  const storage = new TestStorage();
  storages.push(storage);
  return new VoteRepository(storage);
}

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
});

describe("VoteRepository", () => {
  it("用同一事务写入每日身份与事件，同一身份同一天最多一票", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);

    const first = repository.castVote({
      eventId: "event-1",
      now,
      direction: "up",
      voterHash: "voter-a",
      ipHash: "ip-a",
    });
    const second = repository.castVote({
      eventId: "event-2",
      now: now + 1,
      direction: "down",
      voterHash: "voter-a",
      ipHash: "ip-a",
    });

    expect(first).toEqual({
      status: "accepted",
      direction: "up",
      maintenanceRan: true,
    });
    expect(second).toEqual({ status: "duplicate", direction: "up" });
    expect(repository.eventsForTally(now + 1)).toEqual([
      { t: now, d: "up" },
    ]);
  });

  it("同一身份的 12 个竞争写入最终只保留一票", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);

    const results = Array.from({ length: 12 }, (_, index) =>
      repository.castVote({
        eventId: `event-${index}`,
        now: now + index,
        direction: "up",
        voterHash: "same-voter",
        ipHash: "same-ip",
      }),
    );

    expect(results.filter((result) => result.status === "accepted")).toHaveLength(
      1,
    );
    expect(repository.eventsForTally(now + 20)).toHaveLength(1);
  });

  it("不同身份的写入不会像 KV 全数组读改写那样互相覆盖", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);

    for (let index = 0; index < 50; index += 1) {
      const result = repository.castVote({
        eventId: `event-${index}`,
        now: now + index,
        direction: index % 2 === 0 ? "up" : "down",
        voterHash: `voter-${index}`,
        ipHash: `ip-${index}`,
      });
      expect(result.status).toBe("accepted");
    }

    expect(repository.eventsForTally(now + 100)).toHaveLength(50);
  });

  it("共享 IP 达到每日上限后拒绝新匿名身份", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);

    for (let index = 0; index < MAX_DAILY_VOTES_PER_IP; index += 1) {
      expect(
        repository.castVote({
          eventId: `event-${index}`,
          now: now + index,
          direction: "up",
          voterHash: `voter-${index}`,
          ipHash: "shared-ip",
        }).status,
      ).toBe("accepted");
    }

    expect(
      repository.castVote({
        eventId: "one-too-many",
        now: now + MAX_DAILY_VOTES_PER_IP,
        direction: "up",
        voterHash: "new-voter",
        ipHash: "shared-ip",
      }),
    ).toEqual({ status: "ip_limit", direction: null });
  });

  it("IP 日计数独立于事件保留与裁剪", () => {
    const storage = new TestStorage();
    storages.push(storage);
    const repository = new VoteRepository(storage);
    const now = Date.UTC(2026, 7, 16, 12);

    for (let index = 0; index < MAX_DAILY_VOTES_PER_IP; index += 1) {
      repository.castVote({
        eventId: `event-${index}`,
        now: now + index,
        direction: "up",
        voterHash: `voter-${index}`,
        ipHash: "shared-ip",
      });
    }
    storage.sql.exec("DELETE FROM vote_events");

    expect(
      repository.castVote({
        eventId: "event-after-trim",
        now: now + 100,
        direction: "up",
        voterHash: "new-voter",
        ipHash: "shared-ip",
      }).status,
    ).toBe("ip_limit");
  });

  it("事件写入冲突时回滚身份与 IP 计数", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);
    repository.castVote({
      eventId: "same-id",
      now,
      direction: "up",
      voterHash: "voter-a",
      ipHash: "ip-a",
    });

    expect(() =>
      repository.castVote({
        eventId: "same-id",
        now: now + 1,
        direction: "down",
        voterHash: "voter-b",
        ipHash: "ip-b",
      }),
    ).toThrow();
    expect(
      repository.castVote({
        eventId: "retry-id",
        now: now + 2,
        direction: "down",
        voterHash: "voter-b",
        ipHash: "ip-b",
      }).status,
    ).toBe("accepted");
  });

  it("旧 KV 事件只导入一次", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);
    const legacy = [
      { t: now - 2_000, d: "up" as const },
      { t: now - 1_000, d: "down" as const },
    ];

    expect(repository.legacyImported()).toBe(false);
    repository.importLegacy(legacy, now, "source-a");
    repository.importLegacy(legacy, now, "source-a");

    expect(repository.legacyImported()).toBe(true);
    expect(repository.eventsForTally(now)).toEqual(legacy);
  });

  it("迁移旧 KV 时丢弃保留期外和未来事件", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);
    const insideRetention = { t: now - 1_000, d: "up" as const };

    repository.importLegacy(
      [
        { t: now - 366 * 24 * 60 * 60 * 1_000, d: "down" },
        insideRetention,
        { t: now + 1, d: "up" },
      ],
      now,
      "source-retention",
    );

    expect(repository.eventCount()).toBe(1);
    expect(repository.eventsForTally(now)).toEqual([insideRetention]);
  });

  it("来源哈希变化时精确重建 legacy 子集并更新核对信息", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);
    repository.importLegacy([{ t: now - 2, d: "up" }], now, "hash-a");
    repository.importLegacy(
      [
        { t: now - 2, d: "up" },
        { t: now - 1, d: "down" },
      ],
      now,
      "hash-b",
    );

    expect(repository.legacyImportState()).toEqual({
      sourceHash: "hash-b",
      sourceCount: 2,
      retainedCount: 2,
      status: "pending",
    });
    expect(repository.eventCount()).toBe(2);
  });

  it(
    "用批量 SQL 导入旧 KV 的 100000 条上限并完成计数核对",
    () => {
      const repository = makeRepository();
      const now = Date.UTC(2026, 7, 16, 12);
      const legacy = Array.from({ length: 100_000 }, (_, index) => ({
        t: now - (100_000 - index),
        d: index % 2 === 0 ? ("up" as const) : ("down" as const),
      }));

      expect(repository.importLegacy(legacy, now, "max-source")).toBe(true);
      expect(repository.eventCount()).toBe(100_000);
      expect(repository.legacyImportState()?.retainedCount).toBe(100_000);
    },
    30_000,
  );

  it("严格拒绝非数组或含损坏成员的旧 KV", () => {
    expect(() => parseLegacyEvents({})).toThrow("必须是 JSON 数组");
    expect(() => parseLegacyEvents([{ t: 1, d: "sideways" }])).toThrow(
      "events[0] 格式无效",
    );
  });

  it("最近事件查询有硬上限且按时间升序返回", () => {
    const repository = makeRepository();
    const now = Date.UTC(2026, 7, 16, 12);

    for (let index = 0; index < 6; index += 1) {
      repository.castVote({
        eventId: `event-${index}`,
        now: now + index,
        direction: "up",
        voterHash: `voter-${index}`,
        ipHash: `ip-${index}`,
      });
    }

    expect(repository.recentEvents(now + 10, 3).map((event) => event.t)).toEqual([
      now + 3,
      now + 4,
      now + 5,
    ]);
    expect(repository.eventCount()).toBe(6);
  });

  it("UTC 日期键不受客户端时区影响", () => {
    expect(utcDay(Date.UTC(2026, 7, 16, 23, 59, 59))).toBe("2026-08-16");
    expect(utcDay(Date.UTC(2026, 7, 17, 0, 0, 0))).toBe("2026-08-17");
  });
});
