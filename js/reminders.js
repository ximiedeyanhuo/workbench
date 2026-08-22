/* reminders.js — 自定义提醒（周期提醒）
 * 通用重复提醒：吃药 / 喝水 / 还款 / 运动 / 周报…
 * - 存 reminders store（独立库 workbench_remind）
 * - 周期：每天 / 每周（选星期几）/ 每月（选几号）
 * - 到点判断：仅提醒"今天该提醒且未完成"的项（一个周期完成一次）
 * - 完成状态记录在 settings.reminderDone[YYYY-MM-DD] = [id, ...]
 * - 页面打开时提醒一次；若授予通知权限则发浏览器通知
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, uid, esc, icon, todayStr, getSettings, setSetting, flashInvalid, showToast } = window.WB;

  const rRepo = () => repo("reminders");
  const DONE_KEY = "reminderDone";

  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

  /** 今天这个提醒是否「该做」（按周期） */
  function dueToday(r, today) {
    const dow = new Date(today + "T00:00:00").getDay();
    if (r.period === "daily") return true;
    if (r.period === "weekly") return (r.weekdays || []).indexOf(dow) !== -1;
    if (r.period === "monthly") {
      const dom = Number(r.dayOfMonth || 1);
      return Number(today.slice(8, 10)) === dom;
    }
    return false;
  }
  // 供仪表盘复用：该提醒今天是否到期
  window.WB.remindDue = dueToday;

  /** 下一次到期描述（最近一天） */
  function nextDueLabel(r) {
    const today = todayStr();
    const now = new Date(today + "T00:00:00");
    for (let i = 0; i < 370; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      const ds = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      if (dueToday(r, ds)) {
        if (i === 0) return "今天";
        if (i === 1) return "明天";
        return `${ds.slice(5)}（周${WEEK[d.getDay()]}）`;
      }
    }
    return "—";
  }

  function periodLabel(r) {
    if (r.period === "daily") return "每天";
    if (r.period === "weekly") return "每周" + (r.weekdays || []).map((d) => "周" + WEEK[d]).join("·");
    if (r.period === "monthly") return "每月 " + r.dayOfMonth + " 号";
    return "—";
  }

  function renderForm() {
    return `
      <div class="card">
        <h2>新建提醒</h2>
        <div class="row">
          <input class="grow" id="rmTitle" placeholder="提醒事项（吃药 / 喝水 / 还款 / 运动 / 周报…）" maxlength="50" />
          <select id="rmPeriod">
            <option value="daily">每天</option>
            <option value="weekly">每周（选星期）</option>
            <option value="monthly">每月（选几号）</option>
          </select>
          <span class="rm-weekdays" id="rmWeekdays" style="display:none">
            ${WEEK.map((w, i) => `<button class="btn ghost sm rm-dow" data-dow="${i}">${w}</button>`).join("")}
          </span>
          <input type="number" id="rmDom" min="1" max="31" placeholder="几号" class="w-70" style="display:none" />
          <button class="btn in-card-btn" id="rmAdd">添加</button>
        </div>
      </div>`;
  }

  function renderList(items, doneSet) {
    const today = todayStr();
    const sorted = (items || []).slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    if (!sorted.length) return '<div class="empty">还没有提醒，先在上面添加一个</div>';
    return `
      <ul class="list">
        ${sorted.map((r) => {
          const due = dueToday(r, today);
          const done = !!(doneSet && doneSet[r.id]);
          const status = due
            ? (done ? '<span class="badge b-ok">今天已完成</span>' : '<span class="badge b-warn">今天待提醒</span>')
            : '<span class="badge b-primary">下次 ' + esc(nextDueLabel(r)) + '</span>';
          return `<li class="item">
            <span class="txt">
              <span class="rm-title">${esc(r.title)}</span>
              <span class="rm-period">${esc(periodLabel(r))}</span>
            </span>
            <span class="rm-status">${status}</span>
            ${due && !done ? `<button class="btn sm" data-rmdone="${r.id}">完成</button>` : ""}
            <button class="icon-btn plain" data-rmdel="${r.id}" title="删除">${icon("trash")}</button>
          </li>`;
        }).join("")}
      </ul>`;
  }

  async function renderListBox(el, items, doneSet) {
    const box = el.querySelector("#rmList");
    if (!box) return;
    box.innerHTML = renderList(items, doneSet);
    box.querySelectorAll("[data-rmdone]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.dataset.rmdone;
        const done = (await getSettings({ [DONE_KEY]: {} }))[DONE_KEY] || {};
        done[id] = true;
        await setSetting(DONE_KEY, done);
        renderListBox(el, items, done);
        // 完成后若有通知权限给一个轻确认
        if ("Notification" in window && Notification.permission === "granted") {
          try {
            const r = items.find((x) => x.id === id);
            new Notification("提醒完成 ✓", { body: r ? r.title : "", tag: "wb-remind", silent: true });
          } catch (e) { /* 忽略 */ }
        }
      })
    );
    box.querySelectorAll("[data-rmdel]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.dataset.rmdel;
        const r = items.find((x) => x.id === id);
        if (!confirm(`删除提醒「${r ? r.title : ""}」？`)) return;
        await rRepo().delete(id);
        showToast("已删除", "info");
        routes.reminders.render(el);
      })
    );
  }

  /** 页面渲染时对"今天待提醒"发起通知（页面打开即触发一次；频控避免重复） */
  function notifyDue(items, doneSet, today) {
    const due = (items || []).filter((r) => dueToday(r, today) && !doneSet[r.id]);
    if (!due.length) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    // 每分钟只通知一次，避免切路由反复弹
    let last = 0;
    try { last = Number(localStorage.getItem("wb2_remind_notify")) || 0; } catch (e) { /* ignore */ }
    if (Date.now() - last < 60000) return;
    try { localStorage.setItem("wb2_remind_notify", String(Date.now())); } catch (e) { /* ignore */ }
    try {
      const n = new Notification("今天有提醒", { body: due.map((r) => r.title).join("、"), tag: "wb-remind" });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.ready
          .then((reg) => reg.showNotification("今天有提醒", { body: due.map((r) => r.title).join("、"), tag: "wb-remind" }))
          .catch(() => {});
      }
    }
  }

  routes.reminders = {
    title: "提醒",
    async render(el) {
      const [items, st] = await Promise.all([
        rRepo().list().catch(() => []),
        getSettings({ [DONE_KEY]: {} }),
      ]);
      const doneSet = st[DONE_KEY] || {};
      const today = todayStr();

      if (!/^#\/reminders/.test(location.hash || "")) return;
      el.innerHTML = `
        ${renderForm()}
        <div class="card">
          <h2>提醒列表<span class="count">${(items || []).length} 条</span></h2>
          <div class="row sp-bot-sm" style="color:var(--muted);font-size:12.5px">
            <span>周期类提醒到点才需要完成一次；完成状态按天记录，次日自动重置。</span>
          </div>
          <div id="rmList">${renderList(items, doneSet)}</div>
        </div>
        <div class="footnote">浏览器通知需在地址栏授权：点「完成」或页面打开时会在今日首次提醒时弹出。</div>`;

      // 新建
      const addBtn = el.querySelector("#rmAdd");
      let rmAdding = false; // 锁防双击重复添加提醒
      addBtn.addEventListener("click", async () => {
        if (rmAdding) return;
        const titleInput = el.querySelector("#rmTitle");
        const title = titleInput.value.trim();
        if (!title) return flashInvalid(titleInput);
        const period = el.querySelector("#rmPeriod").value;
        const weekdays = [...el.querySelectorAll(".rm-dow.on")].map((b) => Number(b.dataset.dow));
        const dayOfMonth = Number(el.querySelector("#rmDom").value) || 1;
        if (period === "weekly" && !weekdays.length) return showToast("请至少勾选一个星期", "error");
        rmAdding = true;
        try {
          await rRepo().put({
            id: uid(),
            title,
            period,
            weekdays: period === "weekly" ? weekdays : [],
            dayOfMonth: period === "monthly" ? dayOfMonth : 1,
            createdAt: new Date().toISOString(),
          });
        } finally { rmAdding = false; }
        showToast("已添加提醒", "ok");
        routes.reminders.render(el);
      });

      // 周期切换：显示星期/几号选择
      const periodSel = el.querySelector("#rmPeriod");
      periodSel.addEventListener("change", () => {
        el.querySelector("#rmWeekdays").style.display = periodSel.value === "weekly" ? "" : "none";
        el.querySelector("#rmDom").style.display = periodSel.value === "monthly" ? "" : "none";
      });
      el.querySelectorAll(".rm-dow").forEach((b) =>
        b.addEventListener("click", () => b.classList.toggle("on"))
      );

      await renderListBox(el, items, doneSet);
      notifyDue(items, doneSet, today);
    },
  };
})();
