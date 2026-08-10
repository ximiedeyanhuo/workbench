/**
 * app.js — 路由（hash）、明暗主题、全局搜索、仪表盘、设置页
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, todayStr, fmtMoney, safeUrl, getSetting, getSettings, setSetting, exportAll, importAll, debounce, flashInvalid, clearAllData, cssVar } = window.WB;

  // ========== 全局 Loading / Toast 提示 ==========
  function showLoading(text = "加载中...") {
    let el = document.getElementById("globalLoading");
    if (!el) {
      el = document.createElement("div");
      el.id = "globalLoading";
      el.className = "wb-loading";
      el.innerHTML = '<span class="spinner"></span><span id="loadingText"></span>';
      document.body.appendChild(el);
    }
    document.getElementById("loadingText").textContent = text;
    el.style.display = "flex";
    return function hide() {
      el.style.display = "none";
    };
  }

  function showToast(text, type = "info") {
    const el = document.createElement("div");
    el.className = "wb-toast " + (type === "success" ? "success" : type === "error" ? "error" : type === "warning" ? "warning" : "");
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(function () {
      el.classList.add("hide");
      setTimeout(function () { return el.parentNode && el.parentNode.removeChild(el); }, 300);
    }, 3000);
  }

  // 导出到全局
  window.WB.showLoading = showLoading;
  window.WB.showToast = showToast;

  // ================= 主题 =================
  const THEME_KEY = "wb2_theme"; // localStorage 仅作即时缓存防闪烁，正式值在 settings
  // 主题循环顺序：亮 → 暗 → 森林(明) → 深夜(暗) → 亮…
  const THEMES = [
    { key: "light", icon: "☀️", text: "亮色模式" },
    { key: "dark", icon: "🌙", text: "暗色模式" },
    { key: "forest", icon: "🌲", text: "森林模式" },
    { key: "midnight", icon: "🌌", text: "深夜模式" },
  ];
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const m = THEMES.find((x) => x.key === theme) || THEMES[0];
    const label = m.icon, text = m.text;
    const btn = document.getElementById("themeBtn");
    const btnTop = document.getElementById("themeBtnTop");
    if (btn) btn.innerHTML = label + " <span>" + text + "</span>";
    if (btnTop) btnTop.textContent = label;
    // 同步 meta theme-color，让移动端状态栏/地址栏跟随主题
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute("content", theme === "dark" || theme === "midnight" ? "#0b1116" : "#f3eee2");
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    const idx = THEMES.findIndex((x) => x.key === cur);
    const next = THEMES[(idx + 1) % THEMES.length].key;
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
    setSetting("theme", next);
  }
  function initTheme() {
    let t = "light";
    try { t = localStorage.getItem(THEME_KEY) || "light"; } catch (e) { /* ignore */ }
    applyTheme(t);
    document.getElementById("themeBtn").addEventListener("click", toggleTheme);
    document.getElementById("themeBtnTop").addEventListener("click", toggleTheme);
  }

  // ================= 路由 =================
  function currentRoute() {
    const m = location.hash.match(/^#\/([a-z]+)/);
    const name = m ? m[1] : "dashboard";
    return routes[name] ? name : "dashboard";
  }
  let navSeq = 0; // 渲染代数锁：防止慢路由回调覆盖已切走的页面
  async function navigate() {
    const name = currentRoute();
    const route = routes[name];
    const token = ++navSeq;
    document.getElementById("pageTitle").textContent = route.title;
    document.title = route.title + " · 个人工作台";
    document.querySelectorAll("[data-route]").forEach((a) => {
      a.classList.toggle("active", a.dataset.route === name);
    });
    // 当前路由所在的侧边栏分组自动展开（不强制收起其他，保留用户手动展开）
    const activeSub = document.querySelector('.nav-sub a[data-route="' + name + '"]');
    if (activeSub) {
      const g = activeSub.closest(".nav-group");
      if (g && !g.classList.contains("open")) {
        g.classList.add("open");
        const p = g.querySelector(".nav-parent");
        if (p) p.setAttribute("aria-expanded", "true");
      }
    }
    // 移动端：当前路由属于「更多」面板时高亮底栏更多按钮；切换路由后关闭面板
    const moreBtn = document.getElementById("tabMoreBtn");
    if (moreBtn) {
      moreBtn.classList.toggle("active", MORE_ROUTES.indexOf(name) !== -1);
    }
    closeMoreSheet();
    const view = document.getElementById("view");
    view.innerHTML = '<div class="wb-skeleton" aria-hidden="true">'
      + '<div class="sk-line"></div><div class="sk-line"></div><div class="sk-line short"></div>'
      + '<div class="sk-block"></div><div class="sk-block"></div>'
      + '</div>';
    try {
      await route.render(view);
      if (token !== navSeq) return; // 渲染期间已切走：丢弃本次结果，避免污染新页面
    } catch (err) {
      if (token !== navSeq) return;
      view.innerHTML = '<div class="card"><div class="empty">页面加载失败：' + esc(err && err.message) + "</div></div>";
    }
  }

  // ================= 全局搜索 =================
  function initGlobalSearch() {
    const input = document.getElementById("gsInput");
    const panel = document.getElementById("gsPanel");
    const wrap = document.getElementById("gsWrap");

    const close = () => { panel.hidden = true; };

    /** 跨模块跳转：写入 WB.jump 句柄后切 hash；已在目标页时 hash 不变需手动重渲染 */
    function go(hash) {
      close();
      input.value = "";
      if (location.hash === hash) navigate();
      else location.hash = hash;
    }

    async function doSearch() {
      const q = input.value.trim().toLowerCase();
      if (!q) return close();
      const [tasks, notes, marks, links, finances, habits] = await Promise.all([
        repo("tasks").list(), repo("notes").list(), repo("bookmarks").list(), repo("quicklinks").list(),
        repo("finance").list(), repo("habits").list(),
      ]).catch(() => [[], [], [], [], [], []]);
      const hit = (s) => String(s || "").toLowerCase().includes(q);
      const groups = [
        { name: "✅ 任务", type: "task", rows: tasks.filter((t) => hit(t.title) || hit(t.note) || (t.tags || []).some(hit)) },
        { name: "📚 笔记", type: "note", rows: notes.filter((n) => hit(n.title) || hit(n.content) || hit(n.folder)) },
        { name: "💰 记账", type: "fin", rows: finances.filter((f) => hit(f.note) || hit(f.category)) },
        { name: "🌱 习惯", type: "habit", rows: habits.filter((h) => hit(h.name)) },
        { name: "🔖 收藏", type: "url", rows: marks.filter((m) => hit(m.title) || hit(m.url) || (m.tags || []).some(hit)) },
        { name: "🚀 快捷入口", type: "url", rows: links.filter((l) => hit(l.name) || hit(l.url)) },
      ].filter((g) => g.rows.length);

      if (!groups.length) {
        panel.innerHTML = '<div class="gs-empty">没有找到匹配内容</div>';
        panel.hidden = false;
        return;
      }
      // 每组最多展示 5 条，超出的折叠成"更多 N 条"
      const MAX = 5;
      panel.innerHTML = groups
        .map((g) => {
          const rows = g.rows.slice(0, MAX);
          const more = g.rows.length - rows.length;
          const moreHtml = more > 0
            ? `<div class="gs-more" data-group="${g.name}" data-type="${g.type}">… 还有 ${more} 条，点此跳转该页查看</div>`
            : "";
          const body = rows.map((r) => {
            const title = esc(r.title || r.name || "(无标题)");
            if (g.type === "task")
              return `<div class="gs-item" data-t="task" data-id="${r.id}"><span class="gs-txt">${title}</span><span class="gs-sub">${esc(r.dueDate || "")}</span></div>`;
            if (g.type === "note")
              return `<div class="gs-item" data-t="note" data-id="${r.id}"><span class="gs-txt">${title}</span><span class="gs-sub">${esc(r.folder || "")}</span></div>`;
            if (g.type === "fin") {
              const sign = r.type === "expense" ? "-" : r.type === "income" ? "+" : "";
              const amt = r.type === "expense" ? "支出" : r.type === "income" ? "收入" : "储蓄";
              return `<div class="gs-item" data-t="fin" data-id="${r.id}"><span class="gs-txt">${esc(r.note || r.category || "记账")}</span><span class="gs-sub">${amt} ${sign}${Number(r.amount || 0)} · ${esc(r.date || "")}</span></div>`;
            }
            if (g.type === "habit")
              return `<div class="gs-item" data-t="habit" data-id="${r.id}"><span class="gs-txt">${title}</span><span class="gs-sub">连续 ${esc(r.streak || "") || "打卡"}</span></div>`;
            return `<div class="gs-item" data-t="url" data-url="${esc(r.url)}"><span class="gs-txt">${title}</span><span class="gs-sub">打开 ↗</span></div>`;
          }).join("");
          return `<div class="gs-group">${g.name}</div>${body}${moreHtml}`;
        })
        .join("");
      panel.hidden = false;
    }

    input.addEventListener("input", debounce(doSearch, 250));
    input.addEventListener("focus", () => { if (input.value.trim()) doSearch(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { close(); input.blur(); } });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });

    panel.addEventListener("click", (e) => {
      const item = e.target.closest(".gs-item");
      if (item) {
        if (item.dataset.t === "task") { WB.jump.taskId = item.dataset.id; go("#/tasks"); }
        else if (item.dataset.t === "note") { WB.jump.noteId = item.dataset.id; go("#/notes"); }
        else if (item.dataset.t === "fin") { go("#/finance"); }
        else if (item.dataset.t === "habit") { go("#/life"); }
        else window.open(safeUrl(item.dataset.url), "_blank", "noopener");
        return;
      }
      // "更多 N 条"：点击跳转对应页面（不带关键词时直接展示全部）
      const more = e.target.closest(".gs-more");
      if (more) {
        const type = more.dataset.type;
        if (type === "task") go("#/tasks");
        else if (type === "note") go("#/notes");
        else if (type === "fin") go("#/finance");
        else if (type === "habit") go("#/life");
        else if (type === "url") { /* 收藏/入口混合，跳入口页 */ go("#/links"); }
      }
    });
  }

  // ================= 仪表盘 =================
  let dashCharts = []; // 重渲染前销毁旧实例，避免 Chart.js 残留引用
  let dashArchiveOpen = false; // 归档区（数据概览）展开状态：重渲染后保留用户选择

  function renderCharts(el, tasks, habits, finance) {
    if (typeof Chart === "undefined") return; // chart.umd.min.js 未加载时静默降级
    dashCharts.forEach((c) => c.destroy());
    dashCharts = [];

    const primary = cssVar("--primary"), ok = cssVar("--ok"), purple = cssVar("--purple"),
      muted = cssVar("--muted"), line = cssVar("--line"), accent = cssVar("--accent"),
      danger = cssVar("--danger");
    const baseOpt = {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 }, precision: 0 }, grid: { color: line } },
      },
    };

    // ① 财务：最近 6 个月支出（只统计 expense 类型；旧记录无 type 视为 saving 不计入）
    const months = [];
    const mNow = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(mNow.getFullYear(), mNow.getMonth() - i, 1);
      months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
    }
    const finByM = months.map((m) =>
      finance.filter((r) => r.type === "expense" && (r.date || "").slice(0, 7) === m).reduce((s, r) => s + Number(r.amount || 0), 0)
    );

    // ①⁺ 净资产趋势：近 12 月末累计储蓄（saving 类型按月累加），最后一点叠加当前持仓市值
    const nwMonths = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(mNow.getFullYear(), mNow.getMonth() - i, 1);
      nwMonths.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
    }
    const savedByM = nwMonths.map((m) =>
      finance.filter((r) => r.type === "saving" && (r.date || "").slice(0, 7) <= m).reduce((s, r) => s + Number(r.amount || 0), 0)
    );
    // 当前市值同步估算：本地无历史股价，按持仓成本为最新点叠加值（与净资产卡"持仓市值"块一致）
    const liveMarketVal = stockCostVal || 0;
    const nwSeries = savedByM.map((s, i) => (i === nwMonths.length - 1 ? s + liveMarketVal : s));
    const nwDelta = nwSeries.length > 1 ? nwSeries[nwSeries.length - 1] - nwSeries[0] : 0;
    const nwHint = nwDelta === 0
      ? "近 12 月无变化"
      : `${nwDelta > 0 ? "+" : ""}${fmtMoney(nwDelta)}（较 12 月前）`;

    // ②③ 近 14 天：打卡数 / 任务完成数
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      days.push(WB.dateStr(d));
    }
    const habitByD = days.map((ds) => habits.filter((h) => h.checkins && h.checkins[ds]).length);
    const doneByD = days.map((ds) => tasks.filter((t) => t.done && t.doneAt === ds).length);
    const dayLabs = days.map((ds) => ds.slice(5));

    const mk = (id, cfg) => {
      const cv = el.querySelector("#" + id);
      if (cv) dashCharts.push(new Chart(cv, cfg));
    };
    mk("chartFin", {
      type: "bar",
      data: { labels: months.map((m) => m.slice(2)), datasets: [{ data: finByM, backgroundColor: danger, borderRadius: 8 }] },
      options: baseOpt,
    });
    mk("chartHabit", {
      type: "bar",
      data: { labels: dayLabs, datasets: [{ data: habitByD, backgroundColor: ok, borderRadius: 8 }] },
      options: baseOpt,
    });
    mk("chartTask", {
      type: "line",
      data: { labels: dayLabs, datasets: [{ data: doneByD, borderColor: accent, backgroundColor: accent, tension: 0.35, pointRadius: 2.5 }] },
      options: baseOpt,
    });
    // ①⁺ 净资产趋势（独立坐标轴，柱条 + 平滑折线复合，强调"储蓄积累"语义）
    const nwLine = nwSeries[nwSeries.length - 1] - nwSeries[0] >= 0 ? ok : danger;
    const nwFill = nwLine === ok ? "rgba(74, 158, 99, 0.10)" : "rgba(204, 102, 102, 0.10)";
    mk("chartNetWorth", {
      type: "line",
      data: {
        labels: nwMonths.map((m) => m.slice(2)),
        datasets: [{
          data: nwSeries,
          borderColor: nwLine,
          backgroundColor: nwFill,
          fill: true,
          tension: 0.35,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => "净资产 " + fmtMoney(c.parsed.y) } } },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
          y: { ticks: { color: muted, font: { size: 10 }, precision: 0, callback: (v) => v >= 10000 ? (v / 10000).toFixed(1) + "万" : v }, grid: { color: line } },
        },
      },
    });
    const hintEl = el.querySelector("#nwTrendHint");
    if (hintEl) hintEl.textContent = nwHint;
  }

  routes.dashboard = {
    title: "仪表盘",
    async render(el) {
      const [tasks, habits, finance, notes, stocks, exams, st] = await Promise.all([
        repo("tasks").list(),
        repo("habits").list(),
        repo("finance").list(),
        repo("notes").list(),
        repo("stocks").list(),
        repo("mockexams").list(),
        // 一次批量读全部 settings，避免 5 次独立 API 往返
        getSettings({ nickname: "朋友", saveTarget: 60000, gongkao_targets: [], monthBudget: 0, weeklyReview: null }),
      ]);
      const nickname = st.nickname, target = st.saveTarget, gkTargets = st.gongkao_targets, monthBudget = st.monthBudget, weeklyCache = st.weeklyReview;

      const today = todayStr();
      const now = new Date();
      const h = now.getHours();
      const greet = h < 6 ? "凌晨好" : h < 12 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
      const wk = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];

      const active = tasks.filter((t) => !t.done);
      const overdue = active.filter((t) => t.dueDate && t.dueDate < today);
      const dueToday = active.filter((t) => t.dueDate === today);
      const focus = overdue.concat(dueToday);
      // 今日已检票：勾选后重新渲染会出现在「已检票」区（撕票虚线分隔）
      const doneToday = tasks.filter((t) => t.done && t.doneAt === today);
      // 时间轴刻度：带时刻的 dueDate 用具体时段；纯日期任务按优先级分上/下午/晚上，逾期走「逾期」刻度
      const tlSlot = (t) => {
        const d = t.dueDate || "";
        if (d.length > 10) {
          const h = parseInt(d.slice(11, 13), 10);
          if (!isNaN(h)) return (h < 12 ? "上午" : h < 18 ? "下午" : "晚上") + " " + (d.slice(11, 16) || "");
        }
        if (t.dueDate < today) return "逾期";
        if (t.priority === "high") return "上午";
        if (t.priority === "mid") return "下午";
        return "晚上";
      };
      const slotRank = { 逾期: 0, 上午: 1, 下午: 2, 晚上: 3 };
      const focusSorted = focus.slice().sort((a, b) => {
        const ra = slotRank[tlSlot(a)] !== undefined ? slotRank[tlSlot(a)] : 9;
        const rb = slotRank[tlSlot(b)] !== undefined ? slotRank[tlSlot(b)] : 9;
        return ra - rb || (a.dueDate || "").localeCompare(b.dueDate || "");
      });
      const tlRow = (t, done) => `
        <div class="item tl-item ${done ? "done" : ""}" data-id="${t.id}">
          <span class="tl-slot ${done ? "ok" : t.dueDate < today ? "late" : ""}">${done ? "正点" : tlSlot(t)}</span>
          <span class="tl-main">
            ${done ? '<span class="chk"></span>' : '<span class="chk" data-act="toggle"></span>'}
            <span class="txt">${esc(t.title)}</span>
            ${t.priority ? `<span class="badge ${priCls[t.priority] || "b-primary"}">${priLab[t.priority] || ""}优先</span>` : ""}
            ${done
              ? '<span class="badge b-ok">已检票</span>'
              : `<span class="badge ${t.dueDate < today ? "b-danger" : "b-warn"}">${t.dueDate < today ? "已逾期 " + t.dueDate.slice(5) : "今天到期"}</span>`}
          </span>
        </div>`;

      // 本周（周一~周日）待办
      const mon = new Date(now);
      mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const monStr = WB.dateStr(mon), sunStr = WB.dateStr(sun);
      const weekCnt = active.filter((t) => t.dueDate && t.dueDate >= monStr && t.dueDate <= sunStr).length;

      const habitDone = habits.filter((hb) => hb.checkins && hb.checkins[today]).length;
      // 储蓄进度：只算 saving 类型（旧数据无 type 视为 saving）
      const saved = finance.filter((r) => !r.type || r.type === "saving").reduce((s, x) => s + Number(x.amount || 0), 0);
      const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;

      // 本年收支：新记账口径（income / expense）
      const curYear = today.slice(0, 4);
      const yearTx = finance.filter((r) => (r.date || "").slice(0, 4) === curYear);
      const mIncome = yearTx.filter((r) => r.type === "income").reduce((s, x) => s + Number(x.amount || 0), 0);
      const mExpense = yearTx.filter((r) => r.type === "expense").reduce((s, x) => s + Number(x.amount || 0), 0);
      const mNet = mIncome - mExpense;
      const netSign = mNet >= 0 ? "+" : "-";
      const netColor = mNet >= 0 ? "var(--ok)" : "var(--danger)";

      const priCls = { high: "b-danger", mid: "b-warn", low: "b-primary" };
      const priLab = { high: "高", mid: "中", low: "低" };

      // 考公倒计时横幅：取最近一个未结束的考试目标挂首页顶部（与考公页同一份 settings 数据）
      const upcoming = (gkTargets || [])
        .filter((tg) => tg.date && tg.date >= today)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      let gkBanner = "";
      if (upcoming) {
        const gkDiff = Math.round((new Date(upcoming.date + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
        const urgent = gkDiff <= 7;
        gkBanner = `<div class="dash-gk ${urgent ? "urgent" : ""}" data-go="#/gongkao" title="去考公页">
          <span class="dash-gk-ico">🎯</span>
          <span class="dash-gk-name">${esc(upcoming.name)}<small>${esc(upcoming.type || "考试")} · ${esc(upcoming.date)}</small></span>
          <span class="dash-gk-day">${gkDiff === 0 ? "就在今天" : `还有 <b>${gkDiff}</b> 天`}</span>
        </div>`;
      }

      // 月度预算提醒：设了预算才展示，超支标红（预算在记账页设置）
      const overBudget = monthBudget > 0 && mExpense > monthBudget;
      const budgetHint = monthBudget > 0
        ? ` · 预算 ${fmtMoney(monthBudget)}${overBudget ? ` <b style="color:var(--danger)">已超支 ${fmtMoney(mExpense - monthBudget)}</b>` : ""}`
        : "";
      // 仪表盘预算横幅：超支/按日均预测将超支/无预算 三档；只在「需提醒」场景出现
      const passedD = Math.max(1, now.getDate());
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const proj = monthBudget > 0 ? Math.round((mExpense / passedD) * daysInMonth) : 0;
      const projOver = monthBudget > 0 && !overBudget && proj > monthBudget * 1.1;
      const budgetBanner = overBudget
        ? `<div class="dash-banner over" data-go="#/finance">⚠ 本月支出 ${fmtMoney(mExpense)} 已超预算 ${fmtMoney(monthBudget)} · 超支 ${fmtMoney(mExpense - monthBudget)} 元 · <span class="c-accent">去记账页</span></div>`
        : projOver
          ? `<div class="dash-banner warn" data-go="#/finance">⚠ 按当前日均推算整月 ${fmtMoney(proj)}，将超出预算 ${fmtMoney(monthBudget)} 约 ${fmtMoney(proj - monthBudget)} 元 · <span class="c-accent">去记账页</span></div>`
          : "";

      // 储蓄目标临近提醒：设了目标且已存够 90% 时提示（达成则庆祝）
      const saveBanner = target > 0 && saved > 0
        ? saved >= target
          ? `<div class="dash-banner ok" data-go="#/finance">🎉 年度储蓄目标已达成：${fmtMoney(saved)} / ${fmtMoney(target)} · <span class="c-accent">去记账页</span></div>`
          : saved >= target * 0.9
            ? `<div class="dash-banner ok" data-go="#/finance">🏆 储蓄目标快达标了：已存 ${pct}%（${fmtMoney(saved)} / ${fmtMoney(target)}），再存 ${fmtMoney(target - saved)} 就达成 · <span class="c-accent">去记账页</span></div>`
            : ""
        : "";

      // 净资产总览：累计储蓄 + 持仓市值（股票行情 / 基金净值异步补齐，先按成本价兜底显示）
      // 按 code 聚合流水（含旧快照迁移：无 action 视为买入，price=cost）；holding=Σ买-Σ卖，avgCost=Σ买额/Σ买量
      const aggregateStocks = (txs) => {
        const groups = {};
        txs.forEach((tx) => {
          if (!tx.code) return;
          const g = groups[tx.code] || (groups[tx.code] = { code: tx.code, name: tx.name, type: tx.type, holding: 0, buyShares: 0, buyAmt: 0 });
          const shares = Number(tx.shares || 0);
          const price = Number(tx.action ? (tx.price || 0) : (tx.cost || 0));
          if (tx.action === "sell") g.holding -= shares;
          else { g.holding += shares; g.buyShares += shares; g.buyAmt += shares * price; }
        });
        return Object.keys(groups).map((code) => {
          const g = groups[code];
          g.avgCost = g.buyShares > 0 ? g.buyAmt / g.buyShares : 0;
          return g;
        });
      };
      const allGroups = aggregateStocks(stocks);
      const stockHoldings = allGroups.filter((g) => (g.type || "stock") !== "fund" && g.holding > 0);
      const fundHoldings = allGroups.filter((g) => (g.type || "stock") === "fund" && g.holding > 0);
      const holdings = allGroups.filter((g) => g.holding > 0);
      const stockCostVal = holdings.reduce((s, g) => s + g.avgCost * g.holding, 0);
      const showNetWorth = saved > 0 || holdings.length > 0;
      const nwHtml = showNetWorth
        ? `<div class="card">
            <h2>净资产总览<span class="count">储蓄 + 持仓</span></h2>
            <div class="stat-grid">
              <div class="stat" data-go="#/finance"><div class="s-lab">累计储蓄</div><div class="s-val">${fmtMoney(saved)}</div><div class="s-sub">「储蓄」类型合计</div></div>
              <div class="stat" data-go="#/stocks"><div class="s-lab">持仓市值</div><div class="s-val" id="nwStock">${fmtMoney(stockCostVal)}</div><div class="s-sub" id="nwStockSub">${holdings.length ? "行情加载中…" : "暂无持仓"}</div></div>
              <div class="stat" data-go="#/stocks"><div class="s-lab">今日盈亏</div><div class="s-val c-muted" id="nwDay">—</div><div class="s-sub">股票涨跌 + 基金净值差</div></div>
              <div class="stat"><div class="s-lab">净资产合计</div><div class="s-val" id="nwTotal">${fmtMoney(saved + stockCostVal)}</div><div class="s-sub">储蓄 + 市值</div></div>
            </div>
            <div class="nw-trend"><canvas id="chartNetWorth" height="90"></canvas><div class="nw-trend-hint" id="nwTrendHint"></div></div>
          </div>`
        : "";

      // 到期任务浏览器通知：权限未授予时给一个开启入口（点击才请求，避免打扰）
      const canNotify = "Notification" in window;
      const notifyBtnHtml = canNotify && Notification.permission === "default" && focus.length
        ? ' <button class="btn sm ghost sp-l-md" id="notifyBtn" title="每天首次打开时提醒当日到期/逾期任务">🔔 开启到期提醒</button>'
        : "";

      // 每周回顾：本周（周一至今）关键数据，AI 点评按周缓存在 settings（键 weeklyReview）
      const weekDays = [];
      for (let wd = new Date(mon); WB.dateStr(wd) <= today; wd.setDate(wd.getDate() + 1)) weekDays.push(WB.dateStr(wd));
      const wkDone = tasks.filter((t) => t.done && t.doneAt && t.doneAt >= monStr && t.doneAt <= today).length;
      const wkNew = tasks.filter((t) => { const c = (t.createdAt || "").slice(0, 10); return c >= monStr && c <= today; }).length;
      const wkCheck = weekDays.reduce((s, ds) => s + habits.filter((hb) => hb.checkins && hb.checkins[ds]).length, 0);
      const wkCheckFull = habits.length * weekDays.length;
      const wkExpTx = finance.filter((r) => r.type === "expense" && r.date >= monStr && r.date <= today);
      const wkExp = wkExpTx.reduce((s, r) => s + Number(r.amount || 0), 0);
      const expByCat = {};
      wkExpTx.forEach((r) => { expByCat[r.category] = (expByCat[r.category] || 0) + Number(r.amount || 0); });
      const topCat = Object.keys(expByCat).sort((a, b) => expByCat[b] - expByCat[a])[0];
      const CAT_NAMES = { food: "餐饮", traffic: "交通", shopping: "购物", housing: "居家", fun: "娱乐", health: "医疗健康", study: "学习", "other-e": "其它" };
      const wkExams = exams.filter((x) => x.date >= monStr && x.date <= today);
      const wkNotes = notes.filter((n) => (n.updatedAt || "").slice(0, 10) >= monStr).length;
      const wrStats = [
        `✅ 任务：完成 ${wkDone} 项 · 新增 ${wkNew} 项 · 当前逾期 ${overdue.length} 项`,
        `🌱 打卡：${wkCheck} / ${wkCheckFull} 次（${wkCheckFull ? Math.round((wkCheck / wkCheckFull) * 100) : 0}%）`,
        `💰 支出：${fmtMoney(wkExp)}${topCat ? ` · 大头是${esc(CAT_NAMES[topCat] || topCat)}（${fmtMoney(expByCat[topCat])}）` : ""}`,
        wkExams.length ? `📝 模考：${wkExams.length} 场 · ${esc(wkExams.map((x) => `${x.subject} ${Number(x.score || 0).toFixed(1)}分`).join("、"))}` : "📝 模考：本周没有记录",
        `📚 笔记：更新 ${wkNotes} 篇`,
      ];
      const wrCached = weeklyCache && weeklyCache.week === monStr ? weeklyCache : null;

      // 行动入口：打卡 / 记一笔 / 最近笔记，在仪表盘直接操作不用跳页
      const habitRows = habits.length
        ? habits
            .map((hb) => {
              const done = !!(hb.checkins && hb.checkins[today]);
              return `<li class="item">
                <span class="dot" style="background:${esc(hb.color || "var(--ok)")}"></span>
                <span class="txt" ${done ? 'style="color:var(--muted)"' : ""}>${esc(hb.name)}</span>
                <button class="btn sm ${done ? "ghost" : ""}" data-hid="${hb.id}">${done ? "✓ 已打卡" : "打卡"}</button>
              </li>`;
            })
            .join("")
        : '<div class="empty">还没有习惯，去 <a href="#/life">生活</a> 页添加一个</div>';

      const recentNotes = notes
        .slice()
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
        .slice(0, 3);
      const noteRows = recentNotes.length
        ? recentNotes
            .map(
              (n) => `<li class="item cur-p" data-nid="${n.id}">
                <span class="txt">${esc(n.title || "未命名笔记")}</span>
                <span class="meta">${(n.updatedAt || "").slice(5, 16).replace("T", " ")}</span>
              </li>`
            )
            .join("")
        : '<div class="empty">还没有笔记，去 <a href="#/notes">沉淀</a> 页开始记录</div>';

      el.innerHTML = `
        <div class="hero-greet">${greet}，${esc(nickname)}！</div>
        <div class="hero-date">${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · 星期${wk}${
          focus.length ? " · 今天有 " + focus.length + " 件事需要关注" : " · 今天没有到期事项，安心推进"
        }${notifyBtnHtml}</div>
        ${gkBanner}
        ${saveBanner}
        ${budgetBanner}
        <div class="stat-grid">
          <div class="stat" data-go="#/tasks"><div class="s-lab">今日到期 / 逾期</div><div class="s-val">${dueToday.length} / ${overdue.length}</div><div class="s-sub">共 ${active.length} 项进行中</div></div>
          <div class="stat" data-go="#/tasks"><div class="s-lab">本周待办</div><div class="s-val">${weekCnt}</div><div class="s-sub">${monStr.slice(5)} ~ ${sunStr.slice(5)}</div></div>
          <div class="stat" data-go="#/life"><div class="s-lab">今日打卡</div><div class="s-val">${habitDone} / ${habits.length}</div><div class="s-sub">${habits.length === 0 ? "还没有习惯" : habitDone >= habits.length ? "全部完成" : "继续加油"}</div></div>
          <div class="stat" data-go="#/finance"><div class="s-lab">本年结余</div><div class="s-val" style="color:${netColor}">${netSign}${fmtMoney(Math.abs(mNet))}</div><div class="s-sub">收入 ${fmtMoney(mIncome)} · 支出 ${fmtMoney(mExpense)}</div></div>
        </div>
        <div class="card">
          <h2>今日焦点<span class="count">${focus.length} 项</span></h2>
          <div class="focus-tl" id="focusList">
            ${focus.length === 0 ? '<div class="empty">今天没有到期或逾期的任务，去 <a href="#/tasks">事务</a> 里安排一下？</div>' : focusSorted.map((t) => tlRow(t, false)).join("")}
            ${doneToday.length ? '<div class="tl-sep"><span>已检票 · 今日完成</span></div>' + doneToday.slice(0, 8).map((t) => tlRow(t, true)).join("") : ""}
          </div>
        </div>
        <div class="dash-actions">
          <div class="card">
            <h2>今日打卡<span class="count">${habitDone} / ${habits.length}</span></h2>
            <ul class="list" id="dashHabits">${habitRows}</ul>
          </div>
          <div class="dash-col">
            <div class="card">
              <h2>快速记支出<span class="count">本月已支出 ${fmtMoney(mExpense)}${budgetHint}</span></h2>
              <div class="row">
                <select id="dFinCategory">
                  <option value="food">餐饮</option>
                  <option value="traffic">交通</option>
                  <option value="shopping">购物</option>
                  <option value="housing">居家</option>
                  <option value="fun">娱乐</option>
                  <option value="health">医疗健康</option>
                  <option value="study">学习</option>
                  <option value="other-e">其它</option>
                </select>
                <input id="dFinAmount" type="number" min="0.01" step="0.01" placeholder="金额" class="w-90" />
                <input class="grow" id="dFinNote" placeholder="备注（可选）" maxlength="50" />
                <button class="btn sm" id="dFinAdd">记账</button>
              </div>
              <div class="mini-bar"><i style="width:${pct}%"></i></div>
              <div class="mini-bar-lab">年度储蓄 ${fmtMoney(saved)} / ${fmtMoney(target)}（${pct}%） · <a href="#/finance" class="c-accent">去记账页</a></div>
            </div>
            <div class="card">
              <h2>最近沉淀</h2>
              <ul class="list" id="dashNotes">${noteRows}</ul>
            </div>
          </div>
        </div>
        <details class="archive" id="dashArchive" ${dashArchiveOpen ? "open" : ""}>
          <summary>
            <span class="ar-title"><span class="ar-diamond"></span>数据概览与每周回顾</span>
            <span class="ar-hint">净资产 · 图表 · AI 点评</span>
          </summary>
          <div class="archive-in">
            ${nwHtml}
            <div class="card">
              <h2>数据趋势</h2>
              <div class="chart-grid">
                <div class="chart-box"><div class="chart-tt">近 6 月支出（元）</div><canvas id="chartFin" height="150"></canvas></div>
                <div class="chart-box"><div class="chart-tt">近 14 天打卡数</div><canvas id="chartHabit" height="150"></canvas></div>
                <div class="chart-box"><div class="chart-tt">近 14 天任务完成数</div><canvas id="chartTask" height="150"></canvas></div>
              </div>
            </div>
            <div class="card">
              <h2>每周回顾<span class="count">${monStr.slice(5)} ~ ${today.slice(5)}</span></h2>
              <div class="wr-stats">${wrStats.map((s) => `<div>${s}</div>`).join("")}</div>
              <div id="wrAi">${wrCached ? '<div class="ai-panel">' + MD.render(wrCached.text) + "</div>" : ""}</div>
              <div class="row sp-t-md">
                <button class="btn sm" id="wrGen">✨ ${wrCached ? "重新生成 AI 点评" : "生成 AI 点评"}</button>
                ${wrCached ? `<span style="align-self:center;font-size:12px;color:var(--muted)">生成于 ${esc(wrCached.at || "")}</span>` : ""}
              </div>
            </div>
          </div>
        </details>
        <div class="footnote">数据保存在服务器 SQLite（workbench.db） · 建议定期到「设置」导出 JSON 备份</div>`;

      // 图表位于折叠归档区：折叠时 canvas 无尺寸，展开时才（重新）渲染
      const archiveEl = el.querySelector("#dashArchive");
      if (archiveEl) {
        archiveEl.addEventListener("toggle", () => {
          dashArchiveOpen = archiveEl.open;
          if (archiveEl.open) renderCharts(el, tasks, habits, finance);
        });
        if (archiveEl.open) renderCharts(el, tasks, habits, finance);
      } else {
        renderCharts(el, tasks, habits, finance);
      }

      el.querySelectorAll("[data-go]").forEach((s) => s.addEventListener("click", () => (location.hash = s.dataset.go)));
      el.querySelector("#focusList").addEventListener("click", async (e) => {
        const chk = e.target.closest('[data-act="toggle"]');
        if (!chk) return;
        const id = chk.closest("[data-id]").dataset.id;
        const t = await repo("tasks").get(id);
        if (t) {
          t.done = true; t.doneAt = todayStr();
          await repo("tasks").put(t);
          // 重复任务：完成后自动生成下一期（与事务页同一套逻辑）
          const next = WB.repeatNext(t);
          if (next) await repo("tasks").put(next);
          navigate();
        }
      });

      // 今日打卡：点击 toggle 当天打卡状态（与生活页同一份数据）
      el.querySelector("#dashHabits").addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-hid]");
        if (!btn) return;
        const hb = await repo("habits").get(btn.dataset.hid);
        if (!hb) return;
        hb.checkins = hb.checkins || {};
        if (hb.checkins[today]) delete hb.checkins[today]; else hb.checkins[today] = true;
        await repo("habits").put(hb);
        navigate();
      });

      // 快速记支出：仪表盘小卡快速录一笔当日支出（跳去记账页看更多）
      const dFinAdd = async () => {
        const amountInput = el.querySelector("#dFinAmount");
        const amount = parseFloat(amountInput.value);
        if (!(amount > 0)) return flashInvalid(amountInput);
        await repo("finance").put({
          id: uid(), type: "expense",
          category: el.querySelector("#dFinCategory").value,
          amount,
          note: el.querySelector("#dFinNote").value.trim(),
          date: today,
        });
        navigate();
      };
      el.querySelector("#dFinAdd").addEventListener("click", dFinAdd);
      el.querySelector("#dFinNote").addEventListener("keydown", (e) => { if (e.key === "Enter") dFinAdd(); });

      // 最近沉淀：经 WB.jump 句柄跳到笔记页并定位到该篇
      el.querySelector("#dashNotes").addEventListener("click", (e) => {
        const li = e.target.closest("[data-nid]");
        if (!li) return;
        WB.jump.noteId = li.dataset.nid;
        location.hash = "#/notes";
      });

      // 净资产：异步拉行情把成本价兜底值替换成实时市值（失败保持兜底显示）
      // 股票走 /api/stock/quote，基金走 /api/fund/nav（净值），合并计算市值与当日盈亏
      const nwCodes = [...new Set(holdings.map((r) => r.code).filter(Boolean))];
      if (showNetWorth && nwCodes.length && window.WB.USE_API) {
        (async () => {
          try {
            const [stockRes, fundRes] = await Promise.all([
              stockHoldings.length ? fetch("/api/stock/quote?codes=" + encodeURIComponent(stockHoldings.map((r) => r.code).join(","))) : Promise.resolve(null),
              fundHoldings.length ? fetch("/api/fund/nav?codes=" + encodeURIComponent(fundHoldings.map((r) => r.code).join(","))) : Promise.resolve(null),
            ]);
            const qmap = {};
            if (stockRes && stockRes.ok) (await stockRes.json()).forEach((q) => { qmap[q.code] = q; });
            if (fundRes && fundRes.ok) (await fundRes.json()).forEach((q) => { qmap[q.code] = { price: q.isMoney ? 1 : q.nav, change: q.isMoney ? q.nav / 10000 : q.nav - q.prevNav }; });
            // await 期间可能已切走或重渲染，元素不在了就放弃
            const stockEl = el.querySelector("#nwStock");
            if (currentRoute() !== "dashboard" || !stockEl) return;
            let mv = 0, day = 0, quoted = false;
            holdings.forEach((r) => {
              const q = qmap[r.code];
              if (q) { quoted = true; mv += q.price * r.holding; day += q.change * r.holding; }
              else mv += r.avgCost * r.holding;
            });
            if (!quoted) return;
            const sgn = (n) => (n > 0.005 ? "+" : n < -0.005 ? "-" : "") + fmtMoney(Math.abs(n));
            // A 股惯例：涨红跌绿
            const col = day > 0.005 ? "var(--danger)" : day < -0.005 ? "var(--ok)" : "var(--muted)";
            stockEl.textContent = fmtMoney(mv);
            const subEl = el.querySelector("#nwStockSub");
            if (subEl) subEl.textContent = `共 ${holdings.length} 个标的 · ${fundHoldings.length ? "股票 + 理财" : "实时行情"}`;
            const dayEl = el.querySelector("#nwDay");
            if (dayEl) { dayEl.textContent = sgn(day); dayEl.style.color = col; }
            const totalEl = el.querySelector("#nwTotal");
            if (totalEl) totalEl.textContent = fmtMoney(saved + mv);
          } catch (e) { /* 行情拉取失败保持成本价兜底 */ }
        })();
      }

      // 到期任务浏览器通知：每天首次打开仪表盘时提醒一次（频控用 localStorage，按设备而非账号）
      const NOTIFY_KEY = "wb2_notify_day";
      function sendDueNotice() {
        const title = "个人工作台 · 任务提醒";
        const body = `今天到期 ${dueToday.length} 项、已逾期 ${overdue.length} 项，点开处理一下吧`;
        try {
          const n = new Notification(title, { body, tag: "wb-due" });
          n.onclick = () => { window.focus(); location.hash = "#/tasks"; n.close(); };
        } catch (e) {
          // 移动端 Chrome 禁止页面直接 new Notification，需经 Service Worker 发
          if (navigator.serviceWorker) {
            navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, tag: "wb-due" })).catch(() => {});
          }
        }
      }
      if (canNotify && focus.length && Notification.permission === "granted") {
        let last = "";
        try { last = localStorage.getItem(NOTIFY_KEY) || ""; } catch (e) { /* 隐私模式忽略 */ }
        if (last !== today) {
          try { localStorage.setItem(NOTIFY_KEY, today); } catch (e) { /* ignore */ }
          sendDueNotice();
        }
      }
      const notifyBtn = el.querySelector("#notifyBtn");
      if (notifyBtn) notifyBtn.addEventListener("click", async () => {
        const perm = await Notification.requestPermission();
        notifyBtn.remove();
        if (perm === "granted") {
          try { localStorage.setItem(NOTIFY_KEY, today); } catch (e) { /* ignore */ }
          sendDueNotice();
        } else if (perm === "denied") {
          showToast("已拒绝通知权限，如需开启请到浏览器的网站设置里允许通知", "error");
        }
      });

      // 每周回顾：AI 点评按周缓存（settings.weeklyReview），重新生成会覆盖
      el.querySelector("#wrGen").addEventListener("click", async () => {
        if (!window.WB.USE_API) return showToast("离线中，AI 点评不可用", "error");
        const st = await WB.ai.status();
        if (!st.configured) return showToast("未配置智谱 API Key：设环境变量 ZHIPU_API_KEY 或在项目根创建 zhipu.key 文件后重启服务", "error");
        const btn = el.querySelector("#wrGen");
        const box = el.querySelector("#wrAi");
        btn.disabled = true;
        btn.textContent = "生成中…";
        box.innerHTML = '<div class="ai-panel">正在请智谱回顾这一周…</div>';
        try {
          const text = await WB.ai.chat(
            "你是个人成长教练，语气真诚不客套。输出不超过 150 字的中文点评，先肯定亮点再指出不足，最后给出下周最重要的 1 条建议。不要标题不要列表。",
            `这是我本周（${monStr} 至 ${today}）的数据：\n` + wrStats.join("\n"),
            0.7
          );
          const p = (x) => String(x).padStart(2, "0");
          const at = `${today} ${p(new Date().getHours())}:${p(new Date().getMinutes())}`;
          await setSetting("weeklyReview", { week: monStr, text, at });
          if (currentRoute() === "dashboard") navigate();
        } catch (err) {
          box.innerHTML = `<div class="ai-panel c-danger">生成失败：${esc((err && err.message) || "网络异常")}</div>`;
          btn.disabled = false;
          btn.textContent = "✨ 生成 AI 点评";
        }
      });

      // 定期账单到期检查：auto 自动记入 / remind 弹框提醒（记账页已处理过则同月不重复）。
      // 防双入口重复触发：finance.js 内部已有 finSchedDone / 按 note 查重双保险，
      // 这里再加「按账号隔离」的同月节流标记兜底（仪表盘每次渲染都会走到这里）。
      const schedKey = "wb2_schedCheckMonth_" + ((window.WB.auth && window.WB.auth.user) || "local");
      let lastSchedMonth = "";
      try { lastSchedMonth = localStorage.getItem(schedKey) || ""; } catch (e) { /* 隐私模式忽略 */ }
      const curMonth = today.slice(0, 7);
      if (window.WB.financeSchedCheck && lastSchedMonth !== curMonth) {
        window.WB.financeSchedCheck(finance).catch(() => {}).finally(() => {
          try { localStorage.setItem(schedKey, curMonth); } catch (e) { /* 隐私模式忽略 */ }
        });
      }
    },
  };

  // ================= 设置 =================
  routes.settings = {
    title: "设置",
    async render(el) {
      const nickname = await getSetting("nickname", "朋友");
      const authUser = (window.WB.auth && window.WB.auth.user) || "";
      const isAdmin = !!(window.WB.auth && window.WB.auth.isAdmin);
      el.innerHTML = `
        <div class="card">
          <h2>账号</h2>
          ${window.WB.USE_API ? `
          <div class="set-row">
            <span class="s-name">当前用户</span>
            <span class="s-desc"><b>${esc(authUser)}</b>${isAdmin ? "（管理员）" : ""} · 数据存于独立数据库，与其他账号完全隔离</span>
          </div>
          <div class="set-row">
            <span class="s-name">修改密码</span>
            <input id="pwdOld" type="password" placeholder="原密码" autocomplete="current-password" class="w-120" />
            <input id="pwdNew" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" class="w-150" />
            <button class="btn sm" id="pwdSaveBtn">修改</button>
          </div>
          <div class="set-row">
            <span class="s-name">退出登录</span>
            <button class="btn ghost sm" id="logoutBtn">退出登录</button>
            <span class="s-desc">退出后需重新输入账号密码才能使用。</span>
          </div>` : `
          <div class="set-row">
            <span class="s-desc">本地离线模式无账号体系，数据存在本机浏览器；连上服务器后需登录使用。</span>
          </div>`}
        </div>
        ${window.WB.USE_API && isAdmin ? `
        <div class="card">
          <h2>用户管理<span class="count">仅管理员</span></h2>
          <div class="set-row">
            <span class="s-name">新建用户</span>
            <input id="nuName" placeholder="用户名（2-20 位字母/数字）" maxlength="20" class="w-170" />
            <input id="nuPwd" type="password" placeholder="初始密码（至少 6 位）" class="w-150" />
            <button class="btn sm" id="nuAddBtn">创建</button>
          </div>
          <div class="set-row">
            <span class="s-desc">每个用户一个独立数据库文件（workbench_用户名.db），首次登录自动创建；不开放自行注册。</span>
          </div>
          <div id="userList"><div class="empty">加载中…</div></div>
        </div>` : ""}
        <div class="card">
          <h2>个人资料</h2>
          <div class="set-row">
            <span class="s-name">昵称</span>
            <input id="nickInput" maxlength="12" value="${esc(nickname)}" class="w-180" />
            <button class="btn sm" id="nickSave">保存</button>
          </div>
        </div>
        <div class="card">
          <h2>运行模式</h2>
          <div class="set-row">
            <span class="s-name">当前</span>
            <span class="s-desc" id="modeDesc">${window.WB.USE_API
              ? '<b style="color:var(--ok)">在线</b> · 数据存服务器 SQLite（workbench.db）；资讯抓取、AI 精选可用。'
              : '<b style="color:var(--warn)">本地</b> · 数据存浏览器 IndexedDB；资讯抓取和 AI 精选不可用（离线中）。'}</span>
          </div>
          <div class="set-row">
            <span class="s-name">切换模式</span>
            <span class="s-desc">在 URL 末尾加 <code>?mode=local</code> 强制本地、<code>?mode=api</code> 强制在线；默认启动时自动探测。手机端 PWA 装到桌面后建议锁本地：<a href="?mode=local" class="c-accent">用本地模式打开一次</a>（浏览器会记住该 URL）。</span>
          </div>
        </div>
        <div class="card">
          <h2>数据同步<span class="count">本地 ⇄ 服务器</span></h2>
          <div class="set-row">
            <span class="s-name">拉取服务器</span>
            <button class="btn ghost sm" id="pullBtn" ${window.WB.USE_API ? "" : "disabled"}>服务器 → 本地</button>
            <span class="s-desc">把服务器最新数据全量下载覆盖到本机浏览器 IndexedDB。手机端出门前一键更新到最新。</span>
          </div>
          <div class="set-row">
            <span class="s-name">推送到服务器</span>
            <button class="btn ghost sm" id="pushBtn" ${window.WB.USE_API ? "" : "disabled"}>本地 → 服务器</button>
            <span class="s-desc">把本机浏览器 IndexedDB 全量推送覆盖服务器数据。手机端离线记录了新内容，回家后一键回传。</span>
          </div>
          <div class="set-row">
            <span class="s-name">迁移旧数据</span>
            <button class="btn ghost sm" id="migrateBtn" ${window.WB.USE_API ? "" : "disabled"}>上传本机浏览器数据到服务器</button>
            <span class="s-desc">与「推送到服务器」等价，保留作旧入口。</span>
          </div>
        </div>
        <div class="card">
          <h2>数据备份</h2>
          <div class="set-row">
            <span class="s-name">导出备份</span>
            <button class="btn ghost sm" id="exportBtn">导出 JSON 文件</button>
            <span class="s-desc">全量导出当前模式（在线=服务器 / 本地=浏览器）的所有数据。</span>
          </div>
          <div class="set-row">
            <span class="s-name">导入恢复</span>
            <input type="file" id="importFile" accept=".json,application/json" style="max-width:230px" />
            <button class="btn danger sm" id="importBtn">导入并覆盖</button>
            <span class="s-desc">⚠️ 导入会清空当前所有数据并以备份文件为准，操作前建议先导出一份。</span>
          </div>
          <div class="set-row">
            <span class="s-name">自动备份</span>
            <span class="s-desc" id="backupStatus">查询中…</span>
          </div>
          <div class="set-row">
            <span class="s-name">AI 助手</span>
            <span class="s-desc" id="aiStatus">查询中…</span>
          </div>
        </div>
        <div class="card">
          <h2>网盘配置</h2>
          <div id="driveSettingsArea"></div>
        </div>
        <div class="card">
          <h2>危险操作</h2>
          <div class="set-row">
            <span class="s-name">清除所有数据</span>
            <button class="btn danger sm" id="clearAllBtn">清空全部数据</button>
            <span class="s-desc">⚠️ 不可恢复！将删除任务、笔记、收藏、习惯、财务等全部数据，操作前务必先导出备份。</span>
          </div>
        </div>
        <div class="card">
          <h2>关于</h2>
          <div style="font-size:13px;color:var(--muted);line-height:1.9">
            不会用？看 <a href="#/help">使用帮助</a>（小白向操作手册，也可直接打开项目根目录的 HELP.md）<br />
            个人工作台 v2 · 原生前端 + Python(FastAPI) + SQLite · 多账号登录，数据按账号隔离<br />
            每个账号一个独立库文件（管理员 workbench.db，其他 workbench_用户名.db），备份 = 复制该文件；启动命令 python server.py。<br />
            存储层已做 Repository 抽象，db.js 中 USE_API=false 可整体回退纯浏览器模式。<br />
            调试：<a href="/api/docs" target="_blank" rel="noopener">API 文档（Swagger）</a>
          </div>
        </div>`;

      // 自动备份状态：服务端每次启动时备份 workbench.db 到 backups/，保留最近 7 份
      const bkEl = el.querySelector("#backupStatus");
      if (window.WB.USE_API) {
        fetch("/api/backup/status")
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((s) => {
            bkEl.textContent = s.latest
              ? `上次备份：${s.latest} · ${s.at} · 共 ${s.count} 份（服务启动时自动备份，保留最近 7 份）`
              : "还没有自动备份，重启服务后会自动生成";
          })
          .catch(() => { bkEl.textContent = "备份状态查询失败（服务端可能是旧版本，重启后生效）"; });
      } else {
        bkEl.textContent = "纯浏览器模式无服务端自动备份，请用上方导出 JSON";
      }

      // AI 助手状态：key 只存服务端，前端仅展示是否已配置
      const aiEl = el.querySelector("#aiStatus");
      if (!window.WB.USE_API) {
        aiEl.textContent = "离线中，无法查询 AI 状态（需连服务端）";
      } else {
        window.WB.ai.status().then((s) => {
          aiEl.textContent = s.configured
            ? `已配置 · 模型 ${s.model}（入口：笔记「✨ AI 摘要」/ 任务「✨ AI 拆解」/ 资讯「✨ 今日精选」）`
            : "未配置：设置环境变量 ZHIPU_API_KEY 或在项目根创建 zhipu.key 文件写入智谱 API Key，然后重启服务";
        });
      }

      // 网盘配置表单
      const driveSettingsArea = el.querySelector("#driveSettingsArea");
      if (window.WB.USE_API && window.WB.drive) {
        driveSettingsArea.innerHTML = window.WB.drive.renderSettingsForm();
        setTimeout(() => window.WB.drive.bindSettingsEvents(), 0);
      } else {
        driveSettingsArea.innerHTML = '<div class="empty">仅在线模式支持网盘功能</div>';
      }

      // 账号：修改密码 / 退出登录（仅在线模式渲染了这些控件）
      const pwdSaveBtn = el.querySelector("#pwdSaveBtn");
      if (pwdSaveBtn) pwdSaveBtn.addEventListener("click", async () => {
        const oldPwd = el.querySelector("#pwdOld").value;
        const newPwd = el.querySelector("#pwdNew").value;
        if (!oldPwd || newPwd.length < 6) return showToast("请填写原密码，新密码至少 6 位", "error");
        try {
          const res = await fetch("/api/auth/password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || "HTTP " + res.status);
          el.querySelector("#pwdOld").value = "";
          el.querySelector("#pwdNew").value = "";
          showToast("密码已修改，下次登录请用新密码", "success");
        } catch (err) {
          showToast("修改失败：" + (err && err.message), "error");
        }
      });

      const logoutBtn = el.querySelector("#logoutBtn");
      if (logoutBtn) logoutBtn.addEventListener("click", () => {
        if (confirm("确定退出登录？")) window.WB.auth.logout();
      });

      // 用户管理（仅管理员）：列表 + 新建 + 重置密码 + 删除
      async function loadUsers() {
        const box = el.querySelector("#userList");
        if (!box) return;
        try {
          const res = await fetch("/api/auth/users");
          if (!res.ok) throw new Error("HTTP " + res.status);
          const users = await res.json();
          box.innerHTML = users
            .map(
              (u) => `<div class="set-row">
                <span class="s-name">${esc(u.username)}${u.isAdmin ? "（管理员）" : ""}</span>
                <span class="s-desc">创建于 ${esc(u.createdAt || "—")}</span>
                ${u.isAdmin ? "" : `<button class="btn ghost sm" data-reset="${esc(u.username)}">重置密码</button>
                <button class="btn danger sm" data-del="${esc(u.username)}">删除</button>`}
              </div>`
            )
            .join("");
          box.querySelectorAll("[data-reset]").forEach((b) =>
            b.addEventListener("click", async () => {
              const name = b.getAttribute("data-reset");
              const pwd = prompt(`为用户 ${name} 设置新密码（至少 6 位，重置后其已登录设备会被踢下线）：`);
              if (pwd === null) return;
              try {
                const r = await fetch(`/api/auth/users/${encodeURIComponent(name)}/password`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: pwd }),
                });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
                showToast("已重置", "success");
              } catch (err) {
                showToast("重置失败：" + (err && err.message), "error");
              }
            })
          );
          box.querySelectorAll("[data-del]").forEach((b) =>
            b.addEventListener("click", async () => {
              const name = b.getAttribute("data-del");
              if (!confirm(`删除用户 ${name}？\n其数据库文件 workbench_${name}.db 会保留在服务器上，如需彻底清除请手动删除该文件。`)) return;
              try {
                const r = await fetch(`/api/auth/users/${encodeURIComponent(name)}`, { method: "DELETE" });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
                loadUsers();
              } catch (err) {
                showToast("删除失败：" + (err && err.message), "error");
              }
            })
          );
        } catch (err) {
          box.innerHTML = `<div class="empty">用户列表加载失败：${esc((err && err.message) || "")}</div>`;
        }
      }
      const nuAddBtn = el.querySelector("#nuAddBtn");
      if (nuAddBtn) {
        loadUsers();
        nuAddBtn.addEventListener("click", async () => {
          const name = el.querySelector("#nuName").value.trim();
          const pwd = el.querySelector("#nuPwd").value;
          if (!name || pwd.length < 6) return showToast("请填写用户名，密码至少 6 位", "error");
          try {
            const res = await fetch("/api/auth/users", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username: name, password: pwd }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || "HTTP " + res.status);
            el.querySelector("#nuName").value = "";
            el.querySelector("#nuPwd").value = "";
            loadUsers();
          } catch (err) {
            showToast("创建失败：" + (err && err.message), "error");
          }
        });
      }

      el.querySelector("#nickSave").addEventListener("click", async () => {
        const v = el.querySelector("#nickInput").value.trim();
        if (!v) return showToast("昵称不能为空", "error");
        await setSetting("nickname", v);
        showToast("已保存", "success");
      });

      el.querySelector("#exportBtn").addEventListener("click", async () => {
        const payload = await exportAll();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "workbench-backup-" + todayStr() + ".json";
        a.click();
        URL.revokeObjectURL(a.href);
      });

      el.querySelector("#migrateBtn").addEventListener("click", async () => {
        if (!window.WB.USE_API) return showToast("当前为本地模式，服务器不在线，无法迁移", "error");
        if (!confirm("将用本机浏览器数据覆盖服务器现有数据，确定继续？")) return;
        try {
          await window.WB.pushLocalToServer();
          showToast("迁移成功，即将刷新页面", "success");
          location.reload();
        } catch (err) {
          showToast("迁移失败：" + (err && err.message), "error");
        }
      });

      // 同步：服务器 → 本地（把服务器最新数据拉进浏览器 IndexedDB，离线时可用）
      const pullBtn = el.querySelector("#pullBtn");
      if (pullBtn) pullBtn.addEventListener("click", async () => {
        if (!window.WB.USE_API) return showToast("服务器不在线，无法拉取", "error");
        if (!confirm("将用服务器最新数据覆盖本机浏览器缓存，本机未同步的改动会丢失，继续？")) return;
        pullBtn.disabled = true;
        pullBtn.textContent = "同步中…";
        try {
          await window.WB.pullServerToLocal();
          showToast("已拉取到本地。手机端下次离线打开工作台时数据即为此刻的服务器版本。", "success");
        } catch (err) {
          showToast("拉取失败：" + (err && err.message), "error");
        } finally {
          pullBtn.disabled = false;
          pullBtn.textContent = "服务器 → 本地";
        }
      });

      // 同步：本地 → 服务器（把手机上离线记的内容推回服务器）
      const pushBtn = el.querySelector("#pushBtn");
      if (pushBtn) pushBtn.addEventListener("click", async () => {
        if (!window.WB.USE_API) return showToast("服务器不在线，无法推送", "error");
        if (!confirm("将用本机浏览器数据覆盖服务器现有数据，服务器上未拉到本机的改动会丢失，继续？")) return;
        pushBtn.disabled = true;
        pushBtn.textContent = "同步中…";
        try {
          await window.WB.pushLocalToServer();
          showToast("已推送到服务器。", "success");
        } catch (err) {
          showToast("推送失败：" + (err && err.message), "error");
        } finally {
          pushBtn.disabled = false;
          pushBtn.textContent = "本地 → 服务器";
        }
      });

      el.querySelector("#clearAllBtn").addEventListener("click", async () => {
        if (!confirm("将清空全部业务数据且不可恢复，确定继续？")) return;
        if (!confirm("再次确认：真的要删除所有任务、笔记、习惯、财务等数据吗？建议先导出备份！")) return;
        try {
          await clearAllData();
          showToast("已清空全部数据，即将刷新页面", "success");
          location.reload();
        } catch (err) {
          showToast("清除失败：" + (err && err.message), "error");
        }
      });

      el.querySelector("#importBtn").addEventListener("click", () => {
        const file = el.querySelector("#importFile").files[0];
        if (!file) return showToast("请先选择备份文件", "error");
        if (!confirm("导入将清空当前全部数据并用备份覆盖，确定继续？")) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            await importAll(JSON.parse(reader.result));
            showToast("导入成功，即将刷新页面", "success");
            location.reload();
          } catch (err) {
            showToast("导入失败：" + (err && err.message), "error");
          }
        };
        reader.readAsText(file);
      });
    },
  };

  // ================= 帮助（使用手册） =================
  // 手册正文单独放在项目根 HELP.md，方便离开页面单独阅读/维护；这里只负责拉取并用 MD 渲染
  routes.help = {
    title: "使用帮助",
    async render(el) {
      const res = await fetch("/HELP.md");
      if (!res.ok) {
        el.innerHTML = '<div class="card"><div class="empty">手册加载失败：未找到 HELP.md（请确认服务端已重启为最新版本）</div></div>';
        return;
      }
      const md = await res.text();
      el.innerHTML = '<div class="card"><div class="md-preview">' + MD.render(md) + "</div></div>";
    },
  };

  // ================= 启动 =================
  document.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    initGlobalSearch();
    initNavGroups();
    initMoreSheet();
    // 先探测后端，确定 USE_API 后再渲染业务模块，避免 settings/repo 抓错源
    await window.WB.ready;
    renderModeBadge();
    // 与 settings 中的主题对齐（首次无 localStorage 缓存时）
    getSetting("theme", null).then((t) => {
      if (t && t !== document.documentElement.getAttribute("data-theme")) applyTheme(t);
    });
    window.addEventListener("hashchange", navigate);
    if (!location.hash) location.hash = "#/dashboard";
    navigate();

    // 网络状态变化时刷新徽标（离线后再回来时提示用户可重连）
    window.addEventListener("online", renderModeBadge);
    window.addEventListener("offline", renderModeBadge);
  });

  /** 定义侧边栏分组的展开/收起：点击父级标题切换 open 状态 */
  function initNavGroups() {
    document.querySelectorAll(".nav-parent").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = btn.closest(".nav-group");
        if (!g) return;
        const open = g.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });
  }

  // 移动端底栏「更多」面板容纳的低频路由（与 index.html 中 .more-grid 保持一致）
  const MORE_ROUTES = ["life", "calendar", "reports", "stocks", "gongkao", "drive", "links", "settings", "help"];

  /** 关闭「更多」上滑面板 */
  function closeMoreSheet() {
    const mask = document.getElementById("moreMask");
    const sheet = document.getElementById("moreSheet");
    if (mask) mask.classList.remove("show");
    if (sheet) sheet.classList.remove("show");
  }

  /** 初始化「更多」面板：点击开关、遮罩/选项关闭 */
  function initMoreSheet() {
    const btn = document.getElementById("tabMoreBtn");
    const mask = document.getElementById("moreMask");
    const sheet = document.getElementById("moreSheet");
    if (!btn || !mask || !sheet) return;
    btn.addEventListener("click", () => {
      const open = !sheet.classList.contains("show");
      mask.classList.toggle("show", open);
      sheet.classList.toggle("show", open);
    });
    mask.addEventListener("click", closeMoreSheet);
    // 选中任一入口后关闭（路由切换 navigate 也会兼底关闭）
    sheet.querySelectorAll("a[data-route]").forEach((a) => {
      a.addEventListener("click", closeMoreSheet);
    });
  }

  /** 在顶栏右侧渲染"在线/本地"徽标，点击可跳设置查看/切换 */
  function renderModeBadge() {
    const bar = document.querySelector(".topbar");
    if (!bar) return;
    let el = document.getElementById("modeBadge");
    if (!el) {
      el = document.createElement("a");
      el.id = "modeBadge";
      el.href = "#/settings";
      el.className = "mode-badge";
      const themeTop = document.getElementById("themeBtnTop");
      bar.insertBefore(el, themeTop);
    }
    const online = window.WB.USE_API;
    el.classList.toggle("online", !!online);
    el.classList.toggle("offline", !online);
    el.title = online
      ? "在线模式：数据存服务器 SQLite（workbench.db）"
      : "本地模式：数据存浏览器 IndexedDB，资讯/AI 不可用";
    el.innerHTML = online
      ? '<span class="dot"></span><span>在线</span>'
      : '<span class="dot"></span><span>本地</span>';
  }
})();
