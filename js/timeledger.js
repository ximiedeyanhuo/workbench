/* timeledger.js — 时间账本（P0）：记录"我实际把时间花在哪了"
 * - timeentries：{id,date,start,end,minutes,category,tags,note,taskId,createdAt}
 *   start/end 形如 "09:00"/"10:20"（手动补录），计时器写入时为实际时刻
 * - 计时器状态存 localStorage（wb2_time_timer），刷新/换页不丢；页面 interval 在离开路由时清理
 * - 分类：工作/学习/投资/家庭/健康/娱乐/资讯/其他 + 自定义（settings.timeCats）
 * - 番茄钟联动：focus.js 完成一次专注后调 WB.timeledger.logFocus()（settings.timeAutoLog 开关，默认开）
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, uid, esc, todayStr, flashInvalid, showToast, getSetting, setSetting, parseTags } = window.WB;

  const teRepo = () => repo("timeentries");
  const TIMER_KEY = "wb2_time_timer";

  const CATS = [
    { k: "work", name: "工作", color: "#5b8db8" },
    { k: "study", name: "学习", color: "#8a7ab5" },
    { k: "invest", name: "投资", color: "#c9956b" },
    { k: "family", name: "家庭", color: "#c98b95" },
    { k: "health", name: "健康", color: "#5a9e6f" },
    { k: "fun", name: "娱乐", color: "#d4a05a" },
    { k: "news", name: "资讯", color: "#7aa5a0" },
    { k: "other", name: "其他", color: "#9a9a92" },
  ];
  const catOf = (k, customs) => CATS.find((c) => c.k === k) || (customs || []).find((c) => c.k === k) || { k: "other", name: "其他", color: "#9a9a92" };

  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtHm = (mins) => (mins >= 60 ? Math.floor(mins / 60) + "h" + (mins % 60 ? (mins % 60) + "m" : "") : Math.round(mins) + "m");
  const nowHm = () => { const d = new Date(); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };

  // ---------- 计时器 ----------
  function readTimer() {
    try { return JSON.parse(localStorage.getItem(TIMER_KEY) || "null"); } catch (e) { return null; }
  }
  function writeTimer(t) {
    try {
      if (t) localStorage.setItem(TIMER_KEY, JSON.stringify(t));
      else localStorage.removeItem(TIMER_KEY);
    } catch (e) { /* 隐私模式忽略 */ }
  }

  let tickTimer = null;
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

  // ---------- 视图 ----------
  let editingId = null;
  let statRange = "today"; // today | week | month
  let chart = null, pie = null;

  function entryRow(e, customs, tasksById) {
    const c = catOf(e.category, customs);
    const task = e.taskId && tasksById[e.taskId] ? " · 📌 " + esc(tasksById[e.taskId].title) : "";
    return `<div class="set-row">
      <span class="s-name" style="min-width:86px">${esc(e.start || "")}${e.end ? "–" + esc(e.end) : "起"}</span>
      <span class="tk-cat-dot" style="background:${c.color}"></span>
      <span class="s-desc grow">${esc(c.name)}${task}${e.note ? " · " + esc(e.note) : ""}${(e.tags || []).map((t) => ` <span class="tag">${esc(t)}</span>`).join("")}</span>
      <b style="font-size:13px">${fmtHm(e.minutes)}</b>
      <button class="btn ghost sm" data-teedit="${e.id}">改</button>
      <button class="btn danger sm" data-tedel="${e.id}">删</button>
    </div>`;
  }

  function formHtml(e, customs, tasks) {
    const it = e || { date: todayStr(), start: nowHm() };
    return `
      <div class="row">
        <input type="date" id="teDate" value="${esc(it.date || todayStr())}" style="max-width:150px" />
        <input id="teStart" placeholder="起 09:00" maxlength="5" style="max-width:90px" value="${esc(it.start || "")}" />
        <input id="teEnd" placeholder="止 10:20" maxlength="5" style="max-width:90px" value="${esc(it.end || "")}" />
        <select id="teCat">
          ${CATS.concat(customs || []).map((c) => `<option value="${esc(c.k)}" ${it.category === c.k ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select>
        <input type="number" min="1" step="1" placeholder="或直接填分钟" style="max-width:120px" id="teMins" value="${it.minutes ? esc(it.minutes) : ""}" title="起止都填了则自动计算，此项可留空" />
        <input class="grow" id="teNote" placeholder="做了什么（可选）" maxlength="50" value="${esc(it.note || "")}" />
      </div>
      <div class="row sp-t-sm">
        <select id="teTask">
          <option value="">不关联任务</option>
          ${tasks.filter((t) => !t.done).slice(0, 60).map((t) => `<option value="${t.id}" ${it.taskId === t.id ? "selected" : ""}>${esc(t.title)}</option>`).join("")}
        </select>
        <input id="teTags" placeholder="标签（逗号分隔，可选）" maxlength="40" style="max-width:180px" value="${esc((it.tags || []).join(","))}" />
        <button class="btn in-card-btn" id="teSave">${it.id ? "保存" : "记一笔时间"}</button>
        ${it.id ? '<button class="btn ghost" id="teCancel">取消</button>' : ""}
      </div>`;
  }

  function statCatRows(entries, customs) {
    const by = {};
    entries.forEach((e) => { by[e.category] = (by[e.category] || 0) + Number(e.minutes || 0); });
    const rows = Object.keys(by).map((k) => ({ ...catOf(k, customs), mins: by[k] })).sort((a, b) => b.mins - a.mins);
    const total = rows.reduce((s, r) => s + r.mins, 0);
    return { rows, total };
  }

  routes.time = {
    title: "时间账本",
    async render(el) {
      const today = todayStr();
      const [entries, customs, autoLog, tasks] = await Promise.all([
        teRepo().list().catch(() => []),
        getSetting("timeCats", []),
        getSetting("timeAutoLog", true),
        repo("tasks").list().catch(() => []),
      ]);
      if (location.hash !== "#/time") return;
      const list = (entries || []).slice().sort((a, b) => (b.date + (b.start || "")).localeCompare(a.date + (a.start || "")));
      const tasksById = {};
      (tasks || []).forEach((t) => { tasksById[t.id] = t; });
      const editing = editingId ? list.find((e) => e.id === editingId) : null;
      const timer = readTimer();

      // 统计窗口
      const { weekRange } = window.WB;
      const [mon] = weekRange();
      const rangeFrom = statRange === "today" ? today : statRange === "week" ? mon : today.slice(0, 7) + "-01";
      const inRange = list.filter((e) => e.date >= rangeFrom && e.date <= today);
      const stat = statCatRows(inRange, customs);
      const todayStat = statCatRows(list.filter((e) => e.date === today), customs);
      const todayEntries = list.filter((e) => e.date === today);

      // 月度趋势（按日堆叠省略，画每日总分钟）
      const trendDays = [];
      for (let i = 29; i >= 0; i--) trendDays.push(window.WB.dateStr(new Date(new Date(today + "T00:00:00").getTime() - i * 86400000)));
      const trendVals = trendDays.map((d) => list.filter((e) => e.date === d).reduce((s, e) => s + Number(e.minutes || 0), 0));

      el.innerHTML = `
        <div class="card">
          <h2>时间账本<span class="count">时间花在哪了</span></h2>
          <div class="te-timer ${timer ? "on" : ""}" id="teTimerBox">
            ${timer
              ? `<div class="te-timer-in">
                   <span class="te-timer-dot"></span>
                   <b id="teElapsed">${fmtHm((Date.now() - timer.startAt) / 60000)}</b>
                   <span class="s-desc">${esc(catOf(timer.category, customs).name)}${timer.note ? " · " + esc(timer.note) : ""} · 自 ${new Date(timer.startAt).toTimeString().slice(0, 5)}</span>
                   <button class="btn sm" id="teStop">■ 停止并记录</button>
                   <button class="btn ghost sm" id="teDiscard">放弃</button>
                 </div>`
              : `<div class="row">
                   <select id="teTmCat">${CATS.concat(customs || []).map((c) => `<option value="${esc(c.k)}">${esc(c.name)}</option>`).join("")}</select>
                   <input class="grow" id="teTmNote" placeholder="正在做什么（可选）" maxlength="50" />
                   <button class="btn in-card-btn" id="teStartBtn">▶ 开始计时</button>
                 </div>`}
          </div>
          ${formHtml(editing, customs, tasks || [])}
        </div>
        <div class="card">
          <h2>今日<span class="count">${fmtHm(todayStat.total)} · ${todayEntries.length} 段</span></h2>
          ${todayEntries.length ? todayEntries.map((e) => entryRow(e, customs, tasksById)).join("") : '<div class="empty">今天还没有时间记录</div>'}
        </div>
        <div class="card">
          <h2>统计
            <span class="count">${statRange === "today" ? "今日" : statRange === "week" ? "本周" : "本月"} ${fmtHm(stat.total)}</span>
          </h2>
          <div class="tabs sp-b-md">
            ${[["today", "今日"], ["week", "本周"], ["month", "本月"]].map(([k, lab]) => `<button class="tab ${statRange === k ? "on" : ""}" data-terange="${k}">${lab}</button>`).join("")}
          </div>
          ${stat.rows.length ? stat.rows.map((r) => `
            <div class="set-row">
              <span class="tk-cat-dot" style="background:${r.color}"></span>
              <span class="s-name">${esc(r.name)}</span>
              <div class="grow" style="min-width:80px"><div class="ach-bar"><i style="width:${stat.total ? Math.round((r.mins / stat.total) * 100) : 0}%"></i></div></div>
              <b style="font-size:13px;min-width:56px;text-align:right">${fmtHm(r.mins)}</b>
              <span class="s-desc" style="min-width:40px;text-align:right">${stat.total ? Math.round((r.mins / stat.total) * 100) : 0}%</span>
            </div>`).join("") : '<div class="empty">所选范围内没有记录</div>'}
          <div class="chart-box sp-t-md"><div class="chart-tt">近 30 天每日记录时长（分钟）</div><canvas id="teTrend" height="130"></canvas></div>
        </div>
        <div class="card">
          <h2>历史记录<span class="count">${list.length} 条</span></h2>
          ${list.slice(0, 50).map((e) => entryRow(e, customs, tasksById)).join("") || '<div class="empty">还没有记录</div>'}
        </div>
        <div class="card">
          <h2>设置</h2>
          <div class="set-row">
            <span class="s-name">番茄钟自动入账</span>
            <label class="an-yearly"><input type="checkbox" id="teAutoLog" ${autoLog ? "checked" : ""} /> 专注完成自动写一条时间记录</label>
          </div>
          <div class="set-row">
            <span class="s-name">自定义分类</span>
            <input class="grow" id="teNewCat" placeholder="新分类名（回车添加）" maxlength="10" />
          </div>
          ${(customs || []).length ? `<div class="set-row"><span class="s-desc">已有：${customs.map((c) => `<span class="tag" data-tedelcat="${c.k}" style="cursor:pointer" title="点击删除">${esc(c.name)} ✕</span>`).join(" ")}</span></div>` : ""}
          <div class="footnote">时间账本数据随全量导出/导入与云备份一起走。</div>
        </div>`;

      const $$ = (s) => el.querySelector(s);

      // ---- 计时器 ----
      const startBtn = $$("#teStartBtn");
      if (startBtn) startBtn.addEventListener("click", () => {
        writeTimer({ startAt: Date.now(), category: $$("#teTmCat").value, note: $$("#teTmNote").value.trim() });
        routes.time.render(el);
      });
      const stopBtn = $$("#teStop");
      if (stopBtn) stopBtn.addEventListener("click", async () => {
        const tm = readTimer();
        if (!tm) return;
        const mins = Math.max(1, Math.round((Date.now() - tm.startAt) / 60000));
        writeTimer(null);
        await teRepo().put({
          id: uid(), date: todayStr(),
          start: new Date(tm.startAt).toTimeString().slice(0, 5), end: nowHm(),
          minutes: mins, category: tm.category, tags: [], note: tm.note, taskId: "", createdAt: new Date().toISOString(),
        });
        showToast("已记录 " + fmtHm(mins), "ok");
        routes.time.render(el);
      });
      const discardBtn = $$("#teDiscard");
      if (discardBtn) discardBtn.addEventListener("click", () => {
        if (!confirm("放弃当前计时？")) return;
        writeTimer(null);
        routes.time.render(el);
      });
      // 计时器跳动（离开路由必须清理）
      stopTick();
      if (timer) {
        tickTimer = setInterval(() => {
          if (location.hash !== "#/time") return stopTick();
          const el2 = document.getElementById("teElapsed");
          if (el2 && readTimer()) el2.textContent = fmtHm((Date.now() - readTimer().startAt) / 60000);
        }, 1000);
      }

      // ---- 表单 ----
      let teSaveBusy = false; // 锁防双击/双 Enter 重复记录
      $$("#teSave").addEventListener("click", async () => {
        if (teSaveBusy) return;
        const date = $$("#teDate").value;
        const start = $$("#teStart").value.trim();
        const end = $$("#teEnd").value.trim();
        let mins = Number($$("#teMins").value);
        if (!date) return flashInvalid($$("#teDate"));
        const toMin = (s) => { const m = s.match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
        if (!mins || mins <= 0) {
          const a = toMin(start), b = toMin(end);
          if (isNaN(a) || isNaN(b) || b <= a) { flashInvalid($$("#teMins")); return showToast("请填分钟数，或把起止时间填完整（止 > 起）", "warning"); }
          mins = b - a;
        }
        const base = editingId ? list.find((x) => x.id === editingId) : null;
        teSaveBusy = true;
        try {
          await teRepo().put({
            id: base ? base.id : uid(),
            date, start, end,
            minutes: Math.round(mins),
            category: $$("#teCat").value,
            tags: parseTags($$("#teTags").value),
            note: $$("#teNote").value.trim(),
            taskId: $$("#teTask").value || "",
            createdAt: (base && base.createdAt) || new Date().toISOString(),
          });
        } finally { teSaveBusy = false; }
        showToast("已记录 " + fmtHm(mins), "ok");
        editingId = null;
        routes.time.render(el);
      });
      const teCancel = $$("#teCancel");
      if (teCancel) teCancel.addEventListener("click", () => { editingId = null; routes.time.render(el); });

      // ---- 列表操作 ----
      el.querySelectorAll("[data-teedit]").forEach((b) =>
        b.addEventListener("click", () => { editingId = b.dataset.teedit; routes.time.render(el); window.scrollTo({ top: 0, behavior: "smooth" }); })
      );
      el.querySelectorAll("[data-tedel]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("删除这条时间记录？")) return;
          await teRepo().delete(b.dataset.tedel);
          routes.time.render(el);
        })
      );
      el.querySelectorAll("[data-terange]").forEach((b) =>
        b.addEventListener("click", () => { statRange = b.dataset.terange; routes.time.render(el); })
      );

      // ---- 设置 ----
      $$("#teAutoLog").addEventListener("change", async (e) => {
        await setSetting("timeAutoLog", e.target.checked);
        showToast(e.target.checked ? "番茄钟完成后将自动入账" : "已关闭自动入账", "info");
      });
      const newCat = $$("#teNewCat");
      newCat.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        const name = newCat.value.trim();
        if (!name) return;
        const k = "c_" + Date.now().toString(36);
        const cs = (await getSetting("timeCats", [])) || [];
        cs.push({ k, name, color: "#7f8c8d" });
        await setSetting("timeCats", cs);
        showToast("分类已添加", "ok");
        routes.time.render(el);
      });
      el.querySelectorAll("[data-tedelcat]").forEach((n) =>
        n.addEventListener("click", async () => {
          const cs = ((await getSetting("timeCats", [])) || []).filter((c) => c.k !== n.dataset.tedelcat);
          await setSetting("timeCats", cs);
          routes.time.render(el);
        })
      );

      // ---- 趋势图 ----
      const cvs = $$("#teTrend");
      if (cvs && window.Chart) {
        if (chart) { try { chart.destroy(); } catch (e) {} }
        chart = new Chart(cvs, {
          type: "bar",
          data: {
            labels: trendDays.map((d) => d.slice(5)),
            datasets: [{ label: "分钟", data: trendVals, backgroundColor: "#c9956b99", borderRadius: 2 }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } },
          },
        });
      }
    },
  };

  /** 番茄钟完成回调（focus.js 调用）：写一条“工作·专注”记录（开关 settings.timeAutoLog） */
  async function logFocus(mins, type) {
    try {
      if (!((await getSetting("timeAutoLog", true)))) return;
      await teRepo().put({
        id: uid(), date: todayStr(), start: "", end: nowHm(),
        minutes: Math.max(1, Math.round(mins)), category: "work", tags: [],
        note: "🍅 番茄钟专注 " + Math.round(mins) + " 分钟" + (type === "short" ? "（短休）" : type === "long" ? "（长休）" : ""),
        taskId: "", createdAt: new Date().toISOString(),
      });
    } catch (e) { /* 不阻塞番茄钟 */ }
  }

  window.WB.timeledger = { logFocus };
})();
