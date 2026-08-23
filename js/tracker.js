/* tracker.js — 自定义追踪器（P0）：让用户自己定义"我想长期记录什么"
 * - trackers：{id,name,icon,color,dtype,unit,freq,goalOp,goalVal,order,createdAt,updatedAt}
 *   dtype: count 计数 | number 数值 | duration 时长(分钟) | bool 是/否 | rating 评分1-5
 *   freq: daily/weekly/monthly；goalOp: le(不超过)/ge(达到)；goalVal: 目标值
 * - trackerlogs：{id,tid,date,value,note,createdAt}
 * - 联动：首页快速记录卡 / 全局搜索+快速录入 / 日历日详情 / 导入导出备份（ALL_STORES 自动覆盖）
 * - AI 建卡：自然语言 → 追踪器定义建议，用户确认后才创建（AI 不静默写数据）
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, uid, esc, todayStr, dateStr, flashInvalid, showToast, getSetting, setSetting, parseTags } = window.WB;

  const tDefRepo = () => repo("trackers");
  const tLogRepo = () => repo("trackerlogs");

  const DTYPES = {
    count: { label: "计数", hint: "如：喝咖啡 2 杯（可重复 +1 累加）" },
    number: { label: "数值", hint: "如：体重 75.4 kg" },
    duration: { label: "时长", hint: "按分钟记，如：阅读 35 分钟" },
    bool: { label: "是/否", hint: "如：今天是否运动" },
    rating: { label: "评分", hint: "1~5 分，如：今日心情" },
  };
  const FREQS = { daily: "每天", weekly: "每周", monthly: "每月" };

  // ---------- 统计工具 ----------
  function sumLogs(logs) { return logs.reduce((s, l) => s + Number(l.value || 0), 0); }
  function dayLogs(all, tid, ds) { return all.filter((l) => l.tid === tid && l.date === ds); }
  function logsBetween(all, tid, from, to) {
    return all.filter((l) => l.tid === tid && l.date >= from && l.date <= to);
  }
  /** 周期聚合值：count/number/duration=和，bool=完成天数，rating=均值 */
  function periodAgg(t, logs) {
    if (!logs.length) return 0;
    if (t.dtype === "bool") return logs.filter((l) => Number(l.value) > 0).length;
    if (t.dtype === "rating") return sumLogs(logs) / logs.length;
    return sumLogs(logs);
  }
  function fmtVal(t, v) {
    if (t.dtype === "duration") return v >= 60 ? (v / 60).toFixed(1).replace(/\.0$/, "") + " 小时" : Math.round(v) + " 分钟";
    if (t.dtype === "rating") return Number(v).toFixed(1) + " 分";
    if (t.dtype === "bool") return Number(v) > 0 ? "是" : "否";
    const n = Number(v);
    return (Number.isInteger(n) ? n : n.toFixed(1)) + (t.unit ? " " + t.unit : "");
  }
  /** 历史最长连续记录天数（有记录即算，bool 型要求 value>0） */
  function streakOf(t, all) {
    const days = new Set();
    all.forEach((l) => {
      if (l.tid !== t.id) return;
      if (t.dtype === "bool" && !(Number(l.value) > 0)) return;
      days.add(l.date);
    });
    const arr = Array.from(days).sort();
    let best = 0, run = 0, prev = "";
    arr.forEach((d) => {
      if (prev && Math.round((new Date(d + "T00:00:00") - new Date(prev + "T00:00:00")) / 86400000) === 1) run++;
      else run = 1;
      best = Math.max(best, run);
      prev = d;
    });
    return best;
  }
  function weekRangeStr() { const { weekRange } = window.WB; return weekRange(); }

  // ---------- 视图 ----------
  let editingId = null;
  let detailId = null;
  let chart = null;
  let range = 30;

  function defFormHtml(t) {
    const it = t || {};
    return `
      <div class="row">
        <input id="tkIcon" value="${esc(it.icon || "📊")}" maxlength="4" style="max-width:64px" title="图标（emoji）" />
        <input id="tkColor" type="color" value="${esc(it.color || "#c9956b")}" style="max-width:52px" title="颜色" />
        <input class="grow" id="tkName" placeholder="名称（如：喝咖啡 / 跑步 / 今日心情）" maxlength="20" value="${esc(it.name || "")}" />
        <select id="tkType">
          ${Object.keys(DTYPES).map((k) => `<option value="${k}" ${it.dtype === k ? "selected" : ""}>${DTYPES[k].label}</option>`).join("")}
        </select>
      </div>
      <div class="row sp-t-sm">
        <input id="tkUnit" placeholder="单位（杯/km/分钟…可空）" maxlength="10" style="max-width:150px" value="${esc(it.unit || "")}" />
        <select id="tkFreq">
          ${Object.keys(FREQS).map((k) => `<option value="${k}" ${it.freq === k ? "selected" : ""}>${FREQS[k]}</option>`).join("")}
        </select>
        <select id="tkGoalOp">
          <option value="ge" ${(it.goalOp || "ge") === "ge" ? "selected" : ""}>目标 ≥</option>
          <option value="le" ${it.goalOp === "le" ? "selected" : ""}>目标 ≤</option>
        </select>
        <input id="tkGoalVal" type="number" step="0.1" min="0" placeholder="目标值" style="max-width:110px" value="${it.goalVal !== undefined ? esc(it.goalVal) : ""}" />
        <button class="btn in-card-btn" id="tkSave">${it.id ? "保存修改" : "创建"}</button>
        ${it.id ? '<button class="btn ghost" id="tkCancel">取消</button>' : ""}
      </div>
      <div class="s-desc sp-t-sm" id="tkTypeHint">${DTYPES[it.dtype || "count"].hint} · 目标留空表示暂不设目标</div>`;
  }

  function quickLogControl(t, today) {
    const logs = t._logs || [];
    const todaySum = sumLogs(logs.filter((l) => l.date === today));
    if (t.dtype === "count") {
      return `<div class="tk-quick">
        <button class="btn sm" data-tkadd="${t.id}" data-v="1">＋1 ${esc(t.unit || "")}</button>
        <input type="number" min="0" step="1" placeholder="数量" class="w-90" data-tknum="${t.id}" />
        <button class="btn sm ghost" data-tknumgo="${t.id}">记</button>
      </div>`;
    }
    if (t.dtype === "bool") {
      const on = logs.some((l) => l.date === today && Number(l.value) > 0);
      return `<button class="btn sm ${on ? "ghost" : ""}" data-tkbool="${t.id}">${on ? "✓ 今天已记录" : "记录今天"}</button>`;
    }
    if (t.dtype === "rating") {
      return `<div class="tk-quick">${[1, 2, 3, 4, 5].map((n) => `<button class="btn sm ghost" data-tkrate="${t.id}" data-v="${n}">${n}</button>`).join("")}</div>`;
    }
    return `<div class="tk-quick">
      <input type="number" step="0.1" placeholder="数值${t.dtype === "duration" ? "（分钟）" : ""}" class="w-110" data-tknum="${t.id}" />
      <button class="btn sm ghost" data-tknumgo="${t.id}">记录</button>
      <span class="s-desc">今日 ${todaySum ? esc(fmtVal(t, t.dtype === "number" ? todaySum : todaySum)) : "—"}</span>
    </div>`;
  }

  function cardHtml(t, today, week) {
    const logs = t._logs || [];
    const todayLogs = logs.filter((l) => l.date === today);
    const wk = logsBetween(logs, t.id, week[0], today);
    const mo = logsBetween(logs, t.id, today.slice(0, 7) + "-01", today);
    const todayAgg = t.dtype === "bool" ? (todayLogs.some((l) => Number(l.value) > 0) ? 1 : 0) : periodAgg(t, todayLogs);
    // 目标进度：按 freq 的窗口聚合
    let goalTxt = "", goalPct = -1;
    if (t.goalVal && Number(t.goalVal) > 0) {
      const win = t.freq === "daily" ? todayLogs : t.freq === "weekly" ? wk : mo;
      const agg = periodAgg(t, win);
      const goal = Number(t.goalVal);
      const ok = t.goalOp === "le" ? agg <= goal : agg >= goal;
      goalPct = t.goalOp === "le" ? Math.min(100, Math.round((goal ? agg / goal : 0) * 100)) : Math.min(100, Math.round((agg / goal) * 100));
      goalTxt = `${t.goalOp === "le" ? "≤" : "≥"} ${fmtVal(t, goal)} · ${ok ? "✓ 达标" : goalPct + "%"}`;
    }
    const streak = streakOf(t, logs);
    return `
      <div class="tk-card" style="--tc:${esc(t.color || "#c9956b")}">
        <div class="tk-head">
          <span class="tk-ic">${esc(t.icon || "📊")}</span>
          <b class="tk-name" data-tkdetail="${t.id}" title="查看趋势与记录">${esc(t.name)}</b>
          <span class="tk-type">${DTYPES[t.dtype] ? DTYPES[t.dtype].label : ""}</span>
        </div>
        <div class="tk-today">${todayLogs.length || t.dtype === "bool" ? esc(fmtVal(t, t.dtype === "rating" ? todayAgg : (t.dtype === "count" || t.dtype === "duration" ? todayAgg : (todayLogs.length ? todayLogs[todayLogs.length - 1].value : 0)))) : "今天还没记"}<small>今日</small></div>
        ${quickLogControl(t, today)}
        <div class="tk-stats">
          <span>本周 ${esc(fmtVal(t, periodAgg(t, t.dtype === "bool" ? wk.filter((l) => Number(l.value) > 0) : wk)))}</span>
          <span>本月 ${esc(fmtVal(t, periodAgg(t, t.dtype === "bool" ? mo.filter((l) => Number(l.value) > 0) : mo)))}</span>
          <span>连续 ${streak} 天</span>
        </div>
        ${goalPct >= 0 ? `<div class="tk-goal"><div class="ach-bar"><i style="width:${goalPct}%"></i></div><span>${esc(goalTxt)}</span></div>` : ""}
      </div>`;
  }

  function detailHtml(t, all) {
    const logs = all.filter((l) => l.tid === t.id).sort((a, b) => b.date.localeCompare(a.date));
    const ranges = [7, 30, 90, 365];
    const days = [];
    const today = todayStr();
    for (let i = range - 1; i >= 0; i--) days.push(dateStr(new Date(new Date(today + "T00:00:00").getTime() - i * 86400000)));
    // 90 天热力图（独立于趋势图的 range，固定取 90 天）
    let heat = "";
    const hmDays = [];
    for (let i = 89; i >= 0; i--) hmDays.push(dateStr(new Date(new Date(today + "T00:00:00").getTime() - i * 86400000)));
    const vals = hmDays.map((d) => {
      const dl = logs.filter((l) => l.date === d);
      return periodAgg(t, dl);
    });
    const max = Math.max(1, ...vals);
    heat = `<div class="tk-heat">` + hmDays.map((d, i) => {
      const v = vals[i];
      const intensity = v ? 0.25 + 0.75 * Math.min(1, v / max) : 0;
      return `<i title="${d}：${v ? esc(fmtVal(t, v)) : "无记录"}" style="background:${v ? `color-mix(in srgb, ${esc(t.color || "#c9956b")} ${Math.round(intensity * 100)}%, transparent)` : "var(--line)"}"></i>`;
    }).join("") + `</div>`;
    return `
      <div class="card" id="tkDetailCard">
        <h2>${esc(t.icon || "📊")} ${esc(t.name)}<span class="count">${DTYPES[t.dtype] ? DTYPES[t.dtype].label : ""}${t.unit ? " · " + esc(t.unit) : ""}</span></h2>
        <div class="row sp-b-sm">
          <div class="tabs">
            ${ranges.map((r) => `<button class="tab ${r === range ? "on" : ""}" data-tkrange="${r}">${r}天</button>`).join("")}
          </div>
          <div>
            <button class="btn ghost sm" data-tkedit="${t.id}">编辑</button>
            <button class="btn danger sm" data-tkdel="${t.id}">删除追踪器</button>
            <button class="btn ghost sm" data-tkclose="1">收起</button>
          </div>
        </div>
        <div class="chart-box"><canvas id="tkChart" height="160"></canvas></div>
        <div class="tk-heat-title">近 90 天热力图</div>
        ${heat}
        <div class="sp-t-md">
          <h3 style="font-size: 13px;margin-bottom:6px">历史记录（最近 20 条）</h3>
          ${logs.length ? logs.slice(0, 20).map((l) => `
            <div class="set-row">
              <span class="s-name">${esc(l.date)}</span>
              <span class="s-desc">${esc(fmtVal(t, l.value))}${l.note ? " · " + esc(l.note) : ""}</span>
              <button class="btn danger sm" data-tklogdel="${l.id}">删</button>
            </div>`).join("")
          : '<div class="empty">还没有记录</div>'}
        </div>
      </div>`;
  }

  function renderChart(t, logs) {
    const cvs = document.getElementById("tkChart");
    if (!cvs || !window.Chart) return;
    if (chart) { try { chart.destroy(); } catch (e) {} chart = null; }
    const today = todayStr();
    const days = [], vals = [];
    for (let i = range - 1; i >= 0; i--) days.push(dateStr(new Date(new Date(today + "T00:00:00").getTime() - i * 86400000)));
    days.forEach((d) => vals.push(periodAgg(t, logs.filter((l) => l.date === d))));
    const isBar = t.dtype === "bool" || t.dtype === "rating";
    chart = new Chart(cvs, {
      type: isBar ? "bar" : "line",
      data: {
        labels: days.map((d) => d.slice(5)),
        datasets: [{
          label: t.name,
          data: vals,
          backgroundColor: isBar ? (t.color || "#c9956b") + "aa" : (t.color || "#c9956b") + "22",
          borderColor: t.color || "#c9956b",
          fill: !isBar,
          tension: 0.3,
          pointRadius: range > 90 ? 0 : 2,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: t.dtype === "rating" ? { min: 0, max: 5, ticks: { stepSize: 1 } } : { beginAtZero: true },
          x: { ticks: { maxTicksLimit: 10 } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  routes.tracker = {
    title: "追踪",
    async render(el) {
      const today = todayStr();
      const [defs, allLogs] = await Promise.all([tDefRepo().list().catch(() => []), tLogRepo().list().catch(() => [])]);
      if (location.hash !== "#/tracker") return;
      const week = weekRangeStr();
      const list = (defs || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || "").localeCompare(b.createdAt || ""));
      list.forEach((t) => { t._logs = allLogs.filter((l) => l.tid === t.id); });
      const editing = editingId ? list.find((t) => t.id === editingId) : null;
      const detail = detailId ? list.find((t) => t.id === detailId) : null;

      el.innerHTML = `
        <div class="card">
          <h2>${editing ? "编辑追踪器" : "创建追踪器"}<span class="count">我想长期记录什么？</span></h2>
          ${defFormHtml(editing)}
          <div class="row sp-t-sm">
            <input class="grow" id="tkAiInput" placeholder="🤖 让 AI 建卡：如「每天喝咖啡不超过 2 杯」「每周跑步 20 公里」" maxlength="60" />
            <button class="btn sm" id="tkAiBtn">AI 建议</button>
          </div>
          <div id="tkAiBox" class="sp-t-sm"></div>
        </div>
        <div class="card">
          <h2>我的追踪器<span class="count">${list.length} 个</span></h2>
          ${list.length ? `<div class="tk-grid">${list.map((t) => cardHtml(t, today, week)).join("")}</div>` : '<div class="empty">还没有追踪器。喝咖啡、喝水、跑步、体重、心情……上面创建一个开始长期记录</div>'}
        </div>
        ${detail ? detailHtml(detail, allLogs) : ""}
        <div class="footnote">追踪器数据随全量导出/导入与 WebDAV 云备份一起走；也可在首页直接快速记录、全局搜索里录入。</div>`;

      const $$ = (s) => el.querySelector(s);
      // ---- 表单 ----
      $$("#tkType").addEventListener("change", (e) => {
        $$("#tkTypeHint").textContent = DTYPES[e.target.value].hint + " · 目标留空表示暂不设目标";
      });
      let tkSaving = false; // 锁防双击重复创建/保存追踪器
      $$("#tkSave").addEventListener("click", async () => {
        if (tkSaving) return;
        const nameInput = $$("#tkName");
        const name = nameInput.value.trim();
        if (!name) return flashInvalid(nameInput);
        const base = editingId ? list.find((x) => x.id === editingId) : null;
        tkSaving = true;
        try {
          await tDefRepo().put({
            id: base ? base.id : uid(),
            name,
            icon: $$("#tkIcon").value.trim() || "📊",
            color: $$("#tkColor").value,
            dtype: $$("#tkType").value,
            unit: $$("#tkUnit").value.trim(),
            freq: $$("#tkFreq").value,
            goalOp: $$("#tkGoalOp").value,
            goalVal: Number($$("#tkGoalVal").value) || 0,
            order: (base && base.order) || (defs.length || 0) + 1,
            createdAt: (base && base.createdAt) || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        } finally { tkSaving = false; }
        showToast(editingId ? "已保存" : "已创建", "ok");
        editingId = null;
        routes.tracker.render(el);
      });
      const cancelBtn = $$("#tkCancel");
      if (cancelBtn) cancelBtn.addEventListener("click", () => { editingId = null; routes.tracker.render(el); });

      // ---- AI 建卡（只建议，确认后创建）----
      const aiBtn = $$("#tkAiBtn");
      aiBtn.addEventListener("click", async () => {
        const input = $$("#tkAiInput");
        const q = input.value.trim();
        if (!q) return flashInvalid(input);
        const box = $$("#tkAiBox");
        box.innerHTML = '<div class="ai-loading">AI 正在分析…</div>';
        aiBtn.disabled = true; // 请求期间防重复点击
        try {
          const sys = '你是追踪器配置助手。根据用户描述返回 JSON：{"name":"短名称","dtype":"count|number|duration|bool|rating","unit":"单位或空","freq":"daily|weekly|monthly","goalOp":"ge|le","goalVal":数字,"icon":"一个emoji"}。goalVal 不确定时给合理默认值。只返回 JSON。';
          const text = await window.WB.ai.chat(sys, "用户想追踪：" + q, 0.3);
          const obj = window.WB.ai.parseJson(text);
          if (!obj || !obj.name || !DTYPES[obj.dtype]) throw new Error("建议格式异常，请换个说法");
          box.innerHTML = `<div class="ai-panel">
            <b>AI 建议：</b>${esc(obj.icon || "📊")} <b>${esc(obj.name)}</b> · ${DTYPES[obj.dtype].label}${obj.unit ? " · " + esc(obj.unit) : ""} · ${FREQS[obj.freq] || "每天"}目标 ${obj.goalOp === "le" ? "≤" : "≥"} ${esc(obj.goalVal)}
            <div class="row sp-t-sm"><button class="btn sm" id="tkAiOk">按这个创建</button><button class="btn ghost sm" id="tkAiNo">不要了</button></div>
          </div>`;
          $$("#tkAiOk").addEventListener("click", async () => {
            await tDefRepo().put({
              id: uid(), name: String(obj.name).slice(0, 20), icon: String(obj.icon || "📊").slice(0, 4),
              color: "#c9956b", dtype: obj.dtype, unit: String(obj.unit || "").slice(0, 10),
              freq: FREQS[obj.freq] ? obj.freq : "daily", goalOp: obj.goalOp === "le" ? "le" : "ge",
              goalVal: Number(obj.goalVal) || 0, order: (defs.length || 0) + 1,
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            });
            showToast("已按 AI 建议创建", "ok");
            routes.tracker.render(el);
          });
          $$("#tkAiNo").addEventListener("click", () => { box.innerHTML = ""; });
        } catch (e) {
          box.innerHTML = `<div class="empty" style="color:var(--danger)">AI 建议失败：${esc(e.message)}</div>`;
        } finally {
          aiBtn.disabled = false;
        }
      });

      // ---- 快速记录（事件委托，单例绑定；数据挂 el 上避免闭包过期）----
      el._tkCtx = { list, allLogs };
      if (!el._tkClickBound) {
        el._tkClickBound = true;
        el.addEventListener("click", async (e) => {
          if (location.hash !== "#/tracker") return; // 防跨路由劫持
          const ctx = el._tkCtx || {};
          const add = e.target.closest("[data-tkadd]");
          const numGo = e.target.closest("[data-tknumgo]");
          const bool = e.target.closest("[data-tkbool]");
          const rate = e.target.closest("[data-tkrate]");
          try {
            if (add) {
              await tLogRepo().put({ id: uid(), tid: add.dataset.tkadd, date: todayStr(), value: Number(add.dataset.v) || 1, note: "", createdAt: new Date().toISOString() });
              showToast("已记录", "ok");
              routes.tracker.render(el);
            } else if (numGo) {
              const input = el.querySelector(`[data-tknum="${numGo.dataset.tknumgo}"]`);
              const v = Number(input.value);
              if (!input.value || isNaN(v) || v <= 0) return flashInvalid(input);
              await tLogRepo().put({ id: uid(), tid: numGo.dataset.tknumgo, date: todayStr(), value: v, note: "", createdAt: new Date().toISOString() });
              showToast("已记录", "ok");
              routes.tracker.render(el);
            } else if (bool) {
              const t = (ctx.list || []).find((x) => x.id === bool.dataset.tkbool);
              if (!t) return;
              const has = (t._logs || []).some((l) => l.date === todayStr() && Number(l.value) > 0);
              await tLogRepo().put({ id: uid(), tid: t.id, date: todayStr(), value: has ? 0 : 1, note: "", createdAt: new Date().toISOString() });
              showToast(has ? "已取消今天" : "已记录", "ok");
              routes.tracker.render(el);
            } else if (rate) {
              await tLogRepo().put({ id: uid(), tid: rate.dataset.tkrate, date: todayStr(), value: Number(rate.dataset.v), note: "", createdAt: new Date().toISOString() });
              showToast("已记录 " + rate.dataset.v + " 分", "ok");
              routes.tracker.render(el);
            }
          } catch (err) {
            showToast("记录失败：" + err.message, "error");
          }
        });
        el.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || location.hash !== "#/tracker") return;
          if (e.target.dataset && e.target.dataset.tknum !== undefined) {
            const go = el.querySelector(`[data-tknumgo="${e.target.dataset.tknum}"]`);
            if (go) go.click();
          }
        });
      }

      // ---- 卡片/详情操作 ----
      el.querySelectorAll("[data-tkdetail]").forEach((n) =>
        n.addEventListener("click", () => { detailId = n.dataset.tkdetail; routes.tracker.render(el); })
      );
      el.querySelectorAll("[data-tkedit]").forEach((b) =>
        b.addEventListener("click", () => { editingId = b.dataset.tkedit; detailId = null; routes.tracker.render(el); window.scrollTo({ top: 0, behavior: "smooth" }); })
      );
      el.querySelectorAll("[data-tkclose]").forEach((b) =>
        b.addEventListener("click", () => { detailId = null; routes.tracker.render(el); })
      );
      el.querySelectorAll("[data-tkdel]").forEach((b) =>
        b.addEventListener("click", async () => {
          const t = list.find((x) => x.id === b.dataset.tkdel);
          if (!confirm(`删除追踪器「${t ? t.name : ""}」及其全部记录？`)) return;
          await tDefRepo().delete(b.dataset.tkdel);
          for (const l of (allLogs || []).filter((x) => x.tid === b.dataset.tkdel)) await tLogRepo().delete(l.id);
          detailId = null;
          showToast("已删除", "info");
          routes.tracker.render(el);
        })
      );
      el.querySelectorAll("[data-tklogdel]").forEach((b) =>
        b.addEventListener("click", async () => {
          await tLogRepo().delete(b.dataset.tklogdel);
          routes.tracker.render(el);
        })
      );
      el.querySelectorAll("[data-tkrange]").forEach((b) =>
        b.addEventListener("click", () => {
          range = Number(b.dataset.tkrange);
          routes.tracker.render(el);
        })
      );

      // 详情图表
      if (detail) renderChart(detail, allLogs);
    },
  };

  /** 供首页/搜索快速录入：直接写一条记录（不校验存在性，调用方保证） */
  async function quickLog(tid, value, dateOverride) {
    await tLogRepo().put({ id: uid(), tid, date: dateOverride || todayStr(), value: Number(value) || 0, note: "", createdAt: new Date().toISOString() });
  }

  window.WB.tracker = { quickLog, DTYPES, streakOf, periodAgg, fmtVal };
})();
