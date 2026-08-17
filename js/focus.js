/* focus.js — 番茄钟（专注计时器）
 * 全局浮窗：右下角悬浮按钮 + 弹层；统计今日专注分钟数，写 settings.focusLog[YYYY-MM-DD]
 * 设计：与现有 SPA 兼容（pushState 浮层、openOverlay/closeOverlay），不依赖任何 UI 框架。
 * 状态：FSM 走 idle → running → paused → finished；不阻塞用户切路由（切走时计时继续，切回仍可见）。
 */
(function () {
  if (!window.WB) return;
  const { openOverlay, closeOverlay, getSetting, setSetting, esc, icon } = window.WB;
  const todayStr = () => window.WB.dateStr(new Date());

  // 持久化键：focusLog = { "2026-08-10": [{ start, end, type, mins }] }
  // type: "focus"（25 分钟）/ "short"（5 分钟）/ "long"（15 分钟）；每日 focus 满 4 段自动建议 long
  const FOCUS_MIN = 25, SHORT_MIN = 5, LONG_MIN = 15, LONG_EVERY = 4;

  // 运行时状态（跨路由保留）
  const state = {
    phase: "idle",   // idle | running | paused
    type: "focus",   // focus | short | long
    leftMs: FOCUS_MIN * 60 * 1000,
    totalMs: FOCUS_MIN * 60 * 1000,
    timer: null,
    endsAt: 0,       // 预计结束时间戳（ms）；暂停时为 0
    startedAt: 0,    // 当前段开始时间戳
  };

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60), r = s % 60;
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }
  function el(id) { return document.getElementById(id); }
  function renderBtn() {
    const b = el("focusFab");
    if (!b) return;
    b.classList.toggle("running", state.phase === "running");
    b.classList.toggle("paused", state.phase === "paused");
    b.classList.toggle("finished", state.phase === "finished");
    const lab = state.phase === "idle" ? "🍅 专注"
      : state.phase === "paused" ? "⏸ " + fmt(state.leftMs)
      : state.phase === "finished" ? "✓ 完成"
      : fmt(state.leftMs);
    b.textContent = lab;
  }
  function tick() {
    const left = state.endsAt - Date.now();
    if (left <= 0) { onFinish(); return; }
    state.leftMs = left;
    const d = el("focusRemain"); if (d) d.textContent = fmt(left);
    const ring = el("focusRing"); if (ring) ring.style.setProperty("--pct", ((1 - left / state.totalMs) * 100).toFixed(1));
  }
  function startTimer() {
    if (state.phase === "running") return;
    state.phase = "running";
    state.startedAt = Date.now();
    state.endsAt = Date.now() + state.leftMs;
    state.timer = setInterval(tick, 250);
    tick();
    renderBtn();
  }
  function pauseTimer() {
    if (state.phase !== "running") return;
    clearInterval(state.timer); state.timer = null;
    state.leftMs = state.endsAt - Date.now();
    state.phase = "paused";
    state.endsAt = 0;
    renderBtn();
  }
  function resetTimer(toType) {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (toType) state.type = toType;
    const mins = state.type === "short" ? SHORT_MIN : state.type === "long" ? LONG_MIN : FOCUS_MIN;
    state.totalMs = mins * 60 * 1000;
    state.leftMs = state.totalMs;
    state.phase = "idle";
    state.endsAt = 0;
    renderBtn();
    syncPanel();
  }
  async function onFinish() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.phase = "finished";
    state.leftMs = 0;
    renderBtn();
    syncPanel();
    if (state.startedAt) {
      const log = (await getSetting("focusLog", {})) || {};
      const day = todayStr();
      log[day] = log[day] || [];
      log[day].push({ start: new Date(state.startedAt).toISOString(), end: new Date().toISOString(), type: state.type, mins: Math.round(state.totalMs / 60000) });
      // 同一日仅保留 200 段，避免无限增长
      if (log[day].length > 200) log[day] = log[day].slice(-200);
      await setSetting("focusLog", log);
      // 时间账本联动：专注段完成后自动写一条时间记录（开关在时间账本页，默认开）
      if (state.type === "focus" && window.WB.timeledger) {
        window.WB.timeledger.logFocus(Math.round(state.totalMs / 60000), "focus");
      }
    }
    // 浮窗轻提示
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification("专注完成", { body: state.type === "focus" ? "休息 5 分钟，下一轮更稳" : "回工作吧", silent: true }); } catch (e) { /* 忽略 */ }
    }
  }
  // 路由切换后重新挂事件（虽然事件委托在 document，但面板 DOM 是新创建）
  async function syncPanel() {
    const ring = el("focusRing"); if (!ring) return;
    ring.style.setProperty("--pct", ((1 - state.leftMs / state.totalMs) * 100).toFixed(1));
    el("focusRemain").textContent = fmt(state.leftMs);
    el("focusTotal").textContent = Math.round(state.totalMs / 60000) + " 分钟";
    el("focusTypeLabel").textContent = state.type === "short" ? "短休息" : state.type === "long" ? "长休息" : "专注";
    // 按钮文案
    const startBtn = el("focusStart"), pauseBtn = el("focusPause"), resetBtn = el("focusReset");
    if (state.phase === "running") {
      startBtn.textContent = "进行中…"; startBtn.disabled = true;
      pauseBtn.textContent = "⏸ 暂停"; pauseBtn.style.display = "";
      resetBtn.textContent = "↺ 重置";
    } else if (state.phase === "paused") {
      startBtn.textContent = "▶ 继续"; startBtn.disabled = false;
      pauseBtn.textContent = "⏸ 暂停"; pauseBtn.style.display = "none";
      resetBtn.textContent = "↺ 重置";
    } else {
      startBtn.textContent = "▶ 开始"; startBtn.disabled = false;
      pauseBtn.textContent = "⏸ 暂停"; pauseBtn.style.display = "none";
      resetBtn.textContent = "↺ 重置";
    }
    // 类型切换：当前正在跑就不能切
    const typeSel = el("focusType"); if (typeSel) {
      typeSel.value = state.type;
      typeSel.disabled = state.phase === "running";
    }
    // 今日统计
    const log = (await getSetting("focusLog", {})) || {};
    const day = todayStr();
    const segs = log[day] || [];
    const focusMins = segs.filter((s) => s.type === "focus").reduce((a, b) => a + b.mins, 0);
    const pomos = segs.filter((s) => s.type === "focus").length;
    el("focusTodayMins").textContent = focusMins;
    el("focusTodayPomos").textContent = pomos;
    el("focusNextLong").textContent = pomos > 0 && pomos % LONG_EVERY === 0 ? "建议下一段 15 分钟长休息" : `满 ${LONG_EVERY} 个番茄后建议长休息`;
  }
  function ensureFab() {
    if (el("focusFab")) return;
    const b = document.createElement("button");
    b.id = "focusFab"; b.className = "focus-fab"; b.type = "button";
    b.title = "打开专注计时器";
    b.textContent = "🍅 专注";
    b.addEventListener("click", openPanel);
    document.body.appendChild(b);
    renderBtn();
  }
  function openPanel() {
    if (el("focusPanel")) return;
    const p = document.createElement("div");
    p.id = "focusPanel"; p.className = "focus-panel";
    p.innerHTML = `
      <div class="focus-head">
        <span class="focus-tt">🍅 番茄钟</span>
        <button class="icon-btn plain" id="focusClose" title="关闭">${icon("close")}</button>
      </div>
      <div class="focus-body">
        <div class="focus-ring" id="focusRing" style="--pct:0">
          <div class="focus-time" id="focusRemain">25:00</div>
        </div>
        <div class="focus-meta"><span id="focusTypeLabel">专注</span> · 共 <span id="focusTotal">25 分钟</span></div>
        <div class="focus-type">
          <select id="focusType">
            <option value="focus">专注 25 分钟</option>
            <option value="short">短休息 5 分钟</option>
            <option value="long">长休息 15 分钟</option>
          </select>
        </div>
        <div class="focus-acts">
          <button class="btn" id="focusStart">▶ 开始</button>
          <button class="btn ghost" id="focusPause" style="display:none">⏸ 暂停</button>
          <button class="btn ghost" id="focusReset">↺ 重置</button>
        </div>
        <div class="focus-stat">
          <div><b id="focusTodayPomos">0</b> 个番茄</div>
          <div><b id="focusTodayMins">0</b> 分钟专注</div>
          <div class="focus-stat-tip" id="focusNextLong">满 4 个番茄后建议长休息</div>
        </div>
      </div>
    `;
    document.body.appendChild(p);
    syncPanel();
    el("focusClose").addEventListener("click", closePanel);
    el("focusStart").addEventListener("click", () => { startTimer(); syncPanel(); });
    el("focusPause").addEventListener("click", () => { pauseTimer(); syncPanel(); });
    el("focusReset").addEventListener("click", () => { resetTimer(); });
    el("focusType").addEventListener("change", (e) => { resetTimer(e.target.value); });
    openOverlay("focus", closePanel);
  }
  function closePanel() {
    const p = el("focusPanel"); if (!p) return;
    p.remove();
    closeOverlay("focus");
  }
  // 路由变化时不关闭面板（让它"跨路由存在"）；但每次路由完成要重新挂 FAB（被 innerHTML 清掉了）
  function bootstrap() {
    ensureFab();
  }
  // 首次加载
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootstrap);
  else bootstrap();
  // 每次 hash 变化重新挂 FAB（仪表盘 innerHTML 会清掉）
  window.addEventListener("hashchange", () => setTimeout(ensureFab, 0));
  // 暴露给外部代码（如测试用）：不暴露 state 引用，避免被乱改
  window.WB.focus = { open: openPanel, close: closePanel, getMinsToday: async () => {
    const log = (await getSetting("focusLog", {})) || {};
    return (log[todayStr()] || []).filter((s) => s.type === "focus").reduce((a, b) => a + b.mins, 0);
  }};
})();
