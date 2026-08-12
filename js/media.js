/* media.js — 书影音清单（豆瓣式）
 * 电影 / 书 / 剧 三类，想看 / 在看 / 看过 三状态，评分 + 短评 + 完成日期。
 * - 存 media store（独立库 workbench_media）
 * - 支持按类型 tab、按状态筛选、关键词搜索；看过按评分排序
 * - 数据字段：{ id, type: movie|book|tv, title, status: wish|doing|done,
 *     rating: 0-10, comment, year, finishedAt, createdAt }
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, uid, esc, icon, flashInvalid } = window.WB;
  const mRepo = () => repo("media");
  // showToast 不是 WB 公开 API（app.js 内部函数），这里用轻量替代
  const toast = (t) => {
    if (window.WB.showToast) return window.WB.showToast(t, "info");
    try { alert(t); } catch (e) { /* 忽略 */ }
  };

  const TYPES = [
    { key: "movie", label: "🎬 电影", emoji: "🎬" },
    { key: "book", label: "📚 书", emoji: "📚" },
    { key: "tv", label: "📺 剧", emoji: "📺" },
  ];
  const STATUS = [
    { key: "wish", label: "想看" },
    { key: "doing", label: "在看" },
    { key: "done", label: "看过" },
  ];
  const STATUS_EMOJI = { wish: "🌟", doing: "📖", done: "✅" };
  const typeOf = (k) => TYPES.find((t) => t.key === k) || TYPES[0];

  // 模块状态（跨渲染保留）
  let curType = "movie";
  let curStatus = ""; // "" = 全部 | wish | doing | done
  let mediaQ = "";

  function stars(rating) {
    if (!rating) return "";
    const full = Math.round(rating / 2);
    return "★".repeat(full) + "☆".repeat(5 - full);
  }

  function renderForm() {
    return `
      <div class="card">
        <h2>添加${typeOf(curType).label}</h2>
        <div class="row">
          <input class="grow" id="mTitle" placeholder="${curType === "book" ? "书名" : "片名 / 剧名"}" maxlength="80" />
          <input id="mYear" class="w-70" placeholder="年份" maxlength="4" inputmode="numeric" />
          <select id="mStatus">
            ${STATUS.map((s) => `<option value="${s.key}">${s.status}</option>`).join("")}
          </select>
          <select id="mRating" title="评分（1-10）">
            <option value="">未评分</option>
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((r) => `<option value="${r}">${r} 分</option>`).join("")}
          </select>
          <button class="btn in-card-btn" id="mAdd">添加</button>
        </div>
      </div>`;
  }

  function renderItem(m) {
    const s = STATUS.find((x) => x.key === m.status) || STATUS[0];
    return `
      <li class="item media-li" data-mid="${m.id}">
        <span class="m-emoji">${typeOf(m.type).emoji}</span>
        <div class="m-main">
          <div class="m-title">${esc(m.title)}${m.year ? `<span class="m-year">${esc(m.year)}</span>` : ""}</div>
          <div class="m-meta">
            <span class="m-status ${m.status}">${STATUS_EMOJI[m.status]} ${s.label}</span>
            ${m.rating ? `<span class="m-stars">${stars(m.rating)}</span><span class="m-rating-num">${m.rating} 分</span>` : ""}
            ${m.finishedAt ? `<span class="m-done-at">${esc(m.finishedAt)} 看完</span>` : ""}
          </div>
          ${m.comment ? `<div class="m-comment">${esc(m.comment)}</div>` : ""}
        </div>
        <span class="mla"></span>
        <button class="icon-btn plain" data-mdel="${m.id}" title="删除">${icon("trash")}</button>
      </li>`;
  }

  function renderList(items) {
    const list = items.filter((m) => m.type === curType)
      .filter((m) => !curStatus || m.status === curStatus)
      .filter((m) => !mediaQ || (m.title || "").toLowerCase().includes(mediaQ.toLowerCase()));
    // 排序：看过 → 按评分倒序；在看/想看 → 按创建时间倒序
    list.sort((a, b) => {
      if (a.status === "done" && b.status === "done") return (b.rating || 0) - (a.rating || 0);
      if (a.status === "done") return -1;
      if (b.status === "done") return 1;
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
    if (!list.length) {
      return `<div class="empty">${curStatus ? `还没有「${STATUS.find((s) => s.key === curStatus).status}」的${typeOf(curType).label}` : `还没有${typeOf(curType).label}，先添加一个吧`}</div>`;
    }
    return `<ul class="list">${list.map(renderItem).join("")}</ul>`;
  }

  function renderTypeTabs() {
    return `<div class="tabs sp-b-xl" id="mediaTabs">
      ${TYPES.map((t) => `<button class="tab ${curType === t.key ? "on" : ""}" data-t="${t.key}">${t.label}</button>`).join("")}
    </div>`;
  }

  function renderStatusFilter() {
    return `<div class="tabs sp-b-lg" id="mediaStatus">
      <button class="tab sm ${!curStatus ? "on" : ""}" data-s="">全部</button>
      ${STATUS.map((s) => `<button class="tab sm ${curStatus === s.key ? "on" : ""}" data-s="${s.key}">${s.label}</button>`).join("")}
    </div>`;
  }

  routes.media = {
    title: "书影音",
    async render(el) {
      const items = (await mRepo().list().catch(() => [])) || [];

      el.innerHTML = `
        ${renderTypeTabs()}
        <div class="row sp-b-xl">
          ${renderStatusFilter()}
          <span class="mla"></span>
          <input class="w-180" id="mSearch" placeholder="🔍 搜标题" value="${esc(mediaQ)}" />
        </div>
        ${renderForm()}
        <div class="card">
          <h2>${typeOf(curType).label}清单<span class="count">${items.filter((m) => m.type === curType).length} 条</span></h2>
          <div id="mList">${renderList(items)}</div>
        </div>
        <div class="footnote">看过之后可以打分和写短评，清单会自动按评分排序。</div>`;

      // Tab：切换类型
      el.querySelectorAll("[data-t]").forEach((b) =>
        b.addEventListener("click", () => { curType = b.dataset.t; curStatus = ""; routes.media.render(el); })
      );
      // 状态筛选
      el.querySelectorAll("#mediaStatus [data-s]").forEach((b) =>
        b.addEventListener("click", () => { curStatus = b.dataset.s; routes.media.render(el); })
      );
      // 搜索
      el.querySelector("#mSearch").addEventListener("input", (e) => { mediaQ = e.target.value.trim(); routes.media.render(el); });

      // 添加
      const addBtn = el.querySelector("#mAdd");
      addBtn.addEventListener("click", async () => {
        const titleInput = el.querySelector("#mTitle");
        const title = titleInput.value.trim();
        if (!title) return flashInvalid(titleInput);
        const status = el.querySelector("#mStatus").value;
        const rating = Number(el.querySelector("#mRating").value) || 0;
        await mRepo().put({
          id: uid(),
          type: curType,
          title,
          year: el.querySelector("#mYear").value.trim(),
          status,
          rating,
          comment: "",
          finishedAt: status === "done" ? todayStr() : "",
          createdAt: new Date().toISOString(),
        });
        toast("已添加");
        routes.media.render(el);
      });
      el.querySelector("#mTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

      // 删除
      el.querySelectorAll("[data-mdel]").forEach((b) =>
        b.addEventListener("click", async () => {
          const id = b.dataset.mdel;
          const m = items.find((x) => x.id === id);
          if (!confirm(`删除「${m ? m.title : ""}」？`)) return;
          await mRepo().delete(id);
          toast("已删除");
          routes.media.render(el);
        })
      );

      // 点击条目进入编辑（简单实现：弹 prompt 改状态/评分，足够轻量）
      el.querySelectorAll(".media-li").forEach((li) =>
        li.addEventListener("click", async (e) => {
          if (e.target.closest("[data-mdel]")) return;
          const id = li.dataset.mid;
          const m = items.find((x) => x.id === id);
          if (!m) return;
          const newStatus = prompt(`「${m.title}」\n1=想看  2=在看  3=看过  （取消不改）`, m.status === "wish" ? "1" : m.status === "doing" ? "2" : "3");
          if (!newStatus) return;
          const map = { "1": "wish", "2": "doing", "3": "done" };
          const st = map[newStatus];
          if (!st) return;
          m.status = st;
          if (st === "done" && !m.finishedAt) m.finishedAt = todayStr();
          if (st !== "done") m.finishedAt = "";
          await mRepo().put(m);
          toast("已更新");
          routes.media.render(el);
        })
      );
    },
  };

  function todayStr() { return window.WB.dateStr(new Date()); }
})();
