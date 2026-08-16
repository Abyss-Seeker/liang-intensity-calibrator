import {
  DurableObject,
  type DurableObjectState,
} from "cloudflare:workers";
import {
  VoteRepository,
  parseLegacyEvents,
  type TransactionalStorageLike,
  type VoteEvent,
  utcDay,
} from "./vote-store";

interface KVNamespace {
  get(key: string): Promise<string | null>;
}

interface CoordinatorEnv {
  VOTES: KVNamespace;
}

interface VoteGap {
  start: number;
  end: number | null;
  reason: string;
}

interface RateWindow {
  start: number;
  count: number;
}

const BASE_LEVEL = 15;
const VOTE_FULL_NET = 20;
const CONSENSUS_FLOOR = 0.1;
const CONSENSUS_R_FULL = 0.1;
const CONSENSUS_N_FULL = 20;
const HALF_LIFE_MS = 18 * 60 * 60 * 1000;
const PUBLIC_EVENTS_LIMIT = 1_000;
const RATE_WINDOW_MS = 60_000;
const MAX_POSTS_PER_WINDOW = 5;
const MAX_RATE_WINDOWS = 10_000;
const MAX_POST_BODY_BYTES = 1_024;
const SNAPSHOT_REFRESH_MS = 60 * 60 * 1_000;
const MIGRATION_RECONCILE_DELAY_MS = 5 * 60 * 1_000;
const EVENTS_KEY = "events";

const STATIC_GAPS: VoteGap[] = [
  {
    start: Date.UTC(2026, 7, 14, 1, 53, 0),
    end: Date.UTC(2026, 7, 14, 4, 11, 0),
    reason: "网页限额爆了，数据未录入，不准确",
  },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function consensusFactor(up: number, down: number): number {
  const n = up + down;
  if (n <= 0) return 0;
  const r = Math.min(up, down) / n;
  const raw = (0.5 - r) / (0.5 - CONSENSUS_R_FULL);
  const floored = Math.max(raw, CONSENSUS_FLOOR);
  const capped = Math.min(floored, 1);
  const sample = Math.min(1, n / CONSENSUS_N_FULL);
  return capped * sample;
}

function levelFromTally(upW: number, downW: number): number {
  const net = upW - downW;
  if (net === 0) return BASE_LEVEL;
  const strength = Math.min(
    1,
    Math.sqrt(Math.abs(net)) / Math.sqrt(VOTE_FULL_NET),
  );
  const consensus = consensusFactor(upW, downW);
  return Math.min(
    30,
    Math.max(
      0,
      BASE_LEVEL + BASE_LEVEL * strength * consensus * Math.sign(net),
    ),
  );
}

function voteWeight(ageMs: number): number {
  return Math.pow(0.5, ageMs / HALF_LIFE_MS);
}

function computeTally(events: VoteEvent[], now: number) {
  let up = 0;
  let down = 0;
  let upW = 0;
  let downW = 0;
  for (const event of events) {
    const age = now - event.t;
    if (age < 0) continue;
    const weight = voteWeight(age);
    if (event.d === "up") {
      up += 1;
      upW += weight;
    } else {
      down += 1;
      downW += weight;
    }
  }
  return {
    up,
    down,
    net: upW - downW,
    weightedUp: upW,
    weightedDown: downW,
    level: levelFromTally(upW, downW),
  };
}

async function hashIdentity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function publicEvents(events: VoteEvent[]): VoteEvent[] {
  return events.map((event) => ({
    // 对外只给分钟精度，走势图仍可用，但不再泄露每票的精确毫秒时间。
    t: Math.floor(event.t / 60_000) * 60_000,
    d: event.d,
  }));
}

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("请求体为空");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_POST_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

interface SnapshotCache {
  computedAt: number;
  tally: ReturnType<typeof computeTally>;
  events: VoteEvent[];
  eventsTruncated: boolean;
  totalEvents: number;
}

interface LegacyReconcileResult {
  changed: boolean;
  sourceHash: string;
}

export class VoteCoordinator extends DurableObject<CoordinatorEnv> {
  private readonly repository: VoteRepository;
  private readonly abuseSecret: string;
  private readonly ready: Promise<void>;
  private readonly rateWindows = new Map<string, RateWindow>();
  private snapshotCache: SnapshotCache | null = null;

  constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
    super(ctx, env);
    this.repository = new VoteRepository(
      ctx.storage as unknown as TransactionalStorageLike,
    );
    this.abuseSecret = this.repository.getOrCreateAbuseSecret(
      crypto.randomUUID(),
    );
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const state = this.repository.legacyImportState();
      if (state?.status === "finalized") {
        if ((await ctx.storage.getAlarm()) !== null) {
          await ctx.storage.deleteAlarm();
        }
        return;
      }
      if (!state) await this.reconcileLegacy();
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + MIGRATION_RECONCILE_DELAY_MS);
      }
    });
  }

  private async reconcileLegacy(): Promise<LegacyReconcileResult> {
    const raw = await this.env.VOTES.get(EVENTS_KEY);
    if (raw === null) {
      throw new Error("旧 KV events 不存在，拒绝把缺失数据标记为已迁移");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("旧 KV events 不是合法 JSON，已中止自动迁移");
    }
    const events = parseLegacyEvents(parsed);
    const sourceHash = await hashIdentity(raw);
    const changed = this.repository.importLegacy(events, Date.now(), sourceHash);
    if (changed) this.snapshotCache = null;
    return { changed, sourceHash };
  }

  async alarm(): Promise<void> {
    // 部署五分钟后再次读取 KV，吸收旧 Worker 在切换瞬间尚未传播的尾部写入。
    try {
      const result = await this.reconcileLegacy();
      if (!result.changed) {
        this.repository.finalizeLegacy(result.sourceHash);
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.ctx.storage.setAlarm(
        Date.now() + MIGRATION_RECONCILE_DELAY_MS,
      );
    } catch (error) {
      await this.ctx.storage.setAlarm(
        Date.now() + MIGRATION_RECONCILE_DELAY_MS,
      );
      throw error;
    }
  }

  private allowPost(ipHash: string, now: number): boolean {
    const current = this.rateWindows.get(ipHash);
    if (!current || now - current.start >= RATE_WINDOW_MS) {
      if (!current && this.rateWindows.size >= MAX_RATE_WINDOWS) {
        const oldestKey = this.rateWindows.keys().next().value as
          | string
          | undefined;
        if (oldestKey) this.rateWindows.delete(oldestKey);
      }
      this.rateWindows.set(ipHash, { start: now, count: 1 });
      return true;
    }
    if (current.count >= MAX_POSTS_PER_WINDOW) return false;
    current.count += 1;
    return true;
  }

  private snapshotBase(now: number): SnapshotCache {
    const cached = this.snapshotCache;
    if (cached && now - cached.computedAt < SNAPSHOT_REFRESH_MS) {
      const decay = voteWeight(now - cached.computedAt);
      const weightedUp = cached.tally.weightedUp * decay;
      const weightedDown = cached.tally.weightedDown * decay;
      return {
        ...cached,
        tally: {
          ...cached.tally,
          net: weightedUp - weightedDown,
          weightedUp,
          weightedDown,
          level: levelFromTally(weightedUp, weightedDown),
        },
      };
    }
    const tally = computeTally(this.repository.eventsForTally(now), now);
    const totalEvents = this.repository.eventCount();
    const events = publicEvents(
      this.repository.recentEvents(now, PUBLIC_EVENTS_LIMIT),
    );
    this.snapshotCache = {
      computedAt: now,
      tally,
      events,
      eventsTruncated: totalEvents > events.length,
      totalEvents,
    };
    return this.snapshotCache;
  }

  private snapshot(now: number, voterHash: string) {
    const base = this.snapshotBase(now);
    const votedDirection = this.repository.directionFor(utcDay(now), voterHash);
    return {
      ...base.tally,
      events: base.events,
      eventsTruncated: base.eventsTruncated,
      totalEvents: base.totalEvents,
      gaps: STATIC_GAPS,
      voted: Boolean(votedDirection),
      votedDirection,
    };
  }

  private updateSnapshotAfterVote(
    now: number,
    direction: "up" | "down",
    forceRefresh: boolean,
  ): void {
    const cached = this.snapshotCache;
    if (
      forceRefresh ||
      !cached ||
      now - cached.computedAt >= SNAPSHOT_REFRESH_MS
    ) {
      this.snapshotCache = null;
      this.snapshotBase(now);
      return;
    }

    const base = this.snapshotBase(now);
    const up = base.tally.up + (direction === "up" ? 1 : 0);
    const down = base.tally.down + (direction === "down" ? 1 : 0);
    const weightedUp = base.tally.weightedUp + (direction === "up" ? 1 : 0);
    const weightedDown =
      base.tally.weightedDown + (direction === "down" ? 1 : 0);
    const events = [
      ...base.events,
      { t: Math.floor(now / 60_000) * 60_000, d: direction },
    ].slice(-PUBLIC_EVENTS_LIMIT);
    const totalEvents = base.totalEvents + 1;
    this.snapshotCache = {
      computedAt: now,
      tally: {
        up,
        down,
        net: weightedUp - weightedDown,
        weightedUp,
        weightedDown,
        level: levelFromTally(weightedUp, weightedDown),
      },
      events,
      eventsTruncated: base.eventsTruncated || totalEvents > events.length,
      totalEvents,
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ready;
      const voterId = request.headers.get("X-Liang-Voter-Id");
      const clientIp = request.headers.get("X-Liang-Client-IP");
      if (!voterId || !clientIp) {
        return json({ reason: "缺少内部投票身份" }, 400);
      }

      const now = Date.now();
      const day = utcDay(now);
      const [voterHash, ipHash] = await Promise.all([
        hashIdentity(voterId),
        hashIdentity(`${this.abuseSecret}\0${day}\0${clientIp}`),
      ]);

      if (request.method === "GET") {
        return json(this.snapshot(now, voterHash));
      }
      if (request.method !== "POST") {
        return json({ reason: "不支持的请求方法" }, 405);
      }

      if (!this.allowPost(ipHash, now)) {
        return json(
          {
            code: "rate_limited",
            reason: "请求过于频繁，请一分钟后再试",
          },
          429,
        );
      }

      const contentType = request.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        return json({ reason: "投票请求必须使用 application/json" }, 415);
      }

      let direction: "up" | "down";
      try {
        const body = (await readJsonBody(request)) as { direction?: unknown };
        if (body.direction !== "up" && body.direction !== "down") {
          return json({ reason: "方向必须是 up 或 down" }, 400);
        }
        direction = body.direction;
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return json({ reason: "投票请求体过大" }, 413);
        }
        return json({ reason: "请求体不是合法 JSON" }, 400);
      }

      const result = this.repository.castVote({
        eventId: crypto.randomUUID(),
        now,
        direction,
        voterHash,
        ipHash,
      });
      if (result.status === "duplicate") {
        return json({
          ...this.snapshot(now, voterHash),
          reason: "今天已经投过票了，明天再来吧",
        });
      }
      if (result.status === "ip_limit") {
        return json(
          {
            code: "network_daily_limit",
            reason: "当前网络今天的匿名投票数量已达上限",
          },
          429,
        );
      }

      this.updateSnapshotAfterVote(
        now,
        direction,
        result.maintenanceRan,
      );
      return json(this.snapshot(now, voterHash));
    } catch (error) {
      console.error("[vote] Durable Object 存储失败", error);
      return json(
        {
          code: "vote_storage_unavailable",
          reason: "投票服务暂时不可用，请稍后再试",
        },
        503,
      );
    }
  }
}
