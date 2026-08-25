/**
 * app.js — 路由（hash）、明暗主题、全局搜索、仪表盘、设置页
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, todayStr, fmtMoney, safeUrl, getSetting, getSettings, setSetting, exportAll, importAll, debounce, flashInvalid, clearAllData, cssVar, showToast } = window.WB;

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

  // 导出到全局（showToast 已上移 db.js——它是最先加载的模块，业务模块加载期解构才拿得到）
  window.WB.showLoading = showLoading;

  // ================= 主题 =================
  const THEME_KEY = "wb2_theme"; // localStorage 仅作即时缓存防闪烁，正式值在 settings
  const AUTO_THEME = "auto";
  const THEME_MQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  // 主题按钮循环：只保留 亮/暗 两档（日常快切）
  const THEMES = [
    { key: "light", icon: "☀️", text: "亮色模式" },
    { key: "dark", icon: "🌙", text: "暗色模式" },
  ];
  // 全部可选主题（设置页选择器用）：循环外的高级主题 + 老主题 fallback
  const ALL_THEMES = [
    { key: "light", icon: "☀️", text: "亮色模式", desc: "莫兰迪治愈 · 明亮" },
    { key: "dark", icon: "🌙", text: "暗色模式", desc: "莫兰迪治愈 · 暗色" },
    { key: "auto", icon: "🌗", text: "自动", desc: "跟随系统明暗自动切换" },
    { key: "mint", icon: "🌿", text: "打工小账本", desc: "米黄纸 + 薄荷绿记账风" },
    { key: "daily", icon: "📖", text: "日常集", desc: "衬线报刊排版" },
    { key: "glass", icon: "🫧", text: "玻璃拟态", desc: "深蓝玻璃模糊" },
    { key: "forest", icon: "🌲", text: "森林模式", desc: "（旧主题）" },
    { key: "midnight", icon: "🌌", text: "深夜模式", desc: "（旧主题）" },
    { key: "terminal", icon: "🖥️", text: "终端模式", desc: "（旧主题）" },
    { key: "newsprint", icon: "📰", text: "报纸模式", desc: "（旧主题）" },
    { key: "mint-dark", icon: "🌳", text: "奶系绿暗", desc: "（旧主题）" },
  ];
  // 浏览器状态栏配色：每个主题独立
  const THEME_BAR = {
    light: "#e8ecef", dark: "#1c2025",
    mint: "#EDF1E8", daily: "#F5EFE1", glass: "#0E1626",
    forest: "#f3eee2", midnight: "#0b1116",
    terminal: "#050505", newsprint: "#f3eee2", "mint-dark": "#1B2A24",
  };
  function applyTheme(theme) {
    const resolved = theme === AUTO_THEME
      ? (THEME_MQ && THEME_MQ.matches ? "dark" : "light")
      : theme;
    document.documentElement.setAttribute("data-theme", resolved);
    const m = ALL_THEMES.find((x) => x.key === theme);
    const label = (m && m.icon) || "🎨", text = (m && m.text) || "主题";
    const btn = document.getElementById("themeBtn");
    const btnTop = document.getElementById("themeBtnTop");
    if (btn) btn.innerHTML = label + " <span>" + text + "</span>";
    if (btnTop) btnTop.textContent = label;
    // 同步 meta theme-color，让移动端状态栏/地址栏跟随主题
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute("content", THEME_BAR[resolved] || "#e8ecef");
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    // 当前不在循环里（选了高级主题）→ 下一次落到 亮色，避免跳变
    const idx = THEMES.findIndex((x) => x.key === cur);
    const next = idx >= 0 ? THEMES[(idx + 1) % THEMES.length].key : "light";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
    setSetting("theme", next);
  }
  // 设置页主题选择器用：直接应用某个主题
  function setThemeDirect(theme) {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
    setSetting("theme", theme);
  }
  function initTheme() {
    let t = "light";
    try { t = localStorage.getItem(THEME_KEY) || "light"; } catch (e) { /* ignore */ }
    applyTheme(t);
    document.getElementById("themeBtn").addEventListener("click", toggleTheme);
    document.getElementById("themeBtnTop").addEventListener("click", toggleTheme);
    if (THEME_MQ) {
      THEME_MQ.addEventListener("change", () => {
        let cur = "light";
        try { cur = localStorage.getItem(THEME_KEY) || "light"; } catch (e) { /* ignore */ }
        if (cur === AUTO_THEME) applyTheme(cur);
      });
    }
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
    document.title = route.title + " · 我的仪表盘";
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
        saveNavOpen();
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
      let tasks, notes, marks, links, finances, habits, trackers;
      if (window.WB.USE_API) {
        // 在线模式走服务端检索：只传命中行，不再每次键入全量拉 7 个 store
        try {
          const res = await WB.rawApi("/api/search?q=" + encodeURIComponent(input.value.trim()));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const s = await res.json();
          tasks = s.tasks || []; notes = s.notes || []; marks = s.bookmarks || []; links = s.quicklinks || [];
          finances = s.finance || []; habits = s.habits || []; trackers = s.trackers || [];
        } catch (e) { /* 服务端检索失败（含旧版后端 404）→ 回退本地全量过滤 */ }
      }
      if (!tasks) {
        [tasks, notes, marks, links, finances, habits, trackers] = await Promise.all([
          repo("tasks").list(), repo("notes").list(), repo("bookmarks").list(), repo("quicklinks").list(),
          repo("finance").list(), repo("habits").list(), repo("trackers").list().catch(() => []),
        ]).catch(() => [[], [], [], [], [], [], []]);
      }
      // 服务端结果已按 JSON 值匹配过，不再二次过滤（否则 id/日期等服务端命中字段会被误删）
      const serverSide = !!tasks;
      const hit = serverSide ? () => true : (s) => String(s || "").toLowerCase().includes(q);
      const groups = [
        { name: "✅ 任务", type: "task", rows: tasks.filter((t) => hit(t.title) || hit(t.note) || (t.tags || []).some(hit)) },
        { name: "📚 笔记", type: "note", rows: notes.filter((n) => hit(n.title) || hit(n.content) || hit(n.folder)) },
        { name: "💰 记账", type: "fin", rows: finances.filter((f) => hit(f.note) || hit(f.category)) },
        { name: "🌱 习惯", type: "habit", rows: habits.filter((h) => hit(h.name)) },
        { name: "📊 追踪器", type: "tracker", rows: trackers.filter((t) => hit(t.name)) },
        { name: "🔖 收藏", type: "url", rows: marks.filter((m) => hit(m.title) || hit(m.url) || (m.tags || []).some(hit)) },
        { name: "🚀 快捷入口", type: "url", rows: links.filter((l) => hit(l.name) || hit(l.url)) },
      ].filter((g) => g.rows.length);

      // 快速录入：查询里带数字且命中追踪器名 → 顶部出现「记录」动作（如「跑步5.2」→ 记 5.2）
      let quickRec = "";
      const numMatch = input.value.trim().match(/^(.{1,20}?)[\s:]*(-?\d+(?:\.\d+)?)\s*(.*)$/);
      if (numMatch && window.WB.tracker && trackers.length) {
        const namePart = numMatch[1].replace(/^记录\s*/, "").trim().toLowerCase();
        const tk = trackers.find((t) => namePart && (String(t.name).toLowerCase().includes(namePart) || namePart.includes(String(t.name).toLowerCase())));
        if (tk && Number(numMatch[2]) > 0) {
          quickRec = `<div class="gs-item" data-qrec="${tk.id}" data-qrec-v="${numMatch[2]}" data-t="qrec">
            <span class="gs-ic">⚡</span>
            <div class="gs-main"><b>记录 ${esc(tk.icon || "")}${esc(tk.name)}：${esc(numMatch[2])}${esc(tk.unit || "")}</b><span class="gs-sub">回车或点击直接录入今天</span></div>
          </div>`;
        }
      }

      if (!groups.length) {
        // 无分组命中也要展示「⚡ 记录」快捷项（如「咖啡2」只有数字部分不同）
        panel.innerHTML = quickRec + '<div class="gs-empty">没有找到匹配内容</div>';
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
            if (g.type === "tracker")
              return `<div class="gs-item" data-t="tracker" data-id="${r.id}"><span class="gs-txt">${esc(r.icon || "📊")} ${title}</span><span class="gs-sub">追踪器 →</span></div>`;
            return `<div class="gs-item" data-t="url" data-url="${esc(r.url)}"><span class="gs-txt">${title}</span><span class="gs-sub">打开 ↗</span></div>`;
          }).join("");
          return `<div class="gs-group">${g.name}</div>${body}${moreHtml}`;
        })
        .join("");
      panel.innerHTML = quickRec + panel.innerHTML;
      panel.hidden = false;
    }

    input.addEventListener("input", debounce(doSearch, 250));
    input.addEventListener("focus", () => { if (input.value.trim()) doSearch(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); input.blur(); }
      // 回车：若有「⚡ 记录」快捷项则直接录入
      if (e.key === "Enter" && !panel.hidden) {
        const qrec = panel.querySelector('.gs-item[data-t="qrec"]');
        if (qrec) qrec.click();
      }
    });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });

    panel.addEventListener("click", async (e) => {
      const item = e.target.closest(".gs-item");
      if (item) {
        if (item.dataset.t === "qrec") {
          try {
            await window.WB.tracker.quickLog(item.dataset.qrec, item.dataset.qrecV);
            showToast("已记录", "ok");
          } catch (err) { showToast("记录失败：" + err.message, "error"); }
          close();
          return;
        }
        if (item.dataset.t === "task") { WB.jump.taskId = item.dataset.id; go("#/tasks"); }
        else if (item.dataset.t === "note") { WB.jump.noteId = item.dataset.id; go("#/notes"); }
        else if (item.dataset.t === "fin") { go("#/finance"); }
        else if (item.dataset.t === "habit") { go("#/life"); }
        else if (item.dataset.t === "tracker") { go("#/tracker"); }
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
  let assetPieChart = null; // 资产配置饼图（独立管理：行情回来后原地 update，不随 dashCharts 销毁）
  let lastPieData = null;   // 行情回来后的最新饼图数据：归档区未展开时 canvas 不在，先存后用
  let dashArchiveOpen = false; // 归档区（数据概览）展开状态：重渲染后保留用户选择
  let dashCfgOpen = false; // 首页自定义面板展开状态（Workspace 轻量版）
  // 首页可开关的区块（key 对应 settings.dashLayout 的字段）
  const DASH_SECTIONS = [
    { k: "banners", name: "横幅提醒（考公 / 倒数日 / 储蓄 / 预算 / 订阅 / 新成就）" },
    { k: "otd", name: "往年今日" },
    { k: "focus", name: "今日焦点" },
    { k: "reminders", name: "今日提醒" },
    { k: "trackers", name: "追踪器速记" },
    { k: "actions", name: "打卡 / 快速记支出 / 最近沉淀" },
    { k: "archive", name: "数据概览与每周回顾（归档区）" },
  ];

  /** 资产配置饼图（现金储蓄 / 股票 / 基金理财）：首次创建、再次原地 update；
   *  行情回来后用实时市值刷新（未报价标的按成本兜底），canvas 不在（归档区未展开）时静默跳过 */
  function renderAssetPie(el, d) {
    const cv = el.querySelector("#assetPie");
    if (!cv) return;
    const legend = el.querySelector("#assetPieLegend");
    const items = [
      ["现金储蓄", d.saved, cssVar("--ok")],
      ["股票市值", d.stock, cssVar("--accent")],
      ["基金理财", d.fund, cssVar("--purple")],
    ];
    const total = d.saved + d.stock + d.fund;
    if (legend) {
      legend.innerHTML = total > 0
        ? items.map(([n, v, c]) => `<div class="ap-item"><i style="background:${c}"></i><span>${n}</span><b>${fmtMoney(v)}</b><em>${Math.round((v / total) * 100)}%</em></div>`).join("")
        : "";
    }
    if (total <= 0) return;
    if (typeof Chart === "undefined") {
      // chart 大库启动时异步预取中：加载完成再补画（loadScript 带缓存，失败静默降级）
      window.WB.loadScript("/lib/chart.umd.min.js").then(() => renderAssetPie(el, d)).catch(() => {});
      return;
    }
    if (assetPieChart) {
      assetPieChart.data.datasets[0].data = [d.saved, d.stock, d.fund];
      assetPieChart.update();
      return;
    }
    assetPieChart = new Chart(cv, {
      type: "doughnut",
      data: {
        labels: items.map((i) => i[0]),
        datasets: [{ data: [d.saved, d.stock, d.fund], backgroundColor: items.map((i) => i[2]), borderWidth: 2, borderColor: cssVar("--bg") || "#fff" }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: "64%", plugins: { legend: { display: false } } },
    });
  }

  function renderCharts(el, tasks, habits, finance, stockCostVal, pieSplit) {
    if (typeof Chart === "undefined") {
      // chart 大库异步预取竞态：加载完成后重试本函数（dashCharts 销毁逻辑保证幂等）
      window.WB.loadScript("/lib/chart.umd.min.js").then(() => renderCharts(el, tasks, habits, finance, stockCostVal, pieSplit)).catch(() => {});
      return;
    }
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
      finance.filter((r) => window.WB.isSaving(r) && (r.date || "").slice(0, 7) <= m).reduce((s, r) => s + Number(r.amount || 0), 0)
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
        plugins: { legend: { display: false }, tooltip: {
            backgroundColor: (document.documentElement.getAttribute("data-theme") === "dark" || document.documentElement.getAttribute("data-theme") === "midnight") ? "rgba(28, 33, 40, 0.92)" : "rgba(255, 255, 255, 0.92)",
      titleColor: (document.documentElement.getAttribute("data-theme") === "dark") ? "#eef1f5" : "#2b2f36",
      bodyColor: (document.documentElement.getAttribute("data-theme") === "dark") ? "#c3cbd4" : "#4a5058",
      borderColor: "rgba(214, 155, 114, 0.35)",
      borderWidth: 1,
      cornerRadius: 10,
      padding: 10,
      callbacks: { label: (c) => "净资产 " + fmtMoney(c.parsed.y) } } },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
          y: { ticks: { color: muted, font: { size: 10 }, precision: 0, callback: (v) => v >= 10000 ? (v / 10000).toFixed(1) + "万" : v }, grid: { color: line } },
        },
      },
    });
    const hintEl = el.querySelector("#nwTrendHint");
    if (hintEl) hintEl.textContent = nwHint;
    renderAssetPie(el, lastPieData || pieSplit || { saved: 0, stock: 0, fund: 0 }); // 优先行情后最新值，否则成本兜底
  }

  routes.dashboard = {
    title: "仪表盘",
    async render(el) {
      const [tasks, habits, finance, notes, stocks, exams, st, reminders, anniv, timelineEvs, bookmarks, trackers, trackerlogs, subscriptions] = await Promise.all([
        repo("tasks").list(),
        repo("habits").list(),
        repo("finance").list(),
        repo("notes").list(),
        repo("stocks").list(),
        repo("mockexams").list(),
        // 一次批量读全部 settings，避免 5 次独立 API 往返
        getSettings({ nickname: "朋友", saveTarget: 60000, gongkao_targets: [], monthBudget: 0, weeklyReview: null, reminderDone: {}, achUnlocked: {}, dashLayout: {}, finCatBudget: {}, finGoals: [] }),
        repo("reminders").list().catch(() => []),
        repo("anniv").list().catch(() => []),
        repo("timeline").list().catch(() => []),
        repo("bookmarks").list().catch(() => []),
        repo("trackers").list().catch(() => []),
        repo("trackerlogs").list().catch(() => []),
        repo("subscriptions").list().catch(() => []),
      ]);
      const nickname = st.nickname, gkTargets = st.gongkao_targets, monthBudget = st.monthBudget, weeklyCache = st.weeklyReview;
      // 储蓄目标：多目标桶（finGoals）优先取合计；未配置沿用单目标 saveTarget
      const finGoals = Array.isArray(st.finGoals) ? st.finGoals : [];
      const target = finGoals.length ? finGoals.reduce((s, g) => s + Number(g.target || 0), 0) : st.saveTarget;
      // 首页布局（Workspace 轻量版）：各区块显示开关，settings.dashLayout 覆盖默认全显
      const layout = Object.assign({ banners: 1, otd: 1, focus: 1, reminders: 1, trackers: 1, actions: 1, archive: 1 }, st.dashLayout || {});

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
      const saved = finance.filter((r) => window.WB.isSaving(r)).reduce((s, x) => s + Number(x.amount || 0), 0);
      const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;

      // 本月收支（income / expense 口径）：date 前 7 位 = YYYY-MM
      const thisMonth = today.slice(0, 7);
      const monthTx = finance.filter((r) => (r.date || "").slice(0, 7) === thisMonth);
      const mIncome = monthTx.filter((r) => r.type === "income").reduce((s, x) => s + Number(x.amount || 0), 0);
      const mExpense = monthTx.filter((r) => r.type === "expense").reduce((s, x) => s + Number(x.amount || 0), 0);
      const mNet = mIncome - mExpense;
      const netSign = mNet >= 0 ? "+" : "-";
      const netColor = mNet >= 0 ? "var(--ok)" : "var(--danger)";
      // 本年收支（供「本年结余」卡）：date 前 4 位 = YYYY
      const curYear = today.slice(0, 4);
      const yearTx = finance.filter((r) => (r.date || "").slice(0, 4) === curYear);
      const yIncome = yearTx.filter((r) => r.type === "income").reduce((s, x) => s + Number(x.amount || 0), 0);
      const yExpense = yearTx.filter((r) => r.type === "expense").reduce((s, x) => s + Number(x.amount || 0), 0);
      const yNet = yIncome - yExpense;
      const yNetSign = yNet >= 0 ? "+" : "-";
      const yNetColor = yNet >= 0 ? "var(--ok)" : "var(--danger)";

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

      // 倒数日横幅：最近一个未过去（含今天）的纪念日/倒计时挂首页（与倒数日页同一份数据）
      const annivDays = (a) => {
        const [yy, mm, dd] = (a.date || "2000-01-01").split("-").map(Number);
        const base = new Date(today + "T00:00:00");
        if (a.yearly === false) return Math.round((new Date(a.date + "T00:00:00") - base) / 86400000);
        for (let off = 0; off < 370; off++) {
          const dt = new Date(base.getTime() + off * 86400000);
          if (dt.getMonth() + 1 === mm && dt.getDate() === dd) return off;
        }
        return 999;
      };
      const upAnniv = (anniv || [])
        .map((a) => ({ a, d: annivDays(a) }))
        .filter((x) => x.d >= 0)
        .sort((p, q) => p.d - q.d)[0];
      let annivBanner = "";
      if (upAnniv) {
        const an = upAnniv.a, anDiff = upAnniv.d;
        const anEmoji = { birthday: "🎂", wedding: "💍", exam: "🎯", payday: "💰", trip: "✈️", other: "📌" }[an.category] || "📌";
        annivBanner = `<div class="dash-gk dash-anniv ${anDiff <= 7 ? "urgent" : ""}" data-go="#/anniv" title="去倒数日页">
          <span class="dash-gk-ico">${anEmoji}</span>
          <span class="dash-gk-name">${esc(an.title)}<small>${esc(an.date)}</small></span>
          <span class="dash-gk-day">${anDiff === 0 ? "就在今天" : `还有 <b>${anDiff}</b> 天`}</span>
        </div>`;
      }

      // 今日自定义提醒：按周期今天该做且今天还没完成
      const rmDue = (reminders || []).filter((r) => window.WB.remindDue(r, today));
      const rmDone = st.reminderDone || {};
      const rmPending = rmDue.filter((r) => !rmDone[r.id]);
      const rmDoneCount = rmDue.length - rmPending.length;
      const remindersHtml = rmDue.length
        ? `<div class="card">
            <h2>今日提醒<span class="count">${rmPending.length} 待做</span></h2>
            <ul class="list">
              ${rmDue.map((r) => {
                const done = !!rmDone[r.id];
                return `<li class="item ${done ? "done" : ""}">
                  <span class="chk" data-rm-done="${r.id}" title="${done ? "已完成（点一下撤销）" : "点一下标记完成"}"></span>
                  <span class="txt" ${done ? 'style="color:var(--muted);text-decoration:line-through"' : ""}>${esc(r.title)}</span>
                  <button class="btn sm ghost" data-go="#/reminders">去提醒页</button>
                </li>`;
              }).join("")}
            </ul>
          </div>` : "";

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
      // 持仓聚合用 db.js 的唯一实现 WB.aggregateStocks（按交易日期排序 + 卖出钳制），
      // 与股票页/统计页同一口径，补录历史交易三处数字一致
      const allGroups = window.WB.aggregateStocks(stocks);
      const stockHoldings = allGroups.filter((g) => (g.type || "stock") !== "fund" && g.holding > 0);
      const fundHoldings = allGroups.filter((g) => (g.type || "stock") === "fund" && g.holding > 0);
      const holdings = allGroups.filter((g) => g.holding > 0);
      const stockCostVal = holdings.reduce((s, g) => s + g.avgCost * g.holding, 0);
      // 资产配置饼图数据（成本兜底，异步行情回来后按市值刷新）
      const pieSplit = {
        saved,
        stock: stockHoldings.reduce((s, g) => s + g.avgCost * g.holding, 0),
        fund: fundHoldings.reduce((s, g) => s + g.avgCost * g.holding, 0),
      };
      const showNetWorth = saved > 0 || holdings.length > 0;
      const nwHtml = showNetWorth
        ? `<div class="card">
            <h2>净资产总览<span class="count">储蓄 + 持仓</span></h2>
            <div class="stat-grid">
              <div class="stat" data-go="#/finance"><div class="s-lab">本年结余</div><div class="s-val" style="color:${yNetColor}">${yNetSign}${fmtMoney(Math.abs(yNet))}</div><div class="s-sub">收 ${fmtMoney(yIncome)} · 支 ${fmtMoney(yExpense)}</div></div>
              <div class="stat" data-go="#/stocks"><div class="s-lab">持仓市值</div><div class="s-val" id="nwStock">${fmtMoney(stockCostVal)}</div><div class="s-sub" id="nwStockSub">${holdings.length ? "行情加载中…" : "暂无持仓"}</div></div>
              <div class="stat" data-go="#/stocks"><div class="s-lab">今日盈亏</div><div class="s-val c-muted" id="nwDay">—</div><div class="s-sub">股票涨跌 + 基金净值差</div></div>
              <div class="stat"><div class="s-lab">净资产合计</div><div class="s-val" id="nwTotal">${fmtMoney(saved + stockCostVal)}</div><div class="s-sub">储蓄 + 市值</div></div>
            </div>
            <div class="asset-pie-row">
              <div class="asset-pie-box"><canvas id="assetPie"></canvas></div>
              <div class="asset-pie-legend" id="assetPieLegend"></div>
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
      // 分类预算超支提醒：总预算未超（或未设）时，找超出最多的那个分类提醒
      const catBudgets = st.finCatBudget || {};
      const catOver = Object.keys(catBudgets)
        .map((cid) => ({
          cid,
          budget: Number(catBudgets[cid]) || 0,
          spent: monthTx.filter((r) => r.type === "expense" && r.category === cid).reduce((s, r) => s + Number(r.amount || 0), 0),
        }))
        .filter((x) => x.budget > 0 && x.spent > x.budget)
        .sort((a, b) => b.spent - b.budget - (a.spent - a.budget))[0];
      const catBanner = catOver
        ? `<div class="dash-banner warn" data-go="#/finance">⚠ 「${esc(CAT_NAMES[catOver.cid] || catOver.cid)}」已超分类预算：${fmtMoney(catOver.spent)} / ${fmtMoney(catOver.budget)}，超 ${fmtMoney(catOver.spent - catOver.budget)} 元 · <span class="c-accent">去记账页看预算</span></div>`
        : "";
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

      // 往年今日：聚合各 store 同月同日的历史数据（timeline.js 提供纯函数聚合器）
      let otdHtml = "";
      if (window.WB.timeline) {
        const otdYears = window.WB.timeline.onThisDay({ today, finance, tasks, notes, bookmarks, stocks, timeline: timelineEvs });
        if (otdYears.length) {
          const g = otdYears[0];
          otdHtml = `<div class="card dash-otd">
            <h2>往年今日<span class="count">${g.year} 年的今天</span></h2>
            ${g.items.slice(0, 4).map((i) => `<div class="otd-item" data-go="${i.go || ""}" style="cursor:${i.go ? "pointer" : "default"}">${i.icon} ${esc(i.text)}</div>`).join("")}
            ${otdYears.length > 1 || g.items.length > 4 ? `<a href="#/timeline" class="c-accent" style="font-size: 12px">更多年份与回忆 →</a>` : ""}
          </div>`;
        }
      }

      // 成就：近 7 天解锁的以一条轻量横幅展示（数据只读 settings，计算在成就页/启动日检）
      let achStrip = "";
      if (window.WB.achievements && st.achUnlocked) {
        const weekAgo = new Date(Date.now() - 7 * 86400000);
        const pad = (n) => String(n).padStart(2, "0");
        const wkStr = `${weekAgo.getFullYear()}-${pad(weekAgo.getMonth() + 1)}-${pad(weekAgo.getDate())}`;
        const recentAch = Object.keys(st.achUnlocked)
          .filter((id) => st.achUnlocked[id] >= wkStr)
          .map((id) => ({ id, at: st.achUnlocked[id], rule: window.WB.achievements.RULES.find((r) => r.id === id) }))
          .filter((x) => x.rule)
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 3);
        if (recentAch.length) {
          achStrip = `<div class="card ach-banner">
            <div class="ach-banner-in">🎉 新成就：${recentAch.map((a) => `${a.rule.icon} ${esc(a.rule.name)}`).join(" · ")} <a href="#/achievements" class="c-accent">成就殿堂 →</a></div>
          </div>`;
        }
      }

      // 订阅到期横幅：未来 7 天内将扣费的订阅（subs.js 提供计算）
      let subBanner = "";
      if (window.WB.subs && (subscriptions || []).length) {
        const upc = window.WB.subs.upcoming(subscriptions, today);
        if (upc.length) {
          subBanner = `<div class="dash-banner warn" data-go="#/subs" title="去订阅中心">🔁 ${upc
            .slice(0, 2)
            .map((x) => `${esc(x.s.name)} ${x.days === 0 ? "今天" : x.days + " 天后"}扣费 ${(x.s.currency === "USD" ? "$" : "¥") + Number(x.s.amount || 0).toFixed(0)}`)
            .join(" · ")}${upc.length > 2 ? ` 等 ${upc.length} 项` : ""} · <span class="c-accent">订阅中心 →</span></div>`;
        }
      }

      // 追踪器快速记录卡（有追踪器才显示）
      let trackerCard = "";
      if ((trackers || []).length && window.WB.tracker) {
        const fmtV = window.WB.tracker.fmtVal;
        const rows = trackers
          .slice()
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .slice(0, 6)
          .map((t) => {
            const tl = (trackerlogs || []).filter((l) => l.tid === t.id && l.date === today);
            const sum = tl.reduce((s, l) => s + Number(l.value || 0), 0);
            const ctl =
              t.dtype === "count"
                ? `<button class="btn sm" data-dashlog="${t.id}" data-v="1">＋1</button>`
                : t.dtype === "bool"
                ? `<button class="btn sm ${sum > 0 ? "ghost" : ""}" data-dashlog="${t.id}" data-v="1">${sum > 0 ? "✓ 已记" : "记录"}</button>`
                : t.dtype === "rating"
                ? [1, 2, 3, 4, 5].map((n) => `<button class="btn sm ghost" data-dashlog="${t.id}" data-v="${n}">${n}</button>`).join("")
                : `<input type="number" step="0.1" placeholder="数值" style="max-width:84px" data-dashlogval="${t.id}" /><button class="btn sm ghost" data-dashloggo="${t.id}">记</button>`;
            return `<li class="item">
              <span class="dot" style="background:${esc(t.color || "#c9956b")}"></span>
              <span class="txt" ${sum ? "" : ""}>${esc(t.icon || "📊")} ${esc(t.name)}</span>
              <span class="meta">${tl.length ? esc(fmtV(t, t.dtype === "number" && tl.length ? tl[tl.length - 1].value : sum)) : "今天未记"}</span>
              ${ctl}
            </li>`;
          })
          .join("");
        trackerCard = `<div class="card">
          <h2>追踪器<span class="count"><a href="#/tracker" class="c-accent">全部 →</a></span></h2>
          <ul class="list" id="dashTrackers">${rows}</ul>
        </div>`;
      }


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

      // v96：回退到紧凑 hero 架构（不再做大色卡 + 插画）。
      // hero 区保留 v94 的小数字条（4 格），但本次只做调色与质感，
      // 不再加新结构。skill-v96 = 「米黄纸 + 奶油白 + 细描边」记账 App 质感。
      const dashCfgHtml = dashCfgOpen
        ? `<div class="card" id="dashCfgCard">
            <h2>自定义首页<span class="count">勾选要显示的区块，立即生效</span></h2>
            ${DASH_SECTIONS.map((s) => `<div class="set-row"><label class="an-yearly"><input type="checkbox" data-dashsec="${s.k}" ${layout[s.k] !== 0 ? "checked" : ""} /> ${s.name}</label></div>`).join("")}
            <div class="row sp-t-sm">
              <button class="btn sm ghost" id="dashPresetDefault">恢复默认</button>
              <button class="btn sm ghost" id="dashPresetMin">极简模式（只留今日焦点）</button>
              <button class="btn sm" id="dashCfgDone">完成</button>
            </div>
          </div>`
        : "";

      el.innerHTML = `
        <div class="dash-hero">
          <div class="dh-head">
            <div class="hero-greet">${greet}，${esc(nickname)}！</div>
            <div class="hero-date">${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · 星期${wk}${
              focus.length ? " · 今天有 " + focus.length + " 件事需要关注" : " · 今天没有到期事项，安心推进"
            }${notifyBtnHtml} <button class="icon-btn plain" id="dashCfgBtn" title="自定义首页显示的区块">⚙</button></div>
          </div>
          <div class="dh-stats" id="dashHeroStats">
            <div class="dh-cell" data-go="#/finance" title="去记账页"><span class="dh-lab">本月结余</span><span class="dh-val" style="color:${netColor}">${netSign}${fmtMoney(Math.abs(mNet))}</span><span class="dh-sub">收 ${fmtMoney(mIncome)} · 支 ${fmtMoney(mExpense)}</span></div>
            <div class="dh-cell" data-go="#/finance" title="去记账页"><span class="dh-lab">本月支出</span><span class="dh-val">${fmtMoney(mExpense)}</span><span class="dh-sub">${monthBudget > 0 ? "预算 " + fmtMoney(monthBudget) : "未设预算"}</span></div>
            <div class="dh-cell" data-go="#/tasks" title="去事务页"><span class="dh-lab">今日待办</span><span class="dh-val">${dueToday.length} / ${overdue.length}</span><span class="dh-sub">到期 / 逾期 · 共 ${active.length} 项</span></div>
            <div class="dh-cell" data-go="#/life" title="去生活页"><span class="dh-lab">今日打卡</span><span class="dh-val">${habitDone} / ${habits.length}</span><span class="dh-sub">${habits.length === 0 ? "还没有习惯" : habitDone >= habits.length ? "全部完成 🎉" : "还差 " + (habits.length - habitDone) + " 个"}</span></div>
          </div>
        </div>
        ${dashCfgHtml}
        ${layout.banners ? gkBanner + annivBanner + saveBanner + (budgetBanner || catBanner) + subBanner + achStrip : ""}
        ${layout.otd ? otdHtml : ""}
        ${layout.focus ? `
        <div class="card">
          <h2>今日焦点<span class="count">今日 ${focus.length} 项 · 本周 ${weekCnt} 项</span></h2>
          <div class="focus-tl" id="focusList">
            ${focus.length === 0 ? '<div class="empty">今天没有到期或逾期的任务，去 <a href="#/tasks">事务</a> 里安排一下？</div>' : focusSorted.map((t) => tlRow(t, false)).join("")}
            ${doneToday.length ? '<div class="tl-sep"><span>已检票 · 今日完成</span></div>' + doneToday.slice(0, 8).map((t) => tlRow(t, true)).join("") : ""}
          </div>
        </div>
        ` : ""}
        ${layout.reminders ? remindersHtml : ""}
        ${layout.trackers ? trackerCard : ""}
        ${layout.actions ? `
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
              <div class="mini-bar-lab">年度储蓄 ${fmtMoney(saved)} / ${fmtMoney(target)}（${pct}%） · <a href="#/finance" class="c-accent">去记账页</a></div>
              <div class="save-ring" id="dashRing" style="--p:${pct}" title="年度储蓄目标进度">
                <svg viewBox="0 0 36 36" aria-hidden="true">
                  <circle class="rg-bg" cx="18" cy="18" r="15.9"></circle>
                  <circle class="rg-fg" cx="18" cy="18" r="15.9"></circle>
                </svg>
                <div class="rg-txt"><b>${pct}%</b><span>储蓄目标</span></div>
              </div>
            </div>
            <div class="card">
              <h2>最近沉淀</h2>
              <ul class="list" id="dashNotes">${noteRows}</ul>
            </div>
          </div>
        </div>
        ` : ""}
        ${layout.archive ? `
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
        ` : ""}
        <div class="footnote">数据保存在服务器 SQLite（workbench.db） · 建议定期到「设置」导出 JSON 备份 · 右上 ⚙ 可自定义首页区块</div>`;

      // 图表位于折叠归档区：折叠时 canvas 无尺寸，展开时才（重新）渲染
      const archiveEl = el.querySelector("#dashArchive");
      if (archiveEl) {
        archiveEl.addEventListener("toggle", () => {
          dashArchiveOpen = archiveEl.open;
          if (archiveEl.open) renderCharts(el, tasks, habits, finance, stockCostVal, pieSplit);
        });
        if (archiveEl.open) renderCharts(el, tasks, habits, finance, stockCostVal, pieSplit);
      } else {
        renderCharts(el, tasks, habits, finance, stockCostVal, pieSplit);
      }

      // 首页自定义（Workspace 轻量版）：⚙ 开关面板、勾选即时保存、预设
      const cfgBtn = el.querySelector("#dashCfgBtn");
      if (cfgBtn) cfgBtn.addEventListener("click", () => { dashCfgOpen = !dashCfgOpen; navigate(); });
      const cfgCard = el.querySelector("#dashCfgCard");
      if (cfgCard) {
        cfgCard.addEventListener("change", async (e) => {
          const k = e.target.dataset && e.target.dataset.dashsec;
          if (!k) return;
          const cur = { ...((await getSetting("dashLayout", {})) || {}) };
          cur[k] = e.target.checked ? 1 : 0;
          await setSetting("dashLayout", cur);
          navigate();
        });
        const applyPreset = async (obj) => { await setSetting("dashLayout", obj); navigate(); };
        el.querySelector("#dashPresetDefault").addEventListener("click", () => applyPreset({}));
        el.querySelector("#dashPresetMin").addEventListener("click", () =>
          applyPreset({ banners: 0, otd: 0, focus: 1, reminders: 0, trackers: 0, actions: 0, archive: 0 })
        );
        el.querySelector("#dashCfgDone").addEventListener("click", () => { dashCfgOpen = false; navigate(); });
      }

      // finesse number roll-up：统计卡数字 0 → 目标滚动（零依赖；尊重 prefers-reduced-motion）
      const prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!prefersReduced) {
        const rollTargets = [];
        el.querySelectorAll(".stat .s-val, .dh-cell .dh-val").forEach((node) => {
          const raw = (node.textContent || "").trim();
          const m = raw.match(/^(\d[\d,\.]*)$/);
          if (m) rollTargets.push({ node, target: parseFloat(m[1].replace(/,/g, "")) });
        });
        rollTargets.forEach(({ node, target }, i) => {
          setTimeout(() => {
            const dur = 650;
            const t0 = performance.now();
            // 金额格式化：千位分隔符 + 保留原小数（修复长金额被 Math.round 截断成整数丢逗号）
            const fmt = (v) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
            const step = (t) => {
              const p = Math.min(1, (t - t0) / dur);
              const eased = 1 - Math.pow(1 - p, 3);
              node.textContent = fmt(target * eased);
              if (p < 1) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }, 150 + i * 80);
        });
      }

      el.querySelectorAll("[data-go]").forEach((s) => s.addEventListener("click", () => (location.hash = s.dataset.go)));
      // 以下区块可能被「自定义首页」隐藏：绑定前判空
      const focusListEl = el.querySelector("#focusList");
      if (focusListEl) focusListEl.addEventListener("click", async (e) => {
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
      const dashHabitsEl = el.querySelector("#dashHabits");
      if (dashHabitsEl) dashHabitsEl.addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-hid]");
        if (!btn) return;
        const hb = await repo("habits").get(btn.dataset.hid);
        if (!hb) return;
        hb.checkins = hb.checkins || {};
        if (hb.checkins[today]) delete hb.checkins[today]; else hb.checkins[today] = true;
        await repo("habits").put(hb);
        navigate();
      });

      // 追踪器快速记录：+1 / 评分 / 数值（记账后整页刷新，看到当日累计）
      const dashTrackersEl = el.querySelector("#dashTrackers");
      if (dashTrackersEl) {
        dashTrackersEl.addEventListener("click", async (e) => {
          const go = e.target.closest("[data-dashloggo]");
          const btn = e.target.closest("[data-dashlog]");
          if (!go && !btn) return;
          try {
            if (go) {
              const input = el.querySelector(`[data-dashlogval="${go.dataset.dashloggo}"]`);
              const v = Number(input.value);
              if (!input.value || isNaN(v) || v <= 0) return flashInvalid(input);
              await window.WB.tracker.quickLog(go.dataset.dashloggo, v);
            } else {
              await window.WB.tracker.quickLog(btn.dataset.dashlog, btn.dataset.v);
            }
            showToast("已记录", "ok");
            navigate();
          } catch (err) {
            showToast("记录失败：" + err.message, "error");
          }
        });
        dashTrackersEl.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || !e.target.dataset.dashlogval) return;
          const go = el.querySelector(`[data-dashloggo="${e.target.dataset.dashlogval}"]`);
          if (go) go.click();
        });
      }

      // 快速记支出：仪表盘小卡快速录一笔当日支出（跳去记账页看更多）；锁防双击/双 Enter 重复入账
      let dFinBusy = false;
      const dFinAdd = async () => {
        if (dFinBusy) return;
        const amountInput = el.querySelector("#dFinAmount");
        const amount = parseFloat(amountInput.value);
        if (!(amount > 0)) return flashInvalid(amountInput);
        dFinBusy = true;
        try {
          const rec = {
            id: uid(), type: "expense",
            category: el.querySelector("#dFinCategory").value,
            amount,
            note: el.querySelector("#dFinNote").value.trim(),
            date: today,
          };
          await repo("finance").put(rec);
          // 记账页有会话级缓存，跨模块写入后使其失效，避免下次进入读到旧数据
          if (window.WB.finCache) window.WB.finCache.invalidate();
        } finally { dFinBusy = false; }
        navigate();
      };
      const dFinAddBtn = el.querySelector("#dFinAdd");
      if (dFinAddBtn) dFinAddBtn.addEventListener("click", dFinAdd);
      const dFinNoteEl = el.querySelector("#dFinNote");
      if (dFinNoteEl) dFinNoteEl.addEventListener("keydown", (e) => { if (e.key === "Enter") dFinAdd(); });

      // 最近沉淀：经 WB.jump 句柄跳到笔记页并定位到该篇
      const dashNotesEl = el.querySelector("#dashNotes");
      if (dashNotesEl) dashNotesEl.addEventListener("click", (e) => {
        const li = e.target.closest("[data-nid]");
        if (!li) return;
        WB.jump.noteId = li.dataset.nid;
        location.hash = "#/notes";
      });

      // 今日自定义提醒：勾选切换当天完成状态（与提醒页同一份 settings）
      el.querySelectorAll("[data-rm-done]").forEach((chk) =>
        chk.addEventListener("click", async () => {
          const id = chk.dataset.rmDone;
          const done = (await getSettings({ reminderDone: {} })).reminderDone || {};
          if (done[id]) delete done[id]; else done[id] = true;
          await setSetting("reminderDone", done);
          navigate();
        })
      );

      // 净资产：异步拉行情把成本价兜底值替换成实时市值（失败保持兜底显示）
      // 股票走 /api/stock/quote，基金走 /api/fund/nav（净值），合并计算市值与当日盈亏
      const nwCodes = [...new Set(holdings.map((r) => r.code).filter(Boolean))];
      if (showNetWorth && nwCodes.length && window.WB.USE_API) {
        const token = navSeq; // 记住本次渲染代数：仪表盘频繁自重渲染，防止过期行情覆盖新页面
        (async () => {
          try {
            const [stockRes, fundRes] = await Promise.all([
              stockHoldings.length ? WB.rawApi("/api/stock/quote?codes=" + encodeURIComponent(stockHoldings.map((r) => r.code).join(","))) : Promise.resolve(null),
              fundHoldings.length ? WB.rawApi("/api/fund/nav?codes=" + encodeURIComponent(fundHoldings.map((r) => r.code).join(","))) : Promise.resolve(null),
            ]);
            const qmap = {};
            if (stockRes && stockRes.ok) (await stockRes.json()).forEach((q) => { qmap[q.code] = q; });
            if (fundRes && fundRes.ok) (await fundRes.json()).forEach((q) => { qmap[q.code] = { price: q.isMoney ? 1 : q.nav, change: q.isMoney ? q.nav / 10000 : q.nav - q.prevNav }; });
            // await 期间可能已切走或重渲染，元素不在了或代数变了就放弃
            const stockEl = el.querySelector("#nwStock");
            if (token !== navSeq || !stockEl) return;
            let mv = 0, day = 0, quoted = false, stockMv = 0, fundMv = 0;
            holdings.forEach((r) => {
              const q = qmap[r.code];
              const val = q ? q.price * r.holding : r.avgCost * r.holding;
              if (r.type === "fund") fundMv += val; else stockMv += val;
              if (q) { quoted = true; mv += q.price * r.holding; day += q.change * r.holding; }
              else mv += val;
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
            // 资产配置饼图按实时市值刷新（canvas 不在时记录数据，归档区展开后 renderCharts 取用）
            lastPieData = { saved, stock: stockMv, fund: fundMv };
            renderAssetPie(el, lastPieData);
          } catch (e) { /* 行情拉取失败保持成本价兜底 */ }
        })();
      }

      // 到期任务浏览器通知：每天首次打开仪表盘时提醒一次（频控用 localStorage，按设备而非账号）
      const NOTIFY_KEY = "wb2_notify_day";
      function sendDueNotice() {
        const title = "我的仪表盘 · 任务提醒";
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
      const wrGenBtn = el.querySelector("#wrGen");
      if (wrGenBtn) wrGenBtn.addEventListener("click", async () => {
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
      let navPinned = await getSetting("navPinned", null);
      if (!Array.isArray(navPinned) || !navPinned.length) navPinned = DEFAULT_PINNED.slice();
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
        <details class="card set-fold">
          <summary><h2>用户管理<span class="count">仅管理员</span></h2></summary>
          <div class="set-fold-body">
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
          </div>
        </details>` : ""}
        <div class="card">
          <h2>个人资料</h2>
          <div class="set-row">
            <span class="s-name">昵称</span>
            <input id="nickInput" maxlength="12" value="${esc(nickname)}" class="w-180" />
            <button class="btn sm" id="nickSave">保存</button>
          </div>
        </div>
        <div class="card">
          <h2>外观<span class="count">主题</span></h2>
          <div class="set-row" style="align-items:flex-start">
            <span class="s-name">主题选择</span>
            <div class="theme-picker" id="themePicker">
              ${ALL_THEMES.map((t) => `
                <button class="tp-item" data-tp="${t.key}" title="${esc(t.desc || "")}">
                  <span class="tp-ic">${t.icon}</span>
                  <span class="tp-txt">${esc(t.text)}</span>
                </button>`).join("")}
            </div>
          </div>
          <div class="set-row">
            <span class="s-name">说明</span>
            <span class="s-desc">左下角主题按钮只在「亮色 / 暗色」间快速切换；其它风格主题在这里选择。</span>
          </div>
        </div>
        <div class="card">
          <h2>导航定制<span class="count">点选侧栏置顶的模块</span></h2>
          <div class="set-row" style="align-items:flex-start">
            <span class="s-name">置顶模块</span>
            <div class="nav-pin-picker" id="navPinPicker">
              ${Object.keys(ROUTE_META).filter((r) => r !== "dashboard").map((r) => `
                <button type="button" class="np-item ${navPinned.indexOf(r) !== -1 ? "on" : ""}" data-navpin="${r}">${ROUTE_META[r].name}</button>`).join("")}
            </div>
          </div>
          <div class="set-row">
            <span class="s-name">说明</span>
            <span class="s-desc">置顶模块直接显示在侧栏与手机底栏，其余收进「全部功能」抽屉（功能与数据不受影响）。至少保留一个，清空时恢复默认。</span>
          </div>
        </div>
        <details class="card set-fold">
          <summary><h2>运行模式</h2></summary>
          <div class="set-fold-body">
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
        </details>
        <details class="card set-fold">
          <summary><h2>数据同步<span class="count">本地 ⇄ 服务器</span></h2></summary>
          <div class="set-fold-body">
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
        </details>
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
        ${window.WB.USE_API ? `
        <details class="card set-fold">
          <summary><h2>云备份<span class="count">WebDAV · 坚果云</span></h2></summary>
          <div class="set-fold-body">
          <div class="set-row">
            <span class="s-name">服务器地址</span>
            <input id="wdavUrl" class="input fx1" placeholder="https://dav.jianguoyun.com/dav/" />
          </div>
          <div class="set-row">
            <span class="s-name">账号</span>
            <input id="wdavUser" class="input fx1" placeholder="坚果云登录邮箱" autocomplete="username" />
          </div>
          <div class="set-row">
            <span class="s-name">应用授权码</span>
            <input id="wdavPass" type="password" class="input fx1" placeholder="坚果云网页版生成的授权码（非登录密码），留空表示沿用已保存的" autocomplete="current-password" />
            <button class="btn sm" id="wdavSaveBtn">保存</button>
            <button class="btn sm" id="wdavTestBtn">测试连接</button>
          </div>
          <div class="set-row">
            <span class="s-name">备份目录</span>
            <input id="wdavDir" class="input w-170" placeholder="workbench-backup" />
            <span class="s-desc">远端 WebDAV 下的子目录，不存在会自动创建</span>
          </div>
          <div class="set-row">
            <span class="s-name">保留份数</span>
            <input id="wdavKeep" type="number" min="1" max="50" class="input w-80" value="10" />
            <span class="s-desc">超出后自动删除最早的远端备份</span>
          </div>
          <div class="set-row">
            <span class="s-name">自动备份</span>
            <span class="s-desc">每周日自动推送一份云端备份（后台定时任务，服务运行中也会触发）；服务重启当天也会自动备份一次</span>
          </div>
          <div class="set-row">
            <span class="s-name">立即备份</span>
            <button class="btn sm" id="wdavBackupBtn">备份到云端</button>
            <span class="s-desc" id="wdavStatus">未配置</span>
          </div>
          <div id="wdavList"><div class="empty">还没有远端备份</div></div>
          <div class="set-row" style="align-items:flex-start">
            <span class="s-name">说明</span>
            <span class="s-desc">坚果云授权码获取：网页版右上角头像 → 设置 → 安全选项 → 添加应用 → 生成授权码。备份的是<b>当前账号</b>完整数据库（含任务/笔记/记账等全部数据）。服务每次启动时自动推送一份，另外<b>每周日</b>固定自动备份一次（后台定时任务，无需重启服务器）。凭据仅存服务器端，与网盘 Cookie 同级，请勿分享。</span>
          </div>
          </div>
        </details>` : ""}
        <details class="card set-fold">
          <summary><h2>网盘配置</h2></summary>
          <div class="set-fold-body">
          <div id="driveSettingsArea"></div>
          </div>
        </details>
        <details class="card set-fold">
          <summary><h2>危险操作</h2></summary>
          <div class="set-fold-body">
          <div class="set-row">
            <span class="s-name">清除所有数据</span>
            <button class="btn danger sm" id="clearAllBtn">清空全部数据</button>
            <span class="s-desc">⚠️ 不可恢复！将删除任务、笔记、收藏、习惯、财务等全部数据，操作前务必先导出备份。</span>
          </div>
          </div>
        </details>
        <details class="card set-fold">
          <summary><h2>关于</h2></summary>
          <div class="set-fold-body">
          <div style="font-size:13px;color:var(--muted);line-height:1.9">
            不会用？看 <a href="#/help">使用帮助</a>（小白向操作手册，也可直接打开项目根目录的 HELP.md）<br />
            我的仪表盘 v2 · 原生前端 + Python(FastAPI) + SQLite · 多账号登录，数据按账号隔离<br />
            每个账号一个独立库文件（管理员 workbench.db，其他 workbench_用户名.db），备份 = 复制该文件；启动命令 python server.py。<br />
            存储层已做 Repository 抽象，db.js 中 USE_API=false 可整体回退纯浏览器模式。<br />
            调试：<a href="/api/docs" target="_blank" rel="noopener">API 文档（Swagger）</a>
          </div>
          </div>
        </details>`;

      // 自动备份状态：服务端每次启动时备份 workbench.db 到 backups/，保留最近 7 份
      const bkEl = el.querySelector("#backupStatus");
      if (window.WB.USE_API) {
        WB.rawApi("/api/backup/status")
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

      // WebDAV 云备份（在线模式）
      if (window.WB.USE_API) {
        const wdavListEl = el.querySelector("#wdavList");
        async function wdavRefreshList() {
          try {
            const res = await WB.rawApi("/api/webdav/list");
            if (!res.ok) throw new Error("HTTP " + res.status);
            const files = (await res.json()).files || [];
            if (!wdavListEl) return;
            if (!files.length) {
              wdavListEl.innerHTML = '<div class="empty">还没有远端备份，点「备份到云端」生成第一份</div>';
              return;
            }
            wdavListEl.innerHTML = files
              .map((f) => `<div class="set-row">
                  <span class="s-name" style="white-space:normal">${esc(f.name)}</span>
                  <span class="s-desc">${(f.size / 1024).toFixed(1)} KB · ${esc(f.mtime || "")}</span>
                  <button class="btn danger sm" data-wdav-restore="${esc(f.name)}">恢复</button>
                </div>`)
              .join("");
            wdavListEl.querySelectorAll("[data-wdav-restore]").forEach((b) =>
              b.addEventListener("click", async () => {
                const name = b.getAttribute("data-wdav-restore");
                if (!confirm(`确定用远端备份「${name}」覆盖当前账号全部数据？不可撤销，建议先备份一次。`)) return;
                const hideLoading = showLoading("正在恢复...");
                try {
                  const r = await WB.rawApi("/api/webdav/restore", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ file: name }),
                  });
                  const d = await r.json().catch(() => ({}));
                  if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
                  hideLoading();
                  showToast(`已恢复 ${d.rows} 条记录`, "success");
                  wdavRefreshList();
                } catch (e) {
                  hideLoading();
                  showToast("恢复失败：" + e.message, "error");
                }
              })
            );
          } catch (e) {
            if (wdavListEl) wdavListEl.innerHTML = `<div class="empty">查询失败：${esc(e.message)}</div>`;
          }
        }

        const wdavUrl = el.querySelector("#wdavUrl");
        const wdavUser = el.querySelector("#wdavUser");
        const wdavPass = el.querySelector("#wdavPass");
        const wdavDir = el.querySelector("#wdavDir");
        const wdavKeep = el.querySelector("#wdavKeep");
        // 回显已保存配置（授权码不回显）
        WB.rawApi("/api/webdav/config")
          .then((r) => r.json())
          .then((c) => {
            if (wdavUrl && c.url) wdavUrl.value = c.url;
            if (wdavUser && c.user) wdavUser.value = c.user;
            if (wdavDir && c.dir) wdavDir.value = c.dir;
            if (wdavKeep && c.keep) wdavKeep.value = c.keep;
            if (c.configured) {
              const statusEl = el.querySelector("#wdavStatus");
              if (statusEl && statusEl.textContent === "未配置") statusEl.textContent = "已配置，可点「测试连接」验证";
            }
          })
          .catch(() => {});
        const wdavSaveBtn = el.querySelector("#wdavSaveBtn");
        if (wdavSaveBtn)
          wdavSaveBtn.addEventListener("click", async () => {
            const hideLoading = showLoading("正在保存...");
            try {
              const r = await WB.rawApi("/api/webdav/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  url: wdavUrl.value.trim(),
                  user: wdavUser.value.trim(),
                  pass: wdavPass.value,
                  dir: wdavDir.value.trim(),
                  keep: Number(wdavKeep.value) || 10,
                }),
              });
              const d = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
              hideLoading();
              showToast("已保存", "success");
            } catch (e) {
              hideLoading();
              showToast("保存失败：" + e.message, "error");
            }
          });
        const wdavTestBtn = el.querySelector("#wdavTestBtn");
        if (wdavTestBtn)
          wdavTestBtn.addEventListener("click", async () => {
            const statusEl = el.querySelector("#wdavStatus");
            if (statusEl) { statusEl.textContent = "测试中…"; statusEl.style.color = ""; }
            const hideLoading = showLoading("正在测试连接...");
            try {
              const r = await WB.rawApi("/api/webdav/test", { method: "POST" });
              const d = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
              hideLoading();
              if (statusEl) { statusEl.textContent = "✓ 连接成功，可访问备份目录"; statusEl.style.color = "var(--ok)"; }
              showToast("WebDAV 连接成功", "success");
              wdavRefreshList();
            } catch (e) {
              hideLoading();
              if (statusEl) { statusEl.textContent = "✗ " + e.message; statusEl.style.color = "var(--danger)"; }
              showToast("连接失败：" + e.message, "error");
            }
          });
        const wdavBackupBtn = el.querySelector("#wdavBackupBtn");
        if (wdavBackupBtn)
          wdavBackupBtn.addEventListener("click", async () => {
            const hideLoading = showLoading("正在备份到云端...");
            try {
              const r = await WB.rawApi("/api/webdav/backup", { method: "POST" });
              const d = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(d.detail || "HTTP " + r.status);
              hideLoading();
              showToast("备份完成：" + d.name, "success");
              const statusEl = el.querySelector("#wdavStatus");
              if (statusEl) { statusEl.textContent = "✓ 已备份：" + d.name; statusEl.style.color = "var(--ok)"; }
              wdavRefreshList();
            } catch (e) {
              hideLoading();
              showToast("备份失败：" + e.message, "error");
            }
          });
        wdavRefreshList();
      }

      // 账号：修改密码 / 退出登录（仅在线模式渲染了这些控件）
      const pwdSaveBtn = el.querySelector("#pwdSaveBtn");
      if (pwdSaveBtn) pwdSaveBtn.addEventListener("click", async () => {
        const oldPwd = el.querySelector("#pwdOld").value;
        const newPwd = el.querySelector("#pwdNew").value;
        if (!oldPwd || newPwd.length < 6) return showToast("请填写原密码，新密码至少 6 位", "error");
        try {
          const res = await WB.rawApi("/api/auth/password", {
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
          const res = await WB.rawApi("/api/auth/users");
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
                const r = await WB.rawApi(`/api/auth/users/${encodeURIComponent(name)}/password`, {
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
                const r = await WB.rawApi(`/api/auth/users/${encodeURIComponent(name)}`, { method: "DELETE" });
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
            const res = await WB.rawApi("/api/auth/users", {
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

      // 外观：主题选择器（高亮当前主题，点击即应用）
      const picker = el.querySelector("#themePicker");
      if (picker) {
        let curT = document.documentElement.getAttribute("data-theme");
        try { curT = localStorage.getItem(THEME_KEY) || curT; } catch (e) { /* ignore */ }
        picker.querySelectorAll("[data-tp]").forEach((b) => {
          if (b.dataset.tp === curT) b.classList.add("on");
          b.addEventListener("click", () => {
            setThemeDirect(b.dataset.tp);
            picker.querySelectorAll("[data-tp]").forEach((x) => x.classList.toggle("on", x === b));
            showToast("主题已切换", "success");
          });
        });
      }

      // 导航定制：点选置顶模块，保存后即时重排侧栏与底栏（无需刷新）
      const pinPicker = el.querySelector("#navPinPicker");
      if (pinPicker) {
        pinPicker.addEventListener("click", async (e) => {
          const b = e.target.closest("[data-navpin]");
          if (!b) return;
          const r = b.dataset.navpin;
          const saved = await getSetting("navPinned", null);
          const cur = new Set(Array.isArray(saved) && saved.length ? saved : DEFAULT_PINNED.slice());
          if (cur.has(r)) cur.delete(r); else cur.add(r);
          if (!cur.size) DEFAULT_PINNED.forEach((x) => cur.add(x)); // 至少保留一个，清空恢复默认
          b.classList.toggle("on", cur.has(r));
          await setSetting("navPinned", Array.from(cur));
          await applyNavPinned();
          showToast("导航已更新", "ok");
        });
      }

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
    initGlobalShortcuts();
    // 先探测后端，确定 USE_API 后再渲染业务模块，避免 settings/repo 抓错源
    await window.WB.ready;
    await applyNavPinned(); // 导航收敛：依赖 settings，须在 ready 后重排（分组事件已委托不受影响）
    // chart 大库异步预取（不阻塞首屏渲染；SW 缓存命中时毫秒级）。xlsx 仅记账导入时按需加载。
    window.WB.loadScript("/lib/chart.umd.min.js").catch(() => {});
    // 专注/速记两个 FAB 属低频入口：空闲 2 秒后再加载，减少首屏要执行的脚本
    setTimeout(() => {
      window.WB.loadScript("/js/focus.js").catch(() => {});
      window.WB.loadScript("/js/quick.js").catch(() => {});
    }, 2000);
    window.WB._booted = true;
    renderModeBadge();
    // 与 settings 中的主题对齐（首次无 localStorage 缓存时）
    getSetting("theme", null).then((t) => {
      if (t && t !== document.documentElement.getAttribute("data-theme")) applyTheme(t);
    });
    window.addEventListener("hashchange", navigate);
    if (!location.hash) location.hash = "#/dashboard";
    navigate();

    // 成就日检：每天首次打开静默计算一次，新解锁弹 toast（localStorage 记当日已查，避免每次刷新重算）
    try {
      const today = todayStr();
      if (localStorage.getItem("wb2_ach_day") !== today && window.WB.achievements) {
        localStorage.setItem("wb2_ach_day", today);
        setTimeout(() => window.WB.achievements.checkNew(false), 2500);
      }
    } catch (e) { /* 隐私模式忽略 */ }

    // 网络状态变化时刷新徽标（离线后再回来时提示用户可重连）
    window.addEventListener("online", renderModeBadge);
    window.addEventListener("offline", renderModeBadge);
  });

  // ================= 导航收敛 =================
  // 高频模块置顶（settings.navPinned，默认 记账/股票/资讯/网盘），其余收进「全部功能」抽屉；
  // 移动端底栏 = 首页 + 置顶前 3 + 更多。纯导航层重排：不删功能、不丢数据、随时可在设置页改回。
  const DEFAULT_PINNED = ["finance", "stocks", "news", "drive"];
  const ROUTE_META = {
    dashboard: { icon: "i-home", name: "仪表盘" },
    tasks: { icon: "i-tasks", name: "事务" },
    calendar: { icon: "i-cal", name: "日历" },
    anniv: { icon: "i-anniv", name: "倒数日" },
    reminders: { icon: "i-remind", name: "提醒" },
    gongkao: { icon: "i-gk", name: "考公" },
    notes: { icon: "i-notes", name: "沉淀" },
    timeline: { icon: "i-timeline", name: "时间轴" },
    achievements: { icon: "i-ach", name: "成就" },
    tracker: { icon: "i-track", name: "追踪" },
    time: { icon: "i-time", name: "时间账本" },
    contacts: { icon: "i-contacts", name: "联系人" },
    life: { icon: "i-life", name: "生活" },
    finance: { icon: "i-finance", name: "记账" },
    subs: { icon: "i-sub", name: "订阅" },
    reports: { icon: "i-reports", name: "统计" },
    stocks: { icon: "i-stock", name: "股票" },
    news: { icon: "i-news", name: "资讯" },
    media: { icon: "i-media", name: "书影音" },
    drive: { icon: "i-drive", name: "网盘" },
    links: { icon: "i-links", name: "入口" },
    settings: { icon: "i-settings", name: "设置" },
    help: { icon: "i-help", name: "帮助" },
  };
  const navLinkHtml = (r) => {
    const m = ROUTE_META[r];
    return `<a href="#/${r}" data-route="${r}"><span class="nic"><svg class="ic"><use href="#${m.icon}"/></svg></span><span>${m.name}</span>${r === "news" ? '<span class="nav-badge" data-newsbadge hidden></span>' : ""}</a>`;
  };

  async function applyNavPinned() {
    let pinned = await getSetting("navPinned", null);
    if (!Array.isArray(pinned) || !pinned.length) pinned = DEFAULT_PINNED.slice();
    pinned = pinned.filter((r) => ROUTE_META[r] && r !== "dashboard");
    if (!pinned.length) pinned = DEFAULT_PINNED.slice();
    const tail = ["settings", "help"]; // 系统入口固定在抽屉尾部
    const rest = Object.keys(ROUTE_META).filter((r) => r !== "dashboard" && pinned.indexOf(r) === -1);
    const nav = document.getElementById("sideNav");
    if (nav) {
      nav.innerHTML =
        navLinkHtml("dashboard") +
        '<div class="nav-pin-sep" aria-hidden="true"></div>' +
        pinned.map(navLinkHtml).join("") +
        `<div class="nav-group" data-group="more">
          <button class="nav-parent" type="button" aria-expanded="false"><span class="nic"><svg class="ic"><use href="#i-more"/></svg></span><span class="np-label">全部功能</span><svg class="np-chev"><use href="#i-chev"/></svg></button>
          <div class="nav-sub"><div class="nav-sub-inner">${
            rest.filter((r) => tail.indexOf(r) === -1).map(navLinkHtml).join("") +
            tail.map(navLinkHtml).join("")
          }</div></div>
        </div>`;
    }
    // 移动端底栏：首页 + 置顶前 3 + 更多（更多面板静态含全部路由，无需重建）
    const tabNav = document.getElementById("tabNav");
    const moreBtn = document.getElementById("tabMoreBtn");
    if (tabNav && moreBtn) {
      tabNav.querySelectorAll("a[data-route]").forEach((a) => a.remove());
      ["dashboard"].concat(pinned.slice(0, 3)).forEach((r) => {
        const m = ROUTE_META[r];
        const a = document.createElement("a");
        a.href = "#/" + r;
        a.dataset.route = r;
        a.innerHTML = `<span class="nic"><svg class="ic"><use href="#${m.icon}"/></svg></span><span>${m.name}</span>${r === "news" ? '<span class="nav-badge" data-newsbadge hidden></span>' : ""}`;
        tabNav.insertBefore(a, moreBtn);
      });
    }
    // 「更多」按钮的高亮集合 = 不在底栏上的全部路由（MORE_ROUTES 原地更新保持引用）
    const inTabs = ["dashboard"].concat(pinned.slice(0, 3));
    MORE_ROUTES.length = 0;
    MORE_ROUTES.push(...Object.keys(ROUTE_META).filter((r) => inTabs.indexOf(r) === -1));
    // 重排后当前路由的高亮与分组展开态恢复
    const name = currentRoute();
    document.querySelectorAll("[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
    const activeSub = document.querySelector('.nav-sub a[data-route="' + name + '"]');
    if (activeSub) {
      const g = activeSub.closest(".nav-group");
      if (g && !g.classList.contains("open")) {
        g.classList.add("open");
        const p = g.querySelector(".nav-parent");
        if (p) p.setAttribute("aria-expanded", "true");
      }
    }
  }

  /** 定义侧边栏分组的展开/收起：点击父级标题切换 open 状态。
   *  委托绑定在 #sideNav 容器上——导航收敛会整体重排内部 DOM，委托不会失效。 */
  function initNavGroups() {
    restoreNavOpen();
    const nav = document.getElementById("sideNav");
    if (!nav) return;
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest(".nav-parent");
      if (!btn) return;
      const g = btn.closest(".nav-group");
      if (!g) return;
      const open = g.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      saveNavOpen();
    });
  }

  // 侧边栏分组展开状态持久化：记住用户手动展开/收起，刷新后保持
  function readNavOpen() {
    try { return JSON.parse(localStorage.getItem("wb2_nav_open") || "{}"); } catch (e) { return {}; }
  }
  function saveNavOpen() {
    const map = {};
    document.querySelectorAll(".nav-group").forEach((g) => {
      const key = g.getAttribute("data-group");
      if (key) map[key] = g.classList.contains("open");
    });
    try { localStorage.setItem("wb2_nav_open", JSON.stringify(map)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function restoreNavOpen() {
    const map = readNavOpen();
    document.querySelectorAll(".nav-group").forEach((g) => {
      const key = g.getAttribute("data-group");
      if (key && map[key]) {
        g.classList.add("open");
        const p = g.querySelector(".nav-parent");
        if (p) p.setAttribute("aria-expanded", "true");
      }
    });
  }

  /** 全局快捷键：N 快速新建任务，F 快速记账（输入框内不拦截，避免打字误触） */
  function initGlobalShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || !window.WB._booted) return;
      const tag = (e.target && e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        window.WB.jump.taskFocus = true;
        if (location.hash === "#/tasks") navigate(); else location.hash = "#/tasks";
      } else if (k === "f") {
        e.preventDefault();
        window.WB.jump.financeFocus = true;
        if (location.hash === "#/finance") navigate(); else location.hash = "#/finance";
      }
    });
  }

  // 移动端底栏「更多」面板容纳的低频路由（与 index.html 中 .more-grid 保持一致）
  const MORE_ROUTES = ["life", "calendar", "timeline", "achievements", "tracker", "time", "subs", "contacts", "reports", "stocks", "gongkao", "drive", "links", "settings", "help"];

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
