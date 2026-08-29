/**
 * finance-stats.js — 记账统计卡视图构建器（周账 / 月账 / 年账 / 分类预算）
 *
 * 从 finance.js 拆出（行为保持重构）：只做 HTML 构建，不读任何模块级状态——
 * 年份/预算等一律由调用方（finance.js）显式传参。Chart 交互渲染仍在 finance-charts.js。
 * 共享工具取 window.WB.finU（finance.js 末尾导出），故本文件必须后于 finance.js 加载。
 */
(function () {
  "use strict";

  const { weekStartOf, addDays, monthKey, sumBy, fmtYuan, signedYuan } = window.WB.finU;
  const { esc } = window.WB;

  /** 周账视图：year 内有记录的自然周（周一~周日），金额可点跳明细（需求 §3） */
  function buildWeek(txs, year) {
    const byWeek = {};
    txs.forEach((t) => {
      if (!t.date) return;
      const ws = weekStartOf(t.date);
      if (ws.slice(0, 4) !== String(year)) return;
      (byWeek[ws] = byWeek[ws] || []).push(t);
    });
    const keys = Object.keys(byWeek).sort((a, b) => b.localeCompare(a));
    if (!keys.length) return `<div class="empty">${year}年还没有记录</div>`;

    const rows = keys.map((ws) => {
      const we = addDays(ws, 6);
      const list = byWeek[ws];
      const inc = sumBy(list, "income"), exp = sumBy(list, "expense");
      const net = inc.amt - exp.amt;
      return `<tr class="tx-yr-row" data-ws="${ws}" data-we="${we}">
        <td title="${ws} ~ ${we}">${ws.slice(5)} ~ ${we.slice(5)}</td>
        <td class="${inc.amt ? "tx-lnk" : ""}" data-jt="income" style="color:${inc.amt ? "var(--ok)" : "inherit"}">${inc.amt ? "+" + fmtYuan(inc.amt) : "—"}</td>
        <td class="${exp.amt ? "tx-lnk" : ""}" data-jt="expense" style="color:${exp.amt ? "var(--danger)" : "inherit"}">${exp.amt ? "-" + fmtYuan(exp.amt) : "—"}</td>
        <td style="color:${net >= 0 ? "var(--ok)" : "var(--danger)"}">${signedYuan(net)}</td>
        <td class="tx-yr-cnt">${fmtYuan(exp.amt / 7)}</td>
        <td class="tx-yr-cnt">${inc.cnt + exp.cnt}</td>
        <td><button class="icon-btn plain pc-only" data-act="exp-range" title="导出该周明细 CSV">${window.WB.icon("export")}</button></td>
      </tr>`;
    });
    return `<div class="tx-year-wrap" id="finWeekWrap"><table class="tx-year-table">
      <thead><tr><th>周（一~日）</th><th>收入</th><th>支出</th><th>结余</th><th>日均支出</th><th>笔数</th><th></th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>
    <div class="tx-year-tip">点收入/支出金额跳该周明细<span class="pc-only"> · ⤓ 导出该周全部流水</span></div>`;
  }

  /** 月账视图：year 12 个月汇总表（需求 §4；原"年账"更名） */
  function buildMonth(txs, year) {
    const now = new Date();
    const rows = [];
    let yIncome = 0, yExpense = 0, yInCnt = 0, yExCnt = 0;
    for (let m = 0; m < 12; m++) {
      const mk = monthKey(year, m);
      const list = txs.filter((t) => (t.date || "").slice(0, 7) === mk);
      const inc = sumBy(list, "income"), exp = sumBy(list, "expense");
      yIncome += inc.amt; yExpense += exp.amt; yInCnt += inc.cnt; yExCnt += exp.cnt;
      const net = inc.amt - exp.amt;
      const hasData = inc.amt || exp.amt;
      const daysInMonth = new Date(year, m + 1, 0).getDate();
      // 当月日均按已过天数算，过往月份按整月天数算
      const daysForAvg = (year === now.getFullYear() && m === now.getMonth()) ? Math.max(1, now.getDate()) : daysInMonth;
      rows.push(`<tr class="${hasData ? "tx-yr-row" : "tx-yr-row dim"}" data-month="${m}">
        <td>${m + 1}月</td>
        <td class="${inc.amt ? "tx-lnk" : ""}" data-jt="income" style="color:${inc.amt ? "var(--ok)" : "inherit"}">${inc.amt ? "+" + fmtYuan(inc.amt) : "—"}</td>
        <td class="${exp.amt ? "tx-lnk" : ""}" data-jt="expense" style="color:${exp.amt ? "var(--danger)" : "inherit"}">${exp.amt ? "-" + fmtYuan(exp.amt) : "—"}</td>
        <td style="color:${net >= 0 ? "var(--ok)" : "var(--danger)"}">${hasData ? signedYuan(net) : "—"}</td>
        <td class="tx-yr-cnt">${exp.amt ? fmtYuan(exp.amt / daysForAvg) : "—"}</td>
        <td class="tx-yr-cnt">${inc.cnt + exp.cnt || "—"}</td>
        <td>${hasData ? `<button class="icon-btn plain pc-only" data-act="exp-range" title="导出该月明细 CSV">${window.WB.icon("export")}</button>` : ""}</td>
      </tr>`);
    }
    const yNet = yIncome - yExpense;
    return `<div class="tx-year-wrap" id="finMonthWrap"><table class="tx-year-table">
      <thead><tr><th>月份</th><th>收入</th><th>支出</th><th>结余</th><th>日均支出</th><th>笔数</th><th></th></tr></thead>
      <tbody>${rows.join("")}</tbody>
      <tfoot><tr>
        <td>合计</td>
        <td class="c-ok">+${fmtYuan(yIncome)}</td>
        <td class="c-danger">-${fmtYuan(yExpense)}</td>
        <td style="color:${yNet >= 0 ? "var(--ok)" : "var(--danger)"}">${signedYuan(yNet)}</td>
        <td class="tx-yr-cnt">${fmtYuan(yExpense / 12)}</td>
        <td class="tx-yr-cnt">${yInCnt + yExCnt}</td>
        <td></td>
      </tr></tfoot>
    </table></div>
    <div class="tx-year-tip">合计行"日均支出"列为月均支出 · 点收入/支出金额跳该月明细 · 点月份行跳当月列表</div>`;
  }

  /** 年账视图：跨年聚合（需求 §5），点年份行跳当年月账 */
  function buildYear(txs) {
    const now = new Date();
    const years = new Set([String(now.getFullYear())]);
    txs.forEach((t) => { if (t.date) years.add(t.date.slice(0, 4)); });
    const rows = [...years].sort((a, b) => b.localeCompare(a)).map((y) => {
      const list = txs.filter((t) => (t.date || "").slice(0, 4) === y);
      const inc = sumBy(list, "income"), exp = sumBy(list, "expense");
      const net = inc.amt - exp.amt;
      const hasData = inc.amt || exp.amt;
      return `<tr class="${hasData ? "tx-yr-row" : "tx-yr-row dim"}" data-year="${y}">
        <td>${y}年</td>
        <td class="${inc.amt ? "tx-lnk" : ""}" data-jt="income" style="color:${inc.amt ? "var(--ok)" : "inherit"}">${inc.amt ? "+" + fmtYuan(inc.amt) : "—"}</td>
        <td class="${exp.amt ? "tx-lnk" : ""}" data-jt="expense" style="color:${exp.amt ? "var(--danger)" : "inherit"}">${exp.amt ? "-" + fmtYuan(exp.amt) : "—"}</td>
        <td style="color:${net >= 0 ? "var(--ok)" : "var(--danger)"}">${hasData ? signedYuan(net) : "—"}</td>
        <td class="tx-yr-cnt">${inc.cnt + exp.cnt || "—"}</td>
        <td>${hasData ? `<button class="icon-btn plain pc-only" data-act="exp-range" title="导出该年明细 CSV">${window.WB.icon("export")}</button>` : ""}</td>
      </tr>`;
    });
    return `<div class="tx-year-wrap" id="finYearWrap"><table class="tx-year-table">
      <thead><tr><th>年份</th><th>收入</th><th>支出</th><th>结余</th><th>笔数</th><th></th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>
    <div class="tx-year-tip">点收入/支出金额跳该年明细 · 点年份行看该年月账</div>
    ${yearCompareHtml(txs)}`;
  }

  /** 年账视图辅助：今年 vs 去年月度支出对比柱图 + 同比变化文案（图表本体由 finance-charts 渲染） */
  function yearCompareHtml(txs) {
    const now = new Date();
    const thisYear = now.getFullYear();
    const lastYear = thisYear - 1;
    const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
    const byM = (y) => months.map((m) => txs.filter((t) => t.type === "expense" && (t.date || "").slice(0, 7) === `${y}-${m}`).reduce((s, t) => s + Number(t.amount || 0), 0));
    const cur = byM(thisYear), prev = byM(lastYear);
    const sumCur = cur.reduce((a, b) => a + b, 0), sumPrev = prev.reduce((a, b) => a + b, 0);
    if (sumCur === 0 && sumPrev === 0) return ""; // 双年都没数据就不渲染
    const delta = sumCur - sumPrev;
    const pct = sumPrev > 0 ? (delta / sumPrev) * 100 : (sumCur > 0 ? 100 : 0);
    const tone = delta <= 0 ? "ok" : delta > sumPrev * 0.1 ? "danger" : "warn";
    const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "—";
    const sign = delta > 0 ? "+" : "";
    return `<div class="tx-year-cmp" id="finYearCmp">
      <div class="tx-year-cmp-head">
        <span class="tx-year-cmp-tt">${lastYear} 年 vs ${thisYear} 年 · 月度支出对比</span>
        <span class="tx-year-cmp-tag tag-${tone}">同比 ${arrow} ${sign}${pct.toFixed(1)}%</span>
      </div>
      <canvas id="chartYearCmp" height="160"></canvas>
      <div class="tx-year-cmp-legend">
        <span class="lg-dot" style="background:var(--muted)"></span>${lastYear} 年 · 合计 ${fmtYuan(sumPrev)}
        <span class="lg-dot" style="background:var(--danger);margin-left:14px"></span>${thisYear} 年 · 合计 ${fmtYuan(sumCur)}
      </div>
    </div>`;
  }

  /** 分类预算视图：每类 已用/预算/进度条，行内改预算（settings.finCatBudget，仅支出类） */
  function buildBudget(cats, mtx, budgets) {
    budgets = budgets || {};
    const spentBy = {};
    mtx.forEach((t) => { if (t.type === "expense") spentBy[t.category] = (spentBy[t.category] || 0) + t.amount; });
    const rows = (cats.expense || [])
      .filter((c) => Number(budgets[c.id]) > 0 || spentBy[c.id] > 0)
      .map((c) => {
        const b = Number(budgets[c.id] || 0);
        const spent = spentBy[c.id] || 0;
        const pct = b > 0 ? Math.min(100, Math.round((spent / b) * 100)) : 0;
        const over = b > 0 && spent > b;
        return `<div class="set-row cat-budget-row">
          <span class="s-name" style="min-width:78px"><span class="dot" style="background:${c.color}"></span> ${esc(c.name)}</span>
          <div class="grow"><div class="bar"><i style="width:${pct}%;${over ? "background:var(--danger)" : pct >= 80 ? "background:var(--warn)" : ""}"></i></div></div>
          <span class="s-desc" style="${over ? "color:var(--danger);font-weight:600" : ""}">${b > 0 ? `${fmtYuan(spent)} / ${fmtYuan(b)}${over ? ` 超 ${fmtYuan(spent - b)}` : ""}` : `已支出 ${fmtYuan(spent)}（未设预算）`}</span>
          <button class="btn ghost sm" data-catbudget="${c.id}" data-name="${esc(c.name)}">${b > 0 ? "改预算" : "设预算"}</button>
        </div>`;
      }).join("");
    return `<div class="tx-budget-list">${rows || '<div class="empty">本月还没有支出记录</div>'}</div>
      <div class="tx-year-tip">分类预算独立于月度总预算，只看支出类型；仪表盘会在分类超支时提醒</div>`;
  }

  window.WB.finStats = { buildWeek, buildMonth, buildYear, buildBudget };
})();
