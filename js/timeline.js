/* timeline.js — 人生时间轴 · 重大事件 + 往年今日
 * - 存 timeline store（独立库 workbench_timeline）：{id, date, title, category, desc, tags, link, createdAt, updatedAt}
 * - 记录"发生过什么"：买房/换工作/旅行/大额购买/重要考试……刻意保持轻量，不做 CRM
 * - 往年今日：聚合现有各 store 的同月同日历史数据（记账/任务/笔记/收藏/理财/时间轴），
 *   仪表盘与本页共用同一个纯函数聚合器，不改任何业务模块
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, uid, esc, todayStr, flashInvalid, showToast, parseTags } = window.WB;

  const tRepo = () => repo("timeline");

  const CATS = {
    milestone: { emoji: "⭐", name: "人生大事" },
    work: { emoji: "💼", name: "工作" },
    family: { emoji: "🏠", name: "家庭" },
    travel: { emoji: "✈️", name: "旅行" },
    health: { emoji: "🏥", name: "健康" },
    finance: { emoji: "💰", name: "财务" },
    study: { emoji: "📚", name: "学习" },
    buy: { emoji: "🛒", name: "大额购买" },
    exam: { emoji: "🎯", name: "重要考试" },
    other: { emoji: "📌", name: "其它" },
  };

  /** 往年今日纯聚合器：输入各 store 列表 + 今天，返回 [{year, items:[{icon,text,go}]}] 按年倒序。
   *  供本页与仪表盘共用；不改任何业务数据 */
  function onThisDay({ today, finance, tasks, notes, bookmarks, stocks, timeline }) {
    const md = (today || todayStr()).slice(5); // "MM-DD"
    const curY = (today || todayStr()).slice(0, 4);
    const byYear = {};
    const push = (y, item) => {
      if (!y || y === curY || y < "1990") return; // 只看往年
      (byYear[y] = byYear[y] || []).push(item);
    };
    const money = (n) => Number(n || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });

    // 记账：按年聚合一行（避免几十条流水刷屏）
    const finAgg = {};
    (finance || []).forEach((r) => {
      const d = r.date || "";
      if (d.slice(5) !== md) return;
      const y = d.slice(0, 4);
      const a = (finAgg[y] = finAgg[y] || { n: 0, exp: 0, inc: 0 });
      a.n++;
      if (r.type === "income") a.inc += Number(r.amount || 0);
      else if (r.type === "expense") a.exp += Number(r.amount || 0);
    });
    Object.keys(finAgg).forEach((y) => {
      const a = finAgg[y];
      push(y, { icon: "🧾", text: `记账 ${a.n} 笔 · 支出 ¥${money(a.exp)} · 收入 ¥${money(a.inc)}`, go: "#/finance" });
    });

    // 任务：当年同日完成 / 新建（各取前 3 条）
    const tDone = {}, tNew = {};
    (tasks || []).forEach((t) => {
      if ((t.doneAt || "").slice(5) === md) (tDone[t.doneAt.slice(0, 4)] = tDone[t.doneAt.slice(0, 4)] || []).push("完成：" + t.title);
      const c = (t.createdAt || "").slice(0, 10);
      if (c.slice(5) === md) (tNew[c.slice(0, 4)] = tNew[c.slice(0, 4)] || []).push("新建：" + t.title);
    });
    const cap = (arr) => (arr.length > 3 ? arr.slice(0, 3).concat(`…等 ${arr.length} 条`) : arr);
    Object.keys(tDone).forEach((y) => cap(tDone[y]).forEach((s) => push(y, { icon: "✅", text: s, go: "#/tasks" })));
    Object.keys(tNew).forEach((y) => cap(tNew[y]).forEach((s) => push(y, { icon: "📝", text: s, go: "#/tasks" })));

    // 笔记（创建/更新）
    const noteAgg = {};
    (notes || []).forEach((n) => {
      const d = (n.updatedAt || n.createdAt || "").slice(0, 10);
      if (d.slice(5) !== md) return;
      (noteAgg[d.slice(0, 4)] = noteAgg[d.slice(0, 4)] || []).push(n.title || "未命名笔记");
    });
    Object.keys(noteAgg).forEach((y) =>
      cap(noteAgg[y]).forEach((s) => push(y, { icon: "📖", text: `笔记：${s}`, go: "#/notes" }))
    );

    // 收藏
    const bmAgg = {};
    (bookmarks || []).forEach((b) => {
      const d = (b.createdAt || "").slice(0, 10);
      if (d.slice(5) !== md) return;
      (bmAgg[d.slice(0, 4)] = bmAgg[d.slice(0, 4)] || []).push(b.title || b.url);
    });
    Object.keys(bmAgg).forEach((y) =>
      cap(bmAgg[y]).forEach((s) => push(y, { icon: "🔖", text: `收藏：${s}`, go: "#/news" }))
    );

    // 理财交易
    (stocks || []).forEach((s) => {
      const d = (s.date || s.createdAt || "").slice(0, 10);
      if (d.slice(5) !== md) return;
      push(d.slice(0, 4), {
        icon: s.action === "sell" ? "📉" : "📈",
        text: `${s.action === "sell" ? "卖出" : "买入"}${s.name || s.code} ${Number(s.shares || 0)} ${s.type === "fund" ? "份" : "股"} @ ¥${Number(s.price || s.cost || 0).toFixed(2)}`,
        go: "#/stocks",
      });
    });

    // 时间轴事件（全部展示，通常很少）
    (timeline || []).forEach((e) => {
      const d = e.date || "";
      if (d.slice(5) !== md) return;
      push(d.slice(0, 4), { icon: (CATS[e.category] || CATS.other).emoji, text: e.title, go: "#/timeline" });
    });

    return Object.keys(byYear)
      .sort((a, b) => b.localeCompare(a))
      .map((y) => ({ year: y, items: byYear[y] }));
  }

  // ---------- 页面 ----------
  let editingId = null;
  let filterCat = "";

  function formHtml(item) {
    const it = item || {};
    return `
      <div class="row">
        <input type="date" id="tlDate" value="${esc(it.date || todayStr())}" title="日期" style="max-width:150px" />
        <input class="grow" id="tlTitle" placeholder="标题（如：新房交房 / 入职新公司 / 三亚之旅）" maxlength="60" value="${esc(it.title || "")}" />
        <select id="tlCat">
          ${Object.keys(CATS).map((k) => `<option value="${k}" ${it.category === k ? "selected" : ""}>${CATS[k].emoji} ${CATS[k].name}</option>`).join("")}
        </select>
      </div>
      <div class="row sp-t-sm">
        <input class="grow" id="tlDesc" placeholder="描述（可选，当时发生了什么）" maxlength="300" value="${esc(it.desc || "")}" />
        <input id="tlTags" placeholder="标签（逗号分隔，可选）" maxlength="40" style="max-width:180px" value="${esc((it.tags || []).join(","))}" />
      </div>
      <div class="row sp-t-sm">
        <input class="grow" id="tlLink" placeholder="相关链接（可选：笔记/账单/文章…）" value="${esc(it.link || "")}" />
        <button class="btn in-card-btn" id="tlSave">${it.id ? "保存修改" : "添加事件"}</button>
        ${it.id ? '<button class="btn ghost" id="tlCancel">取消</button>' : ""}
      </div>`;
  }

  function entryHtml(e) {
    const c = CATS[e.category] || CATS.other;
    const tags = (e.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    return `
      <div class="tl-ev">
        <div class="tl-ev-date"><b>${esc((e.date || "").slice(5))}</b><small>${esc((e.date || "").slice(0, 4))}</small></div>
        <div class="tl-ev-body">
          <div class="tl-ev-title">${c.emoji} ${esc(e.title)} <span class="tl-ev-cat">${c.name}</span></div>
          ${e.desc ? `<div class="tl-ev-desc">${esc(e.desc)}</div>` : ""}
          <div class="tl-ev-meta">${tags}${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener" class="c-accent">🔗 相关链接</a>` : ""}</div>
        </div>
        <div class="tl-ev-ops">
          <button class="icon-btn plain" data-tledit="${e.id}" title="编辑">✏️</button>
          <button class="icon-btn plain" data-tldel="${e.id}" title="删除">🗑️</button>
        </div>
      </div>`;
  }

  routes.timeline = {
    title: "时间轴",
    async render(el) {
      const today = todayStr();
      const [items, finance, tasks, notes, bookmarks, stocks] = await Promise.all([
        tRepo().list().catch(() => []),
        repo("finance").list().catch(() => []),
        repo("tasks").list().catch(() => []),
        repo("notes").list().catch(() => []),
        repo("bookmarks").list().catch(() => []),
        repo("stocks").list().catch(() => []),
      ]);
      if (location.hash !== "#/timeline") return; // 慢请求期间已切走路由

      const list = (items || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      const shown = filterCat ? list.filter((e) => (e.category || "other") === filterCat) : list;

      // 按年分组
      const groups = {};
      shown.forEach((e) => {
        const y = (e.date || "未知").slice(0, 4);
        (groups[y] = groups[y] || []).push(e);
      });
      const yearKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));

      // 往年今日
      const otd = onThisDay({ today, finance, tasks, notes, bookmarks, stocks, timeline: items });
      const otdHtml = otd.length
        ? otd
            .slice(0, 5)
            .map(
              (g) => `
        <div class="otd-year">
          <div class="otd-y-label">${g.year} 年的今天</div>
          <div class="otd-items">${g.items.slice(0, 6).map((i) => `<div class="otd-item" data-go="${i.go || ""}">${i.icon} ${esc(i.text)}</div>`).join("")}</div>
        </div>`
            )
            .join("")
        : '<div class="empty">暂无往年今日数据。坚持记账、写笔记、记录事件，明年的今天这里就有回忆了</div>';

      el.innerHTML = `
        <div class="card">
          <h2>往年今日<span class="count">${today.slice(5)}</span></h2>
          ${otdHtml}
        </div>
        <div class="card">
          <h2>${editingId ? "编辑事件" : "记录人生事件"}<span class="count">发生过什么</span></h2>
          ${formHtml(editingId ? list.find((x) => x.id === editingId) : null)}
        </div>
        <div class="card">
          <h2>人生时间轴<span class="count">${list.length} 件事</span></h2>
          <div class="row sp-b-md">
            <select id="tlFilter">
              <option value="">全部分类</option>
              ${Object.keys(CATS).map((k) => `<option value="${k}" ${filterCat === k ? "selected" : ""}>${CATS[k].emoji} ${CATS[k].name}</option>`).join("")}
            </select>
          </div>
          ${yearKeys.length
            ? yearKeys
                .map(
                  (y) => `
            <div class="tl-year-group">
              <div class="tl-year">${y}</div>
              ${groups[y].map((e) => entryHtml(e)).join("")}
            </div>`
                )
                .join("")
            : `<div class="empty">${filterCat ? "该分类下还没有事件" : "还没有记录。买房、换工作、旅行、重要考试……把人生大事记下来"}</div>`}
        </div>
        <div class="footnote">时间轴只记录"发生过什么"，刻意保持轻量；日常任务/账单/笔记在各自主页记录，这里放值得多年后回看的事。</div>`;

      // ---- 表单事件 ----
      const saveBtn = el.querySelector("#tlSave");
      saveBtn.addEventListener("click", async () => {
        const titleInput = el.querySelector("#tlTitle");
        const dateInput = el.querySelector("#tlDate");
        const title = titleInput.value.trim();
        const date = dateInput.value;
        if (!title) return flashInvalid(titleInput);
        if (!date) return flashInvalid(dateInput);
        const base = editingId ? list.find((x) => x.id === editingId) : null;
        await tRepo().put({
          id: base ? base.id : uid(),
          date,
          title,
          category: el.querySelector("#tlCat").value,
          desc: el.querySelector("#tlDesc").value.trim(),
          tags: parseTags(el.querySelector("#tlTags").value),
          link: el.querySelector("#tlLink").value.trim(),
          createdAt: (base && base.createdAt) || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        showToast(editingId ? "已保存" : "已记录", "ok");
        editingId = null;
        routes.timeline.render(el);
      });
      el.querySelector("#tlTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });
      const cancelBtn = el.querySelector("#tlCancel");
      if (cancelBtn) cancelBtn.addEventListener("click", () => { editingId = null; routes.timeline.render(el); });

      // ---- 列表事件 ----
      el.querySelectorAll("[data-tledit]").forEach((b) =>
        b.addEventListener("click", () => {
          editingId = b.dataset.tledit;
          routes.timeline.render(el);
          window.scrollTo({ top: 0, behavior: "smooth" });
        })
      );
      el.querySelectorAll("[data-tldel]").forEach((b) =>
        b.addEventListener("click", async () => {
          const e = list.find((x) => x.id === b.dataset.tldel);
          if (!confirm(`删除事件「${e ? e.title : ""}」？`)) return;
          await tRepo().delete(b.dataset.tldel);
          showToast("已删除", "info");
          routes.timeline.render(el);
        })
      );
      el.querySelector("#tlFilter").addEventListener("change", (e) => {
        filterCat = e.target.value;
        routes.timeline.render(el);
      });

      // 往年今日条目点击跳转
      el.querySelectorAll(".otd-item[data-go]").forEach((n) =>
        n.addEventListener("click", () => {
          const go = n.getAttribute("data-go");
          if (go) location.hash = go;
        })
      );
    },
  };

  window.WB.timeline = { onThisDay: onThisDay };
})();
