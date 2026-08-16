export interface VoteEvent {
  t: number;
  d: "up" | "down";
}

export interface SqlCursorLike<T extends Record<string, unknown>> {
  readonly rowsWritten: number;
  toArray(): T[];
}

export interface SqlStorageLike {
  exec<T extends Record<string, unknown>>(
    query: string,
    ...bindings: Array<string | number | null>
  ): SqlCursorLike<T>;
}

export interface TransactionalStorageLike {
  readonly sql: SqlStorageLike;
  transactionSync<T>(callback: () => T): T;
}

export interface CastVoteInput {
  eventId: string;
  now: number;
  direction: "up" | "down";
  voterHash: string;
  ipHash: string;
}

export type CastVoteResult =
  | {
      status: "accepted";
      direction: "up" | "down";
      maintenanceRan: boolean;
    }
  | { status: "duplicate"; direction: "up" | "down" }
  | { status: "ip_limit"; direction: null };

export interface LegacyImportState {
  sourceHash: string;
  sourceCount: number;
  retainedCount: number;
  status: "pending" | "finalized";
}

interface DirectionRow extends Record<string, unknown> {
  direction: "up" | "down";
}

interface CountRow extends Record<string, unknown> {
  count: number;
}

interface EventRow extends Record<string, unknown> {
  t: number;
  d: "up" | "down";
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const EVENTS_MAX = 100_000;

// 匿名 cookie 是主要身份；IP 只作为共享网络上的宽松滥用上限，避免 CGNAT
// 继续保持“一整个出口 IP 只能一票”的误伤。
export const MAX_DAILY_VOTES_PER_IP = 20;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function isVoteEvent(value: unknown): value is VoteEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as { t?: unknown; d?: unknown };
  return (
    typeof event.t === "number" &&
    Number.isFinite(event.t) &&
    (event.d === "up" || event.d === "down")
  );
}

export function parseLegacyEvents(value: unknown): VoteEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("旧 KV events 必须是 JSON 数组");
  }
  value.forEach((event, index) => {
    if (!isVoteEvent(event)) {
      throw new Error(`旧 KV events[${index}] 格式无效`);
    }
  });
  return value as VoteEvent[];
}

export class VoteRepository {
  constructor(private readonly storage: TransactionalStorageLike) {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS vote_events (
        id TEXT PRIMARY KEY,
        t INTEGER NOT NULL,
        d TEXT NOT NULL CHECK (d IN ('up', 'down')),
        day TEXT NOT NULL,
        ip_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS vote_events_t ON vote_events(t);
      CREATE TABLE IF NOT EXISTS daily_voters (
        day TEXT NOT NULL,
        voter_hash TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
        PRIMARY KEY (day, voter_hash)
      );
      CREATE TABLE IF NOT EXISTS daily_ip_counts (
        day TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        count INTEGER NOT NULL CHECK (count >= 0),
        PRIMARY KEY (day, ip_hash)
      );
      CREATE TABLE IF NOT EXISTS vote_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  legacyImported(): boolean {
    return this.legacyImportState() !== null;
  }

  legacyImportState(): LegacyImportState | null {
    const value = this.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM vote_metadata WHERE key = ? LIMIT 1",
        "legacy_imported",
      )
      .toArray()[0]?.value;
    if (!value) return null;
    try {
      const state = JSON.parse(value) as Partial<LegacyImportState>;
      if (
        typeof state.sourceHash === "string" &&
        Number.isInteger(state.sourceCount) &&
        Number.isInteger(state.retainedCount) &&
        (state.status === "pending" || state.status === "finalized")
      ) {
        return state as LegacyImportState;
      }
    } catch {
      // 旧的布尔/计数标记不能证明来源一致，强制重新核对 KV。
    }
    return null;
  }

  getOrCreateAbuseSecret(candidate: string): string {
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO vote_metadata (key, value) VALUES (?, ?)",
      "abuse_secret",
      candidate,
    );
    const value = this.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM vote_metadata WHERE key = ? LIMIT 1",
        "abuse_secret",
      )
      .toArray()[0]?.value;
    if (!value) throw new Error("无法初始化匿名网络摘要密钥");
    return value;
  }

  importLegacy(
    events: VoteEvent[],
    now: number,
    sourceHash: string,
  ): boolean {
    if (this.legacyImportState()?.sourceHash === sourceHash) return false;
    const retentionCutoff = now - RETENTION_MS;
    const retainedEvents = events
      .filter((event) => event.t >= retentionCutoff && event.t <= now)
      .sort((left, right) => left.t - right.t)
      .slice(-EVENTS_MAX);
    const state: LegacyImportState = {
      sourceHash,
      sourceCount: events.length,
      retainedCount: retainedEvents.length,
      status: "pending",
    };

    this.storage.transactionSync(() => {
      if (this.legacyImportState()?.sourceHash === sourceHash) return;
      // 来源变化时精确重建 legacy 子集；DO 接收的新票使用 UUID，不受影响。
      this.storage.sql.exec("DELETE FROM vote_events WHERE id LIKE 'legacy:%'");
      const chunkSize = 500;
      for (let offset = 0; offset < retainedEvents.length; offset += chunkSize) {
        const chunk = retainedEvents.slice(offset, offset + chunkSize);
        const rows = JSON.stringify(
          chunk.map((event, index) => ({
            id: `legacy:${offset + index}:${event.t}:${event.d}`,
            t: event.t,
            d: event.d,
            day: utcDay(event.t),
          })),
        );
        this.storage.sql.exec(
          `INSERT OR IGNORE INTO vote_events (id, t, d, day, ip_hash)
           SELECT
             json_extract(value, '$.id'),
             CAST(json_extract(value, '$.t') AS INTEGER),
             json_extract(value, '$.d'),
             json_extract(value, '$.day'),
             NULL
           FROM json_each(?)`,
          rows,
        );
      }
      const importedCount = Number(
        this.storage.sql
          .exec<CountRow>(
            "SELECT COUNT(*) AS count FROM vote_events WHERE id LIKE 'legacy:%'",
          )
          .toArray()[0]?.count ?? 0,
      );
      if (importedCount !== retainedEvents.length) {
        throw new Error(
          `旧 KV 迁移校验失败：预期 ${retainedEvents.length}，实际 ${importedCount}`,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO vote_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        "legacy_imported",
        JSON.stringify(state),
      );
    });
    return true;
  }

  finalizeLegacy(sourceHash: string): void {
    this.storage.transactionSync(() => {
      const state = this.legacyImportState();
      if (!state || state.sourceHash !== sourceHash) {
        throw new Error("旧 KV 迁移终态与已导入来源不一致");
      }
      if (state.status === "finalized") return;
      this.storage.sql.exec(
        "UPDATE vote_metadata SET value = ? WHERE key = ?",
        JSON.stringify({ ...state, status: "finalized" }),
        "legacy_imported",
      );
    });
  }

  directionFor(day: string, voterHash: string): "up" | "down" | null {
    const row = this.storage.sql
      .exec<DirectionRow>(
        `SELECT direction FROM daily_voters
         WHERE day = ? AND voter_hash = ? LIMIT 1`,
        day,
        voterHash,
      )
      .toArray()[0];
    return row?.direction ?? null;
  }

  castVote(input: CastVoteInput): CastVoteResult {
    return this.storage.transactionSync(() => {
      let maintenanceRan = false;
      const day = utcDay(input.now);
      const existing = this.directionFor(day, input.voterHash);
      if (existing) return { status: "duplicate", direction: existing };

      const ipCount = this.storage.sql
        .exec<CountRow>(
          `SELECT count FROM daily_ip_counts
           WHERE day = ? AND ip_hash = ?`,
          day,
          input.ipHash,
        )
        .toArray()[0]?.count;
      if (Number(ipCount ?? 0) >= MAX_DAILY_VOTES_PER_IP) {
        return { status: "ip_limit", direction: null };
      }

      // 两行写入位于同一 SQLite 事务：身份标记和事件要么同时提交，要么同时回滚。
      this.storage.sql.exec(
        `INSERT INTO daily_voters (day, voter_hash, direction)
         VALUES (?, ?, ?)`,
        day,
        input.voterHash,
        input.direction,
      );
      this.storage.sql.exec(
        `INSERT INTO vote_events (id, t, d, day, ip_hash)
         VALUES (?, ?, ?, ?, NULL)`,
        input.eventId,
        input.now,
        input.direction,
        day,
      );
      this.storage.sql.exec(
        `INSERT INTO daily_ip_counts (day, ip_hash, count) VALUES (?, ?, 1)
         ON CONFLICT(day, ip_hash) DO UPDATE SET count = count + 1`,
        day,
        input.ipHash,
      );

      const maintenanceHour = String(
        Math.floor(input.now / (60 * 60 * 1_000)),
      );
      const lastMaintenance = this.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM vote_metadata WHERE key = ? LIMIT 1",
          "last_maintenance_hour",
        )
        .toArray()[0]?.value;
      if (lastMaintenance !== maintenanceHour) {
        maintenanceRan = true;
        const retentionCutoff = input.now - RETENTION_MS;
        const voterCutoffDay = utcDay(input.now - 2 * 24 * 60 * 60 * 1000);
        this.storage.sql.exec(
          "DELETE FROM vote_events WHERE t < ?",
          retentionCutoff,
        );
        this.storage.sql.exec(
          "DELETE FROM daily_voters WHERE day < ?",
          voterCutoffDay,
        );
        this.storage.sql.exec(
          "DELETE FROM daily_ip_counts WHERE day < ?",
          voterCutoffDay,
        );
        this.storage.sql.exec(
          `DELETE FROM vote_events WHERE id IN (
             SELECT id FROM vote_events ORDER BY t DESC LIMIT -1 OFFSET ?
           )`,
          EVENTS_MAX,
        );
        this.storage.sql.exec(
          `INSERT INTO vote_metadata (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          "last_maintenance_hour",
          maintenanceHour,
        );
      }

      return {
        status: "accepted",
        direction: input.direction,
        maintenanceRan,
      };
    });
  }

  eventsForTally(now: number): VoteEvent[] {
    return this.storage.sql
      .exec<EventRow>(
        `SELECT t, d FROM vote_events
         WHERE t >= ? AND t <= ? ORDER BY t ASC`,
        now - WINDOW_MS,
        now,
      )
      .toArray()
      .map((row) => ({ t: Number(row.t), d: row.d }));
  }

  recentEvents(now: number, limit: number): VoteEvent[] {
    const safeLimit = Math.max(0, Math.min(Math.floor(limit), 5_000));
    return this.storage.sql
      .exec<EventRow>(
        `SELECT t, d FROM (
           SELECT t, d FROM vote_events
           WHERE t <= ? ORDER BY t DESC LIMIT ?
         ) ORDER BY t ASC`,
        now,
        safeLimit,
      )
      .toArray()
      .map((row) => ({ t: Number(row.t), d: row.d }));
  }

  eventCount(): number {
    const value = this.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM vote_events")
      .toArray()[0]?.count;
    return Number(value ?? 0);
  }
}
