import { COMMENT_COOLDOWN, COMMENT_DAY, COMMENT_MAX_LENGTH, COMMENT_TTL, type CommentItem } from "./comments-shared";

// Small structural interfaces keep the existing Node test/build setup usable.
interface Sql {
  exec<T = Record<string, unknown>>(query: string, ...values: (string | number | null)[]): { toArray(): T[] };
}
export interface CommentStorage {
  sql: Sql;
  transactionSync<T>(callback: () => T): T;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface State {
  storage: CommentStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
export interface CommentsNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export function commentJson(data: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers,
  } });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 4096) { await reader.cancel(); throw new Error("large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
  return body as Record<string, unknown>;
}

// One object owns the whole short-lived board. SQL transactions protect quotas,
// votes and counters together; the existing community KV vote is unchanged.
export class Comments {
  private sql: Sql;
  private key: Promise<CryptoKey>;
  constructor(private ctx: State) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, createdAt INTEGER NOT NULL,
        up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS comments_time ON comments(createdAt);
      CREATE INDEX IF NOT EXISTS comments_hot ON comments((up-down) DESC, createdAt DESC, id DESC);
      CREATE TABLE IF NOT EXISTS votes (
        commentId TEXT NOT NULL, actor TEXT NOT NULL, direction TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, PRIMARY KEY(commentId, actor)
      );
      CREATE INDEX IF NOT EXISTS votes_expiry ON votes(expiresAt);
      CREATE TABLE IF NOT EXISTS posts (actor TEXT NOT NULL, time INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS posts_actor ON posts(actor, time);
      CREATE INDEX IF NOT EXISTS posts_time ON posts(time);
    `);
    this.sql.exec("INSERT OR IGNORE INTO meta VALUES ('secret', ?)", crypto.randomUUID() + crypto.randomUUID());
    const secret = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='secret'").toArray()[0].value;
    this.key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  private cleanup(now: number): void {
    this.sql.exec("DELETE FROM votes WHERE expiresAt <= ?", now);
    this.sql.exec("DELETE FROM comments WHERE createdAt <= ?", now - COMMENT_TTL);
    this.sql.exec("DELETE FROM posts WHERE time <= ?", now - COMMENT_DAY);
  }
  private async schedule(): Promise<void> {
    const next = this.sql.exec<{ time: number | null }>(
      "SELECT MIN(time) AS time FROM (SELECT MIN(createdAt)+? AS time FROM comments UNION ALL SELECT MIN(time)+? AS time FROM posts)",
      COMMENT_TTL, COMMENT_DAY,
    ).toArray()[0].time;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
  }
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => this.cleanup(Date.now()));
      await this.schedule();
    });
  }
  private item(id: string, actor: string): CommentItem | undefined {
    return this.sql.exec<CommentItem>(`SELECT c.*, c.createdAt+? AS expiresAt,
      c.up-c.down AS score, v.direction AS myVote FROM comments c
      LEFT JOIN votes v ON c.id=v.commentId AND v.actor=? WHERE c.id=?`, COMMENT_TTL, actor, id).toArray()[0];
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const voteMatch = /^\/api\/comments\/([a-f0-9-]{36})\/vote$/.exec(url.pathname);
    if (url.pathname !== "/api/comments" && !voteMatch) return commentJson({ reason: "评论接口不存在" }, 404);
    if (request.method !== "GET" && request.method !== "POST" || voteMatch && request.method !== "POST") {
      return commentJson({ reason: "不支持的请求方法" }, 405, { Allow: voteMatch ? "POST" : "GET, POST" });
    }
    let body: Record<string, unknown> = {};
    const ip = request.headers.get("CF-Connecting-IP");
    if (request.method === "POST") {
      if (!ip) return commentJson({ reason: "无法确认访问来源，请稍后重试" }, 403);
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") return commentJson({ reason: "不允许跨站提交" }, 403);
      if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") return commentJson({ reason: "请使用 JSON 请求" }, 415);
      try { body = await readBody(request); }
      catch (error) { return commentJson({ reason: "请求内容无效或过长" }, error instanceof Error && error.message === "large" ? 413 : 400); }
    }
    const actor = ip ? Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await this.key, new TextEncoder().encode(ip))), b => b.toString(16).padStart(2, "0")).join("") : "";
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const response = this.ctx.storage.transactionSync(() => {
        this.cleanup(now);
        if (request.method === "GET") {
          const sort = url.searchParams.get("sort") ?? "hot";
          const offset = Number(url.searchParams.get("offset") ?? 0);
          if (!["hot", "new"].includes(sort) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return commentJson({ reason: "排序或页码无效" }, 400);
          const order = sort === "hot" ? "(c.up-c.down) DESC, c.createdAt DESC, c.id DESC" : "c.createdAt DESC, c.id DESC";
          const rows = this.sql.exec<CommentItem>(`SELECT c.*, c.createdAt+? AS expiresAt,
            c.up-c.down AS score, v.direction AS myVote FROM comments c
            LEFT JOIN votes v ON c.id=v.commentId AND v.actor=?
            ORDER BY ${order} LIMIT 21 OFFSET ?`, COMMENT_TTL, actor, offset).toArray();
          return commentJson({ comments: rows.slice(0, 20), hasMore: rows.length > 20, serverTime: now });
        }
        if (voteMatch) {
          const direction = body.direction;
          if (direction !== "up" && direction !== "down" && direction !== null) return commentJson({ reason: "请选择赞、踩或撤销" }, 400);
          const id = voteMatch[1];
          const previous = this.item(id, actor);
          if (!previous) return commentJson({ reason: "评论已到期或不存在" }, 404);
          if (previous.myVote !== direction) {
            this.sql.exec("DELETE FROM votes WHERE commentId=? AND actor=?", id, actor);
            if (direction) this.sql.exec("INSERT INTO votes VALUES (?, ?, ?, ?)", id, actor, direction, previous.expiresAt);
            this.sql.exec("UPDATE comments SET up=up+?, down=down+? WHERE id=?",
              Number(direction === "up") - Number(previous.myVote === "up"),
              Number(direction === "down") - Number(previous.myVote === "down"), id);
          }
          return commentJson({ comment: this.item(id, actor), serverTime: now });
        }
        const text = typeof body.body === "string" ? body.body.trim() : "";
        if (!text || Array.from(text).length > COMMENT_MAX_LENGTH) return commentJson({ reason: "请输入 1–500 字评论" }, 400);
        const posts = this.sql.exec<{ time: number }>("SELECT time FROM posts WHERE actor=? ORDER BY time ASC", actor).toArray();
        const next = Math.max((posts.at(-1)?.time ?? 0) + COMMENT_COOLDOWN, posts.length >= 5 ? posts[0].time + COMMENT_DAY : 0);
        if (next > now) return commentJson({ reason: posts.length >= 5 ? "最近 24 小时已发布 5 条，请稍后再来" : "每 5 分钟可以发布一条评论", retryAt: next }, 429, { "Retry-After": String(Math.ceil((next - now) / 1000)) });
        const id = crypto.randomUUID();
        this.sql.exec("INSERT INTO comments (id, body, createdAt) VALUES (?, ?, ?)", id, text, now);
        this.sql.exec("INSERT INTO posts VALUES (?, ?)", actor, now);
        return commentJson({ comment: this.item(id, actor), serverTime: now }, 201);
      });
      await this.schedule();
      return response;
    });
  }
}

export async function handleComments(request: Request, namespace?: CommentsNamespace): Promise<Response> {
  if (!namespace) return commentJson({ reason: "评论服务暂未配置" }, 503);
  try { return await namespace.get(namespace.idFromName("recent-comments-v1")).fetch(request); }
  catch { return commentJson({ reason: "评论服务暂时不可用，请稍后重试" }, 503); }
}
