/**
 * life.js — 自我管理：习惯打卡（月热力格 + 连续天数）+ 健康记录（体重/跑步/睡眠时间序列）
 *          （记账已拆到 finance.js，作为独立菜单）
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, todayStr, dateStr, fmtMoney, flashInvalid, cssVar, streakOf } = window.WB;
  const habitsRepo = repo("habits");
  const healthRepo = repo("health");

  const HABIT_COLORS = ["#FF5A36", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899"];

  // 健康指标定义：体重纵轴不从 0 起（否则曲线被压成直线），其余从 0 起
  const METRICS = {
    weight: { label: "体重", unit: "kg", varName: "--primary", beginAtZero: false },
    run: { label: "跑步", unit: "km", varName: "--ok", beginAtZero: true },
    sleep: { label: "睡眠", unit: "h", varName: "--purple", beginAtZero: true },
  };

  let lifeCharts = []; // 重渲染前销毁旧实例，避免 Chart.js 残留引用

  // 模块内状态：热力图展示的月份
  const now = new Date();
  let heatYear = now.getFullYear();
  let heatMonth = now.getMonth();

  // ---------- 习惯 ----------
  function habitsHtml(habits) {
    const today = todayStr();
    const daysInMonth = new Date(heatYear, heatMonth + 1, 0).getDate();

    const cards = habits.length
      ? habits
          .map((h) => {
            const ck = h.checkins || {};
            const cells = [];
            for (let i = 1; i <= daysInMonth; i++) {
              const ds = dateStr(new Date(heatYear, heatMonth, i));
              const on = !!ck[ds];
              const future = ds > today;
              cells.push(
                `<div class="heat-cell ${on ? "on" : ""} ${future ? "future" : ""} ${ds === today ? "today-cell" : ""}"
                  style="${on ? "background:" + esc(h.color) : ""}" data-hid="${h.id}" data-day="${ds}" title="${ds}">${i}</div>`
              );
            }
            const doneToday = !!ck[today];
            return `<div class="habit-card" data-hid="${h.id}">
              <div class="habit-head">
                <span class="name"><span class="pri-dot" style="background:${esc(h.color)}"></span>${esc(h.name)}</span>
                <span class="streak">🔥 连续 ${streakOf(h)} 天</span>
                <button class="btn sm ${doneToday ? "ghost" : ""}" data-act="check-today" data-hid="${h.id}">${doneToday ? "✓ 今日已打卡" : "今日打卡"}</button>
                <button class="icon-btn" data-act="del-habit" data-hid="${h.id}" title="删除习惯">${WB.icon("del")}</button>
              </div>
              <div class="heat-grid">${cells.join("")}</div>
            </div>`;
          })
          .join("")
      : '<div class="empty">还没有习惯，先加一个「每天读书 30 分钟」？</div>';

    return `<div class="card">
      <h2>习惯打卡
        <span class="count" style="display:flex;gap:6px;align-items:center">
          <button class="icon-btn plain" id="heatPrev" title="上个月">${WB.icon("prev")}</button>
          ${heatYear}年${heatMonth + 1}月
          <button class="icon-btn plain" id="heatNext" title="下个月">${WB.icon("next")}</button>
        </span>
      </h2>
      <div class="row" style="margin-bottom:6px">
        <input class="grow" id="habitName" placeholder="新习惯，如：早起 / 背单词 / 运动" maxlength="20" />
        <button class="btn sm" id="habitAdd">添加习惯</button>
      </div>
      <div id="habitList">${cards}</div>
    </div>`;
  }

  // ---------- 健康记录 ----------
  function healthHtml(records) {
    const opts = Object.keys(METRICS)
      .map((k) => `<option value="${k}">${METRICS[k].label}（${METRICS[k].unit}）</option>`)
      .join("");

    const boxes = Object.keys(METRICS)
      .map((k) => `<div class="chart-box"><div class="chart-tt">近 30 天${METRICS[k].label}（${METRICS[k].unit}）</div><canvas id="chartH_${k}" height="150"></canvas></div>`)
      .join("");

    // 最近 10 条流水（全指标混排，日期倒序）
    const recent = records
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, 10)
      .map((r) => {
        const m = METRICS[r.metric] || { label: r.metric, unit: "" };
        return `<li class="item" data-id="${r.id}">
          <span class="txt">${esc(m.label)} <b>${Number(r.value)}</b> ${m.unit}</span>
          <span class="meta">${r.date || ""}</span>
          <button class="icon-btn" data-act="del-health" title="删除">${WB.icon("del")}</button>
        </li>`;
      })
      .join("");

    return `<div class="card" style="margin-top:16px">
      <h2>健康记录<span class="count">同一天同一指标重复录入会覆盖</span></h2>
      <div class="row" style="margin-bottom:10px">
        <select id="hMetric">${opts}</select>
        <input type="number" id="hValue" placeholder="数值" style="width:110px" min="0" step="0.1" />
        <input type="date" id="hDate" value="${todayStr()}" />
        <button class="btn" id="hAdd">记一笔</button>
      </div>
      <div class="chart-grid">${boxes}</div>
      <div id="healthList" style="margin-top:10px">
        ${records.length ? `<ul class="list">${recent}</ul>` : '<div class="empty">还没有健康记录，从今天的体重开始？</div>'}
      </div>
    </div>`;
  }

  /** 近 30 天折线，无记录日留空用 spanGaps 连线；与仪表盘 renderCharts 同套配置 */
  function renderHealthCharts(el, records) {
    if (typeof Chart === "undefined") return; // chart.umd.min.js 未加载时静默降级
    const muted = cssVar("--muted"), line = cssVar("--line");
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      days.push(dateStr(d));
    }
    const dayLabs = days.map((ds) => ds.slice(5));

    Object.keys(METRICS).forEach((k) => {
      const cv = el.querySelector("#chartH_" + k);
      if (!cv) return;
      const m = METRICS[k];
      // 同日多条取最后写入的一条（正常不会出现，录入时已按 日期+指标 覆盖）
      const byDate = {};
      records.filter((r) => r.metric === k).forEach((r) => { byDate[r.date] = Number(r.value); });
      const data = days.map((ds) => (byDate[ds] !== undefined ? byDate[ds] : null));
      const color = cssVar(m.varName);
      lifeCharts.push(new Chart(cv, {
        type: "line",
        data: { labels: dayLabs, datasets: [{ data, borderColor: color, backgroundColor: color, tension: 0.35, pointRadius: 2.5, spanGaps: true }] },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: muted, font: { size: 10 }, maxTicksLimit: 10 }, grid: { display: false } },
            y: { beginAtZero: m.beginAtZero, ticks: { color: muted, font: { size: 10 } }, grid: { color: line } },
          },
        },
      }));
    });
  }

  // ---------- 主渲染 ----------
  routes.life = {
    title: "生活",
    async render(el) {
      const [habits, health] = await Promise.all([
        habitsRepo.list(),
        healthRepo.list(),
      ]);

      // 重渲染前销毁所有旧图表实例
      lifeCharts.forEach((c) => c.destroy());
      lifeCharts = [];

      el.innerHTML = `<div>${habitsHtml(habits)}</div>${healthHtml(health)}`;

      renderHealthCharts(el, health);

      const rerender = () => routes.life.render(el);

      // --- 习惯 ---
      el.querySelector("#heatPrev").addEventListener("click", () => {
        heatMonth--; if (heatMonth < 0) { heatMonth = 11; heatYear--; } rerender();
      });
      el.querySelector("#heatNext").addEventListener("click", () => {
        heatMonth++; if (heatMonth > 11) { heatMonth = 0; heatYear++; } rerender();
      });
      const addHabit = async () => {
        const nameInput = el.querySelector("#habitName");
        const name = nameInput.value.trim();
        if (!name) return flashInvalid(nameInput);
        await habitsRepo.put({
          id: uid(), name,
          color: HABIT_COLORS[habits.length % HABIT_COLORS.length],
          checkins: {},
        });
        rerender();
      };
      el.querySelector("#habitAdd").addEventListener("click", addHabit);
      el.querySelector("#habitName").addEventListener("keydown", (e) => { if (e.key === "Enter") addHabit(); });

      el.querySelector("#habitList").addEventListener("click", async (e) => {
        const today = todayStr();
        // 里程碑提示：打卡后连续天数恰好命中节点时庆祝一下（只在新增打卡时触发，取消不提）
        const MILESTONES = [7, 30, 100, 365];
        const cheer = (h) => {
          const s = streakOf(h);
          if (MILESTONES.includes(s)) window.WB.showToast(`🎉 里程碑达成！「${h.name}」已连续打卡 ${s} 天，继续保持！`, "success");
        };
        const cell = e.target.closest(".heat-cell");
        if (cell && !cell.classList.contains("future")) {
          const h = await habitsRepo.get(cell.dataset.hid);
          if (h) {
            h.checkins = h.checkins || {};
            const d = cell.dataset.day;
            const adding = !h.checkins[d];
            if (h.checkins[d]) delete h.checkins[d]; else h.checkins[d] = true;
            await habitsRepo.put(h);
            if (adding) cheer(h);
            rerender();
          }
          return;
        }
        const actEl = e.target.closest("[data-act]");
        if (!actEl) return;
        if (actEl.dataset.act === "check-today") {
          const h = await habitsRepo.get(actEl.dataset.hid);
          if (h) {
            h.checkins = h.checkins || {};
            const adding = !h.checkins[today];
            if (h.checkins[today]) delete h.checkins[today]; else h.checkins[today] = true;
            await habitsRepo.put(h);
            if (adding) cheer(h);
            rerender();
          }
        } else if (actEl.dataset.act === "del-habit") {
          if (!confirm("删除该习惯及全部打卡记录？")) return;
          await habitsRepo.delete(actEl.dataset.hid);
          rerender();
        }
      });

      // --- 健康 ---
      const addHealth = async () => {
        const valueInput = el.querySelector("#hValue");
        const value = parseFloat(valueInput.value);
        if (!(value > 0)) return flashInvalid(valueInput); // 数值需为正数
        const metric = el.querySelector("#hMetric").value;
        const date = el.querySelector("#hDate").value || todayStr();
        // 同日同指标覆盖：复用既有 id，避免一天多条脏数据
        const exist = health.find((r) => r.metric === metric && r.date === date);
        await healthRepo.put({ id: exist ? exist.id : uid(), metric, value, date });
        rerender();
      };
      el.querySelector("#hAdd").addEventListener("click", addHealth);
      el.querySelector("#hValue").addEventListener("keydown", (e) => { if (e.key === "Enter") addHealth(); });

      el.querySelector("#healthList").addEventListener("click", async (e) => {
        const d = e.target.closest('[data-act="del-health"]');
        if (!d) return;
        const r = health.find((x) => x.id === d.closest("[data-id]").dataset.id);
        const m = r && (METRICS[r.metric] || { label: r.metric });
        if (!confirm(`删除这条健康记录${r && m ? `（${m.label} ${Number(r.value)} ${m.unit} · ${r.date || ""}）` : ""}？`)) return;
        await healthRepo.delete(d.closest("[data-id]").dataset.id);
        rerender();
      });
    },
  };
})();
