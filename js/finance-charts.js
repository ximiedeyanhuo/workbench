/**
 * finance-charts.js — 记账页图表渲染（从 finance.js 拆出，纯渲染无业务状态）
 * 依赖：finance.js 必须先加载（提供 WB.finU 工具集）。
 * 图表实例注册表由本文件自持：finance.js 在重渲染前调 destroyAll() 防泄漏。
 */
(function () {
  "use strict";

  const { fmtYuan, monthKey, catOf } = window.WB.finU;
  const { esc, cssVar } = window.WB;

  let _charts = [];

  /** 柱状图顶部数值标签 */
  const barLabelPlugin = {
    id: "finBarLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
      ctx.save();
      ctx.font = "11px " + fontFamily;
      ctx.fillStyle = cssVar("--ink");
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      chart.data.datasets.forEach((ds, i) => {
        const meta = chart.getDatasetMeta(i);
        meta.data.forEach((el, idx) => {
          const v = ds.data[idx];
          if (!v) return;
          ctx.fillText(fmtYuan(v), el.x, el.y - 4);
        });
      });
      ctx.restore();
    }
  };

  /** 暗色主题感知的 tooltip 样式（三处图表共用） */
  function tooltipStyle() {
    const theme = document.documentElement.getAttribute("data-theme");
    const dark = theme === "dark" || theme === "midnight";
    return {
      backgroundColor: dark ? "rgba(28, 33, 40, 0.92)" : "rgba(255, 255, 255, 0.92)",
      titleColor: dark ? "#eef1f5" : "#2b2f36",
      bodyColor: dark ? "#c3cbd4" : "#4a5058",
      borderColor: "rgba(214, 155, 114, 0.35)",
      borderWidth: 1,
      cornerRadius: 10,
      padding: 10,
    };
  }

  /** 支出分类环形图 */
  function renderFinChart(el, mtx, cats) {
    if (typeof Chart === "undefined") return;
    const cv = el.querySelector("#chartExp");
    if (!cv) return;
    const map = {};
    mtx.filter((t) => t.type === "expense").forEach((t) => {
      map[t.category] = (map[t.category] || 0) + t.amount;
    });
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return;
    const labels = entries.map((e) => esc(catOf(cats, "expense", e[0]).name));
    const colors = entries.map((e) => catOf(cats, "expense", e[0]).color);
    const data = entries.map((e) => e[1]);
    const total = data.reduce((a, b) => a + b, 0);
    const muted = cssVar("--muted"), card = cssVar("--card");
    _charts.push(new Chart(cv, {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: card, borderWidth: 2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "58%",
        plugins: {
          legend: { position: "bottom", labels: { color: muted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, padding: 12, usePointStyle: true, pointStyle: "circle" } },
          tooltip: Object.assign(tooltipStyle(), {
            callbacks: {
              label: (ctx) => ` ${ctx.label}  ${fmtYuan(ctx.parsed)} 元  (${((ctx.parsed / total) * 100).toFixed(1)}%)`,
            },
          }),
        },
      },
    }));
  }

  /** 收支趋势：近 6 个月柱状图（收入 / 支出 分组）。年月由调用方传入（视图状态在 core） */
  function renderTrendChart(el, txs, year, month) {
    if (typeof Chart === "undefined") return;
    const cv = el.querySelector("#chartTrend");
    if (!cv) return;
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(year, month - i, 1);
      months.push(monthKey(d.getFullYear(), d.getMonth()));
    }
    const incomeArr = months.map((m) => txs.filter((t) => t.type === "income" && (t.date || "").slice(0, 7) === m).reduce((s, t) => s + t.amount, 0));
    const expenseArr = months.map((m) => txs.filter((t) => t.type === "expense" && (t.date || "").slice(0, 7) === m).reduce((s, t) => s + t.amount, 0));
    const muted = cssVar("--muted"), line = cssVar("--line"), ok = cssVar("--ok"), danger = cssVar("--danger");
    _charts.push(new Chart(cv, {
      type: "bar",
      plugins: [barLabelPlugin],
      data: {
        labels: months.map((m) => m.slice(2)),
        datasets: [
          { label: "收入", data: incomeArr, backgroundColor: ok, borderRadius: 6 },
          { label: "支出", data: expenseArr, backgroundColor: danger, borderRadius: 6 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 18 } },
        plugins: {
          legend: { position: "top", labels: { color: muted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, padding: 8 } },
          tooltip: Object.assign(tooltipStyle(), {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label} ${ctx.parsed.y >= 0 ? "+" : ""}${fmtYuan(ctx.parsed.y)} 元`,
            },
          }),
        },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 } }, grid: { color: line } },
        },
      },
    }));
  }

  /** 年账视图辅助：今年 vs 去年月度支出对比柱图 */
  function renderYearCmpChart(el, txs) {
    if (typeof Chart === "undefined") return;
    const cv = el.querySelector("#chartYearCmp");
    if (!cv) return;
    const thisYear = new Date().getFullYear();
    const lastYear = thisYear - 1;
    const months = ["01","02","03","04","05","06","07","08","09","10","11","12"];
    const byM = (y) => months.map((m) => txs.filter((t) => t.type === "expense" && (t.date || "").slice(0, 7) === `${y}-${m}`).reduce((s, t) => s + Number(t.amount || 0), 0));
    const cur = byM(thisYear), prev = byM(lastYear);
    if (cur.every((v) => v === 0) && prev.every((v) => v === 0)) return;
    const muted = cssVar("--muted"), line = cssVar("--line"), danger = cssVar("--danger");
    _charts.push(new Chart(cv, {
      type: "bar",
      data: {
        labels: ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"],
        datasets: [
          { label: `${lastYear} 年`, data: prev, backgroundColor: muted, borderRadius: 4 },
          { label: `${thisYear} 年`, data: cur, backgroundColor: danger, borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", labels: { color: muted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, padding: 8 } },
          tooltip: Object.assign(tooltipStyle(), {
            callbacks: { label: (c) => ` ${c.dataset.label} ${fmtYuan(c.parsed.y)} 元` },
          }),
        },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 } }, grid: { color: line } },
        },
      },
    }));
  }

  window.WB.finChartMgr = {
    /** 重渲染前销毁全部旧实例（防 Chart.js 残留引用泄漏） */
    destroyAll() {
      _charts.forEach((c) => c.destroy());
      _charts = [];
    },
    /** 一次渲染本页全部图表（年月为视图状态，由 core 传入） */
    renderAll(el, mtx, txs, cats, year, month) {
      renderFinChart(el, mtx, cats);
      renderTrendChart(el, txs, year, month);
      renderYearCmpChart(el, txs);
    },
  };
})();
