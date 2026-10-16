import "./comments.css";
import { COMMENT_MAX_LENGTH, type CommentItem, type CommentPage, type CommentSort, type CommentVote } from "./comments-shared";

class CommentError extends Error {
  constructor(message: string, readonly retryAt?: number) { super(message); }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api/comments${path}`, {
      signal: controller.signal, cache: "no-store",
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new CommentError("此站点暂不支持评论服务");
    const data = await response.json();
    if (!response.ok) throw new CommentError(data.reason || "评论请求失败，请重试", data.retryAt);
    return data as T;
  } finally { window.clearTimeout(timer); }
}

export function mountComments(root: HTMLElement): void {
  const panel = document.createElement("section");
  panel.className = "comments-panel";
  panel.setAttribute("aria-labelledby", "comments-title");
  panel.innerHTML = `
    <div class="comments-heading"><div><p class="comments-eyebrow">此刻的声音 · 72 小时</p><h2 id="comments-title">匿名留言</h2></div><span class="comments-badge">三日即逝</span></div>
    <p class="comments-intro">留下此刻的想法。无需登录，评论在发布 72 小时后自动清理。</p>
    <form class="comment-form">
      <label for="comment-body">说点什么</label>
      <textarea id="comment-body" rows="3" maxlength="1000" placeholder="关于今天的梁系浓度，你怎么看？" aria-describedby="comment-rules comment-length" required></textarea>
      <div class="comment-compose-footer"><span id="comment-length">0 / 500</span><button type="submit">匿名发布</button></div>
      <p id="comment-rules">1–500 字纯文本 · 同一 IP 每 5 分钟一条、24 小时最多 5 条。发布后不可编辑或删除。</p>
    </form>
    <div class="comments-toolbar"><div role="group" aria-label="评论排序"><button type="button" data-sort="hot" aria-pressed="true">热门</button><button type="button" data-sort="new" aria-pressed="false">最新</button></div><button type="button" class="comments-refresh">刷新</button></div>
    <p class="comments-sort-hint">热门按赞减踩排序，同分时新评论优先。赞踩可撤销或改票，同一 IP 共享一票。</p>
    <p class="comments-status" role="status" aria-live="polite">正在加载评论…</p>
    <ol class="comments-list" aria-label="最近三日评论"></ol>
    <nav class="comments-pagination" aria-label="评论分页" hidden><button type="button" data-page="prev">上一页</button><span class="comments-page-number"></span><button type="button" data-page="next">下一页</button></nav>
  `;
  root.querySelector(".footer-note")!.before(panel);
  const textarea = panel.querySelector<HTMLTextAreaElement>("textarea")!;
  const form = panel.querySelector<HTMLFormElement>("form")!;
  const submit = panel.querySelector<HTMLButtonElement>("[type=submit]")!;
  const status = panel.querySelector<HTMLElement>(".comments-status")!;
  const list = panel.querySelector<HTMLOListElement>("ol")!;
  const pagination = panel.querySelector<HTMLElement>("nav")!;
  let items: CommentItem[] = [];
  let sort: CommentSort = "hot";
  let offset = 0;
  let hasMore = false;
  let loading = false;
  let busy = false;
  let sequence = 0;
  let clockOffset = 0;
  let expiryTimer = 0;
  let retryTimer = 0;
  let retryAt = 0;
  const now = () => Date.now() + clockOffset;
  const message = (text: string) => { status.textContent = text; };
  const updateControls = () => {
    const length = Array.from(textarea.value.trim()).length;
    panel.querySelector("#comment-length")!.textContent = `${length} / ${COMMENT_MAX_LENGTH}`;
    submit.disabled = busy || !length || length > COMMENT_MAX_LENGTH || now() < retryAt;
    panel.querySelectorAll<HTMLButtonElement>("[data-sort], .comments-refresh, [data-vote]").forEach(button => button.disabled = loading || busy);
    panel.querySelector<HTMLButtonElement>("[data-page=prev]")!.disabled = busy || loading || offset === 0;
    panel.querySelector<HTMLButtonElement>("[data-page=next]")!.disabled = busy || loading || !hasMore;
    list.setAttribute("aria-busy", String(loading));
  };
  const render = () => {
    const focused = document.activeElement as HTMLElement | null;
    const focusId = focused?.closest<HTMLElement>("[data-comment-id]")?.dataset.commentId;
    const focusVote = focused?.dataset.vote;
    list.replaceChildren();
    items = items.filter(item => item.expiresAt > now());
    for (const item of items) {
      const row = document.createElement("li");
      row.dataset.commentId = item.id;
      row.innerHTML = `<article><div class="comment-meta"><span class="comment-avatar" aria-hidden="true">匿</span><strong>匿名</strong><time></time></div><p class="comment-text"></p><div class="comment-actions"><button type="button" data-vote="up"><span aria-hidden="true">↑</span> 赞 <span class="count"></span></button><button type="button" data-vote="down"><span aria-hidden="true">↓</span> 踩 <span class="count"></span></button><span class="comment-score"></span></div></article>`;
      row.querySelector(".comment-text")!.textContent = item.body;
      const time = row.querySelector("time")!;
      time.dateTime = new Date(item.createdAt).toISOString();
      time.textContent = new Date(item.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      time.title = `自动清理：${new Date(item.expiresAt).toLocaleString("zh-CN")}`;
      row.querySelector(".comment-score")!.textContent = `净赞 ${item.score}`;
      row.querySelectorAll<HTMLButtonElement>("[data-vote]").forEach(button => {
        const direction = button.dataset.vote as "up" | "down";
        button.querySelector(".count")!.textContent = String(item[direction]);
        button.setAttribute("aria-pressed", String(item.myVote === direction));
        button.setAttribute("aria-label", `${item.myVote === direction ? "撤销" : ""}${direction === "up" ? "点赞" : "点踩"}，${item[direction]} 票`);
      });
      list.append(row);
    }
    pagination.hidden = offset === 0 && !hasMore;
    panel.querySelector(".comments-page-number")!.textContent = `第 ${offset / 20 + 1} 页`;
    updateControls();
    if (focusId && focusVote) {
      const row = Array.from(list.children).find(el => (el as HTMLElement).dataset.commentId === focusId);
      row?.querySelector<HTMLButtonElement>(`[data-vote="${focusVote}"]`)?.focus({ preventScroll: true });
    }
    window.clearTimeout(expiryTimer);
    if (items.length) expiryTimer = window.setTimeout(() => {
      render();
      if (!items.length) message("本页评论已到期，刷新查看最近留言。");
    }, Math.min(60_000, Math.max(1, Math.min(...items.map(item => item.expiresAt)) - now() + 1)));
  };
  const load = async (): Promise<boolean> => {
    const current = ++sequence;
    loading = true; updateControls();
    try {
      const page = await api<CommentPage>(`?sort=${sort}&offset=${offset}`);
      if (current !== sequence) return false;
      items = page.comments; hasMore = page.hasMore; clockOffset = page.serverTime - Date.now();
      render();
      message(items.length ? "" : offset ? "这一页暂时没有评论，请返回上一页。" : "还没有留言，来留下第一条吧。");
      return true;
    } catch (error) {
      if (current === sequence) message(error instanceof CommentError ? error.message : "评论加载失败，请点击刷新重试。");
      return false;
    } finally { if (current === sequence) { loading = false; updateControls(); } }
  };
  textarea.addEventListener("input", updateControls);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const body = textarea.value.trim();
    busy = true; updateControls(); message("正在发布…");
    try {
      await api("", { body });
      if (textarea.value.trim() === body) textarea.value = "";
      offset = 0;
      if (await load()) message("已匿名发布，72 小时后自动清理。");
    } catch (error) {
      message(error instanceof CommentError ? error.message : "发布失败，内容已保留，请重试。");
      if (error instanceof CommentError && error.retryAt) {
        retryAt = error.retryAt;
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(updateControls, Math.max(1, retryAt - now() + 1));
      }
    } finally { busy = false; updateControls(); }
  });
  panel.addEventListener("click", async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button || button.disabled || busy) return;
    if (button.dataset.sort) {
      sort = button.dataset.sort as CommentSort; offset = 0;
      panel.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.sort === sort)));
      await load();
    } else if (button.classList.contains("comments-refresh")) { await load(); }
    else if (button.dataset.page) { offset += button.dataset.page === "next" ? 20 : -20; await load(); }
    else if (button.dataset.vote) {
      const id = button.closest<HTMLElement>("[data-comment-id]")!.dataset.commentId!;
      const item = items.find(item => item.id === id);
      if (!item) return;
      const direction: CommentVote = item.myVote === button.dataset.vote ? null : button.dataset.vote as "up" | "down";
      const restoreFocus = document.activeElement === button;
      busy = true; updateControls();
      try {
        await api(`/${id}/vote`, { direction });
        if (await load()) message(direction === "up" ? "已点赞" : direction === "down" ? "已点踩" : "已撤销投票");
      } catch (error) { message(error instanceof CommentError ? error.message : "投票失败，请重试。"); }
      finally {
        busy = false; updateControls();
        if (restoreFocus && (document.activeElement === document.body || document.activeElement === button)) {
          list.querySelector<HTMLButtonElement>(`[data-comment-id="${id}"] [data-vote="${button.dataset.vote}"]`)?.focus({ preventScroll: true });
        }
      }
    }
  });
  updateControls();
  if (import.meta.env.MODE === "github-pages") {
    message("当前为静态预览，匿名评论仅在完整站点开放。");
    panel.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea").forEach(el => el.disabled = true);
  } else { void load(); }
}
