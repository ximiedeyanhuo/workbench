/**
 * reports.js — 数据统计报表：记账 / 习惯 / 健康 / 任务 统一分析视图
 *
 * 所需新增 CSS 类清单（由接线者追加到 css/app.css）：
 *
 * 1. .reports-tab-content — tab 面板内容容器，建议：padding-top: 16px
 * 2. .reports-health-meta — 健康指标统计区（三列），建议：display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:10px; text-align:center
 * 3. .reports-health-meta-item — 单个统计项，建议：background:var(--card2); padding:10px 8px; border-radius:var(--radius-sm)
 * 4. .reports-health-meta-val — 统计数值，建议：font-size:18px; font-weight:800; font-family:var(--mono); color:var(--ink); margin-top:4px
 * 5. .reports-pri-grid — 优先级分布三列卡，建议：display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:16px
 * 6. .reports-pri-card — 单优先级卡，建议：background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px; text-align:center
 * 7. .reports-pri-label — 优先级标签，建议：font-size:12px; font-weight:600; color:var(--muted); letter-spacing:0.03em
 * 8. .reports-pri-num — 优先级数字，建议：font-size:24px; font-weight:800; font-family:var(--mono); margin:8px 0
 * 9. .reports-pri-sub — 优先级副注，建议：font-size:11px; color:var(--muted)
 */
(function () {
  "use strict";
  const { routes, repo, esc, todayStr, dateStr, cssVar, streakOf, getSetting, setSetting, ai } = window.WB;
  const financeRepo = repo("finance");
  const habitsRepo = repo("habits");
  const healthRepo = repo("health");
  const tasksRepo = repo("tasks");
  const stocksRepo = repo("stocks");

  // ---------- 模块状态 ----------
  let reportTab = "finance";
  let reportYear = new Date().getFullYear();
  let charts = [];

  // ---------- 分类映射 ----------
  var CAT_NAMES = {
    food: "餐饮", traffic: "交通", shopping: "购物", housing: "居家",
    fun: "娱乐", health: "医疗健康", study: "学习", "other-e": "其它支出",
    salary: "工资", bonus: "奖金", invest: "理财", "other-i": "其它收入",
    saving: "储蓄",
  };
  var CAT_COLORS = {
    food: "#FF5A36", traffic: "#3B82F6", shopping: "#F59E0B", housing: "#8B5CF6",
    fun: "#EC4899", health: "#10B981", study: "#06B6D4", "other-e": "#75726B",
    salary: "#10B981", bonus: "#F59E0B", invest: "#8B5CF6", "other-i": "#3B82F6",
    saving: "#FF5A36",
  };
  // 自定义分类映射（Excel 导入/手动新建，render 时从 settings 填充）
  var extraCatName = {}, extraCatColor = {};
  function catName(id) { return CAT_NAMES[id] || extraCatName[id] || id || "未分类"; }
  function catColor(id) { return CAT_COLORS[id] || extraCatColor[id] || "#A5A29A"; }

  // ---------- 工具函数 ----------
  // Chart tooltip 玻璃风格（亮暗自适应）
  function glassTip(cb) {
    var dark = document.documentElement.getAttribute("data-theme") === "dark" || document.documentElement.getAttribute("data-theme") === "midnight";
    return {
      backgroundColor: dark ? "rgba(28, 33, 40, 0.92)" : "rgba(255, 255, 255, 0.92)",
      titleColor: dark ? "#eef1f5" : "#2b2f36",
      bodyColor: dark ? "#c3cbd4" : "#4a5058",
      borderColor: "rgba(214, 155, 114, 0.35)",
      borderWidth: 1,
      cornerRadius: 10,
      padding: 10,
      displayColors: true,
      boxPadding: 4,
      callbacks: { label: cb },
    };
  }

  function fmtYuan(n) {
    return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmt2(n) {
    return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmt4(n) {
    return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  }
  const udColor = (n) => (n > 0.005 ? "var(--rise)" : n < -0.005 ? "var(--fall)" : "var(--muted)");
  function getYears(list, dateField) {
    var s = new Set([String(new Date().getFullYear())]);
    list.forEach(function (r) {
      var d = r[dateField || "date"];
      if (d) s.add(d.slice(0, 4));
    });
    return Array.from(s).sort(function (a, b) { return b.localeCompare(a); });
  }
  function filterYear(list, year, dateField) {
    var y = String(year);
    return list.filter(function (r) { return (r[dateField || "date"] || "").slice(0, 4) === y; });
  }
  function lastDays(n) {
    var arr = [];
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      arr.push(dateStr(d));
    }
    return arr;
  }
  // ---------- 行情接口（复制自 stocks.js，不跨模块共享） ----------
  async function fetchStockQuotes(codes) {
    if (!window.WB.USE_API || !codes.length) return null;
    try {
      var res = await fetch("/api/stock/quote?codes=" + encodeURIComponent(codes.join(",")));
      if (!res.ok) return null;
      var list = await res.json();
      var map = {};
      list.forEach(function (q) { map[q.code] = q; });
      return map;
    } catch (e) {
      return null;
    }
  }
  async function fetchFundNavs(codes) {
    if (!window.WB.USE_API || !codes.length) return null;
    try {
      var res = await fetch("/api/fund/nav?codes=" + encodeURIComponent(codes.join(",")));
      if (!res.ok) return null;
      var list = await res.json();
      var map = {};
      list.forEach(function (q) {
        map[q.code] = {
          code: q.code,
          name: q.name || "",
          price: q.isMoney ? 1 : q.nav,
          change: q.isMoney ? q.nav / 10000 : q.nav - q.prevNav,
          pct: q.isMoney ? q.nav : q.pct,
          time: q.navDate,
          isMoney: !!q.isMoney,
        };
      });
      return map;
    } catch (e) {
      return null;
    }
  }
  // ========== 记账面板 ==========
  function renderFinancePanel(el, records) {
    var year = reportYear;
    var ytx = filterYear(records, year);
    var exp = ytx.filter(function (t) { return t.type === "expense"; });
    var inc = ytx.filter(function (t) { return t.type === "income"; });
    var expAmt = exp.reduce(function (s, t) { return s + Number(t.amount || 0); }, 0);
    var incAmt = inc.reduce(function (s, t) { return s + Number(t.amount || 0); }, 0);
    var net = incAmt - expAmt;
    var now = new Date();
    var daysPassed = (year === now.getFullYear())
      ? Math.max(1, Math.floor((now - new Date(year, 0, 1)) / 86400000) + 1)
      : (new Date(year, 1, 29).getMonth() === 1 ? 366 : 365);
    var dailyExp = expAmt / daysPassed;
    var yearOpts = getYears(records).map(function (y) {
      return '<option value="' + y + '"' + (y === String(year) ? " selected" : "") + '>' + y + "年</option>";
    }).join("");

    var monthRows = [], monthlyInc = [], monthlyExp = [];
    for (var m = 0; m < 12; m++) {
      var mk = year + "-" + String(m + 1).padStart(2, "0");
      var mList = records.filter(function (t) { return (t.date || "").slice(0, 7) === mk; });
      var mInc = mList.filter(function (t) { return t.type === "income"; }).reduce(function (s, t) { return s + Number(t.amount || 0); }, 0);
      var mExp = mList.filter(function (t) { return t.type === "expense"; }).reduce(function (s, t) { return s + Number(t.amount || 0); }, 0);
      monthlyInc.push(mInc);
      monthlyExp.push(mExp);
      var mNet = mInc - mExp;
      var hasData = mInc || mExp;
      monthRows.push('<tr class="tx-yr-row' + (hasData ? "" : " dim") + '">' +
        '<td>' + (m + 1) + "月</td>" +
        '<td style="color:' + (mInc ? "var(--ok)" : "inherit") + '">' + (mInc ? "+" + fmtYuan(mInc) : "—") + "</td>" +
        '<td style="color:' + (mExp ? "var(--danger)" : "inherit") + '">' + (mExp ? "-" + fmtYuan(mExp) : "—") + "</td>" +
        '<td style="color:' + (mNet >= 0 ? "var(--ok)" : "var(--danger)") + '">' + (hasData ? (mNet >= 0 ? "+" : "") + fmtYuan(mNet) : "—") + "</td></tr>");
    }

    var catMap = {};
    exp.forEach(function (t) {
      var c = t.category || "other-e";
      catMap[c] = (catMap[c] || 0) + Number(t.amount || 0);
    });
    var catEntries = Object.entries(catMap).sort(function (a, b) { return b[1] - a[1]; });

    el.innerHTML = '<div class="reports-tab-content">' +
      '<div class="card sp-b-2x">' +
      '<div class="row" style="justify-content:space-between;align-items:center">' +
      '<h2 class="mg0">年度财务报告</h2>' +
      '<select id="rptYear" class="tx-year-sel">' + yearOpts + "</select></div></div>" +
      '<div class="stat-grid">' +
      '<div class="stat"><div class="s-lab">年支出</div><div class="s-val c-danger">' + fmtYuan(expAmt) + '</div><div class="s-sub">' + exp.length + " 笔</div></div>" +
      '<div class="stat"><div class="s-lab">年收入</div><div class="s-val c-ok">' + fmtYuan(incAmt) + '</div><div class="s-sub">' + inc.length + " 笔</div></div>" +
      '<div class="stat"><div class="s-lab">年结余</div><div class="s-val" style="color:' + (net >= 0 ? "var(--ok)" : "var(--danger)") + '">' + (net >= 0 ? "+" : "") + fmtYuan(net) + "</div></div>" +
      '<div class="stat"><div class="s-lab">日均支出</div><div class="s-val">' + fmtYuan(dailyExp) + "</div></div></div>" +
      '<div class="chart-grid-2 sp-b-3x">' +
      '<div class="chart-box"><div class="chart-tt">月度收支（' + year + "年）</div><canvas id=\"rptFinBar\" height=\"180\"></canvas></div>" +
      '<div class="chart-box"><div class="chart-tt">年支出分类占比</div><canvas id="rptFinDoughnut" height=\"180\"></canvas></div></div>' +
      '<div class="card sp-b-2x">' +
      '<h2>理财持仓</h2>' +
      '<div class="stat-grid" id="rptStkStats">' +
        '<div class="stat"><div class="s-lab">持仓市值</div><div class="s-val" id="rptStkMv">—</div></div>' +
        '<div class="stat"><div class="s-lab">持仓成本</div><div class="s-val" id="rptStkCost">—</div></div>' +
        '<div class="stat"><div class="s-lab">持仓盈亏</div><div class="s-val c-muted" id="rptStkPl">—</div></div>' +
        '<div class="stat"><div class="s-lab">今日盈亏</div><div class="s-val c-muted" id="rptStkDay">—</div></div>' +
      '</div>' +
      '<div id="rptStkRows"><div class="empty">暂无持仓记录</div></div>' +
      '</div>' +
      '<div class="card sp-b-2x">' +
      '<h2>理财买卖流水（' + year + '年）</h2>' +
      '<div id="rptStkFlow"><div class="empty">该年度暂无理财交易流水</div></div>' +
      '</div>' +
      '<div class="card"><h2>月度汇总</h2>' +
      '<div class="tx-year-wrap"><table class="tx-year-table">' +
      "<thead><tr><th>月份</th><th>收入</th><th>支出</th><th>结余</th></tr></thead>" +
      "<tbody>" + monthRows.join("") + "</tbody></table></div></div></div>";

    renderFinanceCharts(el, monthlyInc, monthlyExp, catEntries);
    // 两个理财面板共用一份数据：只拉一次 stocks（API 模式省一次 HTTP 往返）
    var stocksPromise = stocksRepo.list();
    fillStockStats(el, stocksPromise);
    renderStockFlow(el, year, stocksPromise);
  }

  /** 按 code 聚合流水为持仓组（与 stocks.js 同款：卖出按均成本扣底数） */
  function aggregateStockHoldings(txs) {
    var groups = {};
    txs.forEach(function (tx) {
      if (!tx.code) return;
      var g = groups[tx.code] || (groups[tx.code] = { code: tx.code, name: tx.name, type: tx.type, holding: 0, avgCost: 0, buyShares: 0, buyAmt: 0, realized: 0, lastAvg: 0 });
      if (tx.action === "sell") {
        var curAvg = g.holding > 0 ? g.buyAmt / g.holding : 0;
        if (curAvg) g.lastAvg = curAvg;
        var cps = g.holding > 0 ? g.buyAmt / g.holding : 0;
        g.realized += tx.shares * (tx.price - cps);
        g.buyAmt = Math.max(0, g.buyAmt - cps * tx.shares);
        g.holding -= tx.shares;
      } else {
        g.holding += tx.shares;
        g.buyShares += tx.shares;
        g.buyAmt += tx.shares * tx.price;
      }
    });
    return Object.keys(groups).map(function (code) {
      var g = groups[code];
      g.avgCost = g.holding > 0 ? g.buyAmt / g.holding : (g.lastAvg || 0);
      return g;
    });
  }

  async function fillStockStats(el, stocksPromise) {
    var list = await stocksPromise;
    var txs = (list || []).map(function (r) {
      if (!r.action) { r.action = "buy"; r.price = r.cost; r.date = (r.createdAt || "").slice(0, 10); }
      return { id: r.id, code: r.code || "", name: r.name || r.code || "",
               shares: Number(r.shares || 0), price: Number(r.price || 0),
               type: r.type || "stock", action: r.action || "buy" };
    });
    if (!el.isConnected) return;
    var rows = aggregateStockHoldings(txs).filter(function (g) { return g.holding > 0; });
    if (!rows.length) return;

    var stockRows = rows.filter(function (r) { return r.type !== "fund"; });
    var fundRows = rows.filter(function (r) { return r.type === "fund"; });
    var quoteMap = null, navMap = null;
    var quoted = false;
    if (window.WB.USE_API) {
      if (stockRows.length) quoteMap = await fetchStockQuotes(stockRows.map(function (r) { return r.code; }));
      if (fundRows.length) navMap = await fetchFundNavs(fundRows.map(function (r) { return r.code; }));
      if (!el.isConnected) return;
      if (quoteMap || navMap) quoted = true;
    }
    var all = rows.map(function (g) {
      var q = null;
      if (g.type === "fund") q = navMap ? navMap[g.code] || null : null;
      else q = quoteMap ? quoteMap[g.code] || null : null;
      if (q) quoted = true;
      g.q = q;
      return g;
    });
    var mv = 0, cost = 0, day = 0;
    all.forEach(function (g) {
      cost += g.avgCost * g.holding;
      if (g.q) { mv += g.q.price * g.holding; day += g.q.change * g.holding; }
      else mv += g.avgCost * g.holding;
    });
    var pl = quoted ? mv - cost : 0;
    var mvTxt = quoted ? fmtYuan(mv) : "—";
    var costTxt = fmtYuan(cost);
    var plTxt = quoted ? (pl >= 0 ? "+" : "") + fmtYuan(pl) : "—";
    var dayTxt = quoted ? (day >= 0 ? "+" : "") + fmtYuan(day) : "—";
    var sMv = el.querySelector("#rptStkMv");
    if (sMv) sMv.textContent = mvTxt;
    var sCost = el.querySelector("#rptStkCost");
    if (sCost) sCost.textContent = costTxt;
    var sPl = el.querySelector("#rptStkPl");
    if (sPl) { sPl.textContent = plTxt; sPl.style.color = quoted ? udColor(pl) : "var(--muted)"; }
    var sDay = el.querySelector("#rptStkDay");
    if (sDay) { sDay.textContent = dayTxt; sDay.style.color = quoted ? udColor(day) : "var(--muted)"; }
    var box = el.querySelector("#rptStkRows");
    if (box) {
      box.innerHTML = '<div class="tx-year-wrap"><table class="tx-year-table">' +
        "<thead><tr><th>名称</th><th>类型</th><th>当前持仓</th><th>平均成本</th><th>现价</th><th>市值</th><th>盈亏</th></tr></thead><tbody>" +
        all.map(function (g) {
          var q = g.q, isFund = g.type === "fund";
          var mv2 = q ? q.price * g.holding : 0;
          var pl2 = q ? (q.price - g.avgCost) * g.holding : 0;
          var plPct2 = q && g.avgCost > 0 ? ((q.price - g.avgCost) / g.avgCost) * 100 : 0;
          var day2 = q ? q.change * g.holding : 0;
          var priceTxt = q ? (isFund && q.isMoney ? "1.0000" : isFund ? fmt4(q.price) : fmt2(q.price)) : "—";
          var priceSub = q ? (isFund && q.isMoney ? "万份 " + fmt4(q.pct) : (q.pct >= 0 ? "+" : "") + fmt2(q.pct) + "%") : "";
          return '<tr>' +
            '<td>' + esc(g.name) + '<span class="stk-code">' + esc(g.code) + "</span></td>" +
            '<td>' + (isFund ? "基金" : "股票") + "</td>" +
            '<td>' + (isFund ? fmt2(g.holding) : g.holding) + "</td>" +
            '<td>' + (isFund ? fmt4(g.avgCost) : fmt2(g.avgCost)) + "</td>" +
            '<td style="color:' + (q ? udColor(q.change) : "var(--muted)") + '">' + priceTxt + '<span class="stk-sub">' + priceSub + "</span></td>" +
            '<td>' + (q ? fmt2(mv2) : "—") + "</td>" +
            '<td style="color:' + (q ? udColor(pl2) : "var(--muted)") + '">' + (q ? ((pl2 >= 0 ? "+" : "") + fmt2(pl2) + '<span class="stk-sub">' + (plPct2 >= 0 ? "+" : "") + fmt2(plPct2) + "%</span>") : "—") + "</td>" +
            "</tr>";
        }).join("") + "</tbody></table></div>";
    }
  }

  /** 理财买卖流水月度统计：按月汇总当年买入（流出红）/卖出（流入绿）/净额 */
  async function renderStockFlow(el, year, stocksPromise) {
    var box = el.querySelector("#rptStkFlow");
    if (!box) return;
    var records = await stocksPromise;
    if (!el.isConnected) return;
    var txs = (records || []).map(function (r) {
      var date = (r.date || r.createdAt || "").slice(0, 10) || "";
      return { action: r.action || "buy", shares: Number(r.shares || 0), price: Number(r.price || r.cost || 0), date: date };
    });
    var buyAmt = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var sellAmt = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var hasAny = false;
    txs.forEach(function (tx) {
      if (!tx.date || tx.date.slice(0, 4) !== String(year)) return;
      var m = parseInt(tx.date.slice(5, 7), 10) - 1;
      if (m < 0 || m > 11) return;
      var amt = tx.shares * tx.price;
      if (tx.action === "sell") sellAmt[m] += amt;
      else buyAmt[m] += amt;
      hasAny = true;
    });
    if (!hasAny) {
      box.innerHTML = '<div class="empty">该年度暂无理财交易流水</div>';
      return;
    }
    var rows = "";
    var buyTotal = 0, sellTotal = 0;
    for (var m = 0; m < 12; m++) {
      var b = buyAmt[m], s = sellAmt[m], net = s - b;
      buyTotal += b;
      sellTotal += s;
      var has = b || s;
      rows += '<tr>' +
        '<td>' + (m + 1) + "月</td>" +
        '<td style="color:' + (b ? "var(--danger)" : "inherit") + '">' + (b ? "-" + fmtYuan(b) : "—") + "</td>" +
        '<td style="color:' + (s ? "var(--ok)" : "inherit") + '">' + (s ? "+" + fmtYuan(s) : "—") + "</td>" +
        '<td style="color:' + (net >= 0 ? "var(--ok)" : "var(--danger)") + '">' + (has ? (net >= 0 ? "+" : "") + fmtYuan(net) : "—") + "</td></tr>";
    }
    var netTotal = sellTotal - buyTotal;
    rows += '<tr class="tx-yr-row fw7">' +
      "<td>全年</td>" +
      '<td class="c-danger">-' + fmtYuan(buyTotal) + "</td>" +
      '<td class="c-ok">+' + fmtYuan(sellTotal) + "</td>" +
      '<td style="color:' + (netTotal >= 0 ? "var(--ok)" : "var(--danger)") + '">' + (netTotal >= 0 ? "+" : "") + fmtYuan(netTotal) + "</td></tr>";
    box.innerHTML = '<div class="tx-year-wrap"><table class="tx-year-table">' +
      "<thead><tr><th>月份</th><th>买入</th><th>卖出</th><th>净额</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  function renderFinanceCharts(el, monthlyInc, monthlyExp, catEntries) {
    if (typeof Chart === "undefined") return;
    var muted = cssVar("--muted"), line = cssVar("--line"), ok = cssVar("--ok"), danger = cssVar("--danger"), card = cssVar("--card");
    var barCv = el.querySelector("#rptFinBar");
    if (barCv) {
      var hasBar = false;
      for (var i = 0; i < 12; i++) { if (monthlyInc[i] > 0 || monthlyExp[i] > 0) { hasBar = true; break; } }
      if (hasBar) {
        var labs = [];
        for (var i = 0; i < 12; i++) labs.push((i + 1) + "月");
        charts.push(new Chart(barCv, {
          type: "bar",
          data: { labels: labs, datasets: [
            { label: "收入", data: monthlyInc, backgroundColor: ok, borderRadius: 6 },
            { label: "支出", data: monthlyExp, backgroundColor: danger, borderRadius: 6 },
          ]},
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: "top", labels: { color: muted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, padding: 8 } },
              tooltip: glassTip(function (ctx) { return " " + ctx.dataset.label + " " + fmtYuan(ctx.parsed.y) + " 元"; }),
            },
            scales: {
              x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
              y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 } }, grid: { color: line } },
            },
          },
        }));
      }
    }
    var doughnutCv = el.querySelector("#rptFinDoughnut");
    if (doughnutCv && catEntries.length > 0) {
      var total = 0;
      for (var i = 0; i < catEntries.length; i++) total += catEntries[i][1];
      charts.push(new Chart(doughnutCv, {
        type: "doughnut",
        data: {
          labels: catEntries.map(function (e) { return catName(e[0]); }),
          datasets: [{
            data: catEntries.map(function (e) { return e[1]; }),
            backgroundColor: catEntries.map(function (e) { return catColor(e[0]); }),
            borderColor: card, borderWidth: 2,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: "58%",
          plugins: {
            legend: { position: "bottom", labels: { color: muted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, padding: 12, usePointStyle: true, pointStyle: "circle" } },
            tooltip: glassTip(function (ctx) { return " " + ctx.label + "  " + fmtYuan(ctx.parsed) + " 元  (" + ((ctx.parsed / total) * 100).toFixed(1) + "%)"; }),
          },
        },
      }));
    }
  }
  // ========== 习惯面板 ==========
  function renderHabitsPanel(el, habits) {
    var today = todayStr();
    var total = habits.length;
    var todayCheckins = 0;
    var thirtyDays = lastDays(30);
    var fourteenDays = lastDays(14);
    var totalRate = 0;
    var maxStreak = 0;

    habits.forEach(function (h) {
      var ck = h.checkins || {};
      if (ck[today]) todayCheckins++;
      var cnt = 0;
      for (var i = 0; i < 30; i++) { if (ck[thirtyDays[i]]) cnt++; }
      totalRate += cnt / 30;
      var s = streakOf(h);
      if (s > maxStreak) maxStreak = s;
    });
    var avgRate = total > 0 ? Math.round((totalRate / total) * 100) : 0;

    // 14 天每日打卡总数
    var dailyCounts = [];
    for (var i = 0; i < 14; i++) {
      var cnt = 0;
      for (var j = 0; j < total; j++) {
        if (habits[j].checkins && habits[j].checkins[fourteenDays[i]]) cnt++;
      }
      dailyCounts.push(cnt);
    }

    var habitRows = total > 0
      ? habits.map(function (h) {
          var ck = h.checkins || {};
          var totalDays = 0;
          Object.keys(ck).forEach(function (k) { if (ck[k]) totalDays++; });
          var thirtyCnt = 0;
          for (var i = 0; i < 30; i++) { if (ck[thirtyDays[i]]) thirtyCnt++; }
          var ratePct = Math.round((thirtyCnt / 30) * 100);
          var s = streakOf(h);
          return '<div class="item sp-b-sm">' +
            '<span class="pri-dot" style="background:' + esc(h.color) + '"></span>' +
            '<span class="txt fx1">' + esc(h.name) +
            '<div class="sub sp-t-xs">总打卡 ' + totalDays + ' 天 · 连续 ' + s + ' 天</div>' +
            '<div class="hp-row">' +
            '<div class="hp-bar"><div class="hp-bar-fill" style="width:' + ratePct + '%;background:' + esc(h.color) + '"></div></div>' +
            '<span class="hp-pct">' + ratePct + '%</span></div></span></div>';
        }).join("")
      : '<div class="empty">暂无习惯数据</div>';

    el.innerHTML = '<div class="reports-tab-content">' +
      '<div class="stat-grid sp-b-3x">' +
      '<div class="stat"><div class="s-lab">习惯总数</div><div class="s-val">' + total + '</div></div>' +
      '<div class="stat"><div class="s-lab">今日打卡</div><div class="s-val c-ok">' + todayCheckins + '</div><div class="s-sub">' + (total > 0 ? Math.round(todayCheckins / total * 100) + "%" : "0%") + "</div></div>" +
      '<div class="stat"><div class="s-lab">30 天人均打卡率</div><div class="s-val">' + avgRate + '%</div></div>' +
      '<div class="stat"><div class="s-lab">连续最长</div><div class="s-val c-accent">' + maxStreak + '</div><div class="s-sub">天</div></div>' +
      "</div>" +
      '<div class="chart-box sp-b-3x">' +
      '<div class="chart-tt">近 14 天每日打卡总数</div><canvas id="rptHabitBar" height="160"></canvas></div>' +
      '<div class="card"><h2>习惯详情</h2>' + habitRows + "</div></div>";

    if (typeof Chart !== "undefined") {
      var muted = cssVar("--muted"), line = cssVar("--line"), accent = cssVar("--accent");
      var cv = el.querySelector("#rptHabitBar");
      if (cv) {
        var hasData = false;
        for (var i = 0; i < dailyCounts.length; i++) { if (dailyCounts[i] > 0) { hasData = true; break; } }
        if (hasData) {
          var labs = fourteenDays.map(function (ds) { return ds.slice(5); });
          charts.push(new Chart(cv, {
            type: "bar",
            data: { labels: labs, datasets: [{ label: "打卡数", data: dailyCounts, backgroundColor: accent, borderRadius: 6 }] },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: glassTip(function (ctx) { return " " + ctx.parsed.y + " 次打卡"; })},
              scales: {
                x: { ticks: { color: muted, font: { size: 10 }, maxTicksLimit: 14 }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 }, precision: 0 }, grid: { color: line } },
              },
            },
          }));
        }
      }
    }
  }
  // ========== 健康面板 ==========
  function renderHealthPanel(el, records) {
    var METRICS = [
      { key: "weight", label: "体重", unit: "kg", varname: "--accent", type: "line" },
      { key: "run", label: "跑步", unit: "km", varname: "--ok", type: "bar" },
      { key: "sleep", label: "睡眠", unit: "h", varname: "--purple", type: "line" },
    ];

    var days = lastDays(30);
    var dayLabs = days.map(function (ds) { return ds.slice(5); });

    var chartsHtml = METRICS.map(function (m) {
      var data = records.filter(function (r) { return r.metric === m.key; });
      var vals = data.map(function (r) { return Number(r.value); });
      var latest = vals.length > 0 ? vals[vals.length - 1] : null;
      var avg = vals.length > 0 ? (vals.reduce(function (s, v) { return s + v; }, 0) / vals.length) : null;
      var maxVal = vals.length > 0 ? Math.max.apply(null, vals) : null;

      var metaHtml = vals.length > 0
        ? '<div class="reports-health-meta">' +
          '<div class="reports-health-meta-item">最新<div class="reports-health-meta-val">' + latest + '</div></div>' +
          '<div class="reports-health-meta-item">平均<div class="reports-health-meta-val">' + (avg !== null ? avg.toFixed(1) : "—") + '</div></div>' +
          '<div class="reports-health-meta-item">最大<div class="reports-health-meta-val">' + maxVal + '</div></div></div>'
        : '<div class="empty" style="padding:12px 0">暂无记录</div>';
      return '<div class="chart-box">' +
        '<div class="chart-tt">' + m.label + "（" + m.unit + "）</div>" +
        '<canvas id="rptHealth_' + m.key + '" height="150"></canvas>' +
        metaHtml + "</div>";
    }).join("");

    el.innerHTML = '<div class="reports-tab-content">' +
      '<div class="chart-grid">' + chartsHtml + "</div></div>";

    // 渲染图表
    if (typeof Chart !== "undefined") {
      var muted = cssVar("--muted"), line = cssVar("--line");
      METRICS.forEach(function (m) {
        var cv = el.querySelector("#rptHealth_" + m.key);
        if (!cv) return;
        var byDate = {};
        records.filter(function (r) { return r.metric === m.key; }).forEach(function (r) { byDate[r.date] = Number(r.value); });
        var data = days.map(function (ds) { return byDate[ds] !== undefined ? byDate[ds] : null; });
        var hasData = false;
        for (var i = 0; i < data.length; i++) { if (data[i] !== null) { hasData = true; break; } }
        if (!hasData) return;
        var color = cssVar(m.varname);
        var isBar = m.type === "bar";
        charts.push(new Chart(cv, {
          type: isBar ? "bar" : "line",
          data: { labels: dayLabs, datasets: [{ data: data, borderColor: color, backgroundColor: color, tension: isBar ? 0 : 0.35, pointRadius: isBar ? 0 : 2.5, spanGaps: !isBar }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: muted, font: { size: 10 }, maxTicksLimit: 10 }, grid: { display: false } },
              y: { beginAtZero: m.key !== "weight", ticks: { color: muted, font: { size: 10 } }, grid: { color: line } },
            },
          },
        }));
      });
    }
  }
  // ========== 任务面板 ==========
  function renderTasksPanel(el, tasks) {
    var today = todayStr();
    var total = tasks.length;
    var done = tasks.filter(function (t) { return t.done; });
    var active = tasks.filter(function (t) { return !t.done; });
    var overdue = tasks.filter(function (t) { return !t.done && t.dueDate && t.dueDate < today; });
    var doneCount = done.length;
    var activeCount = active.length;
    var overdueCount = overdue.length;

    // 近 30 天每日完成数
    var thirtyDays = lastDays(30);
    var dailyDone = thirtyDays.map(function (ds) {
      return done.filter(function (t) { return (t.doneAt || "").slice(0, 10) === ds; }).length;
    });

    // 优先级分布
    var priKeys = ["high", "mid", "low"];
    var priLabels = { high: "高优先级", mid: "中优先级", low: "低优先级" };
    var priColors = { high: "var(--danger)", mid: "var(--warn)", low: "var(--accent)" };
    var priCards = priKeys.map(function (k) {
      var all = tasks.filter(function (t) { return t.priority === k; });
      var doneP = tasks.filter(function (t) { return t.priority === k && t.done; });
      var pct = all.length > 0 ? Math.round(doneP.length / all.length * 100) : 0;
      return '<div class="reports-pri-card">' +
        '<div class="reports-pri-label" style="color:' + priColors[k] + '">' + priLabels[k] + "</div>" +
        '<div class="reports-pri-num">' + all.length + "</div>" +
        '<div class="reports-pri-sub">已完成 ' + doneP.length + " / " + pct + "%</div></div>";
    }).join("");

    el.innerHTML = '<div class="reports-tab-content">' +
      '<div class="stat-grid sp-b-3x">' +
      '<div class="stat"><div class="s-lab">总任务</div><div class="s-val">' + total + "</div></div>" +
      '<div class="stat"><div class="s-lab">已完成</div><div class="s-val c-ok">' + doneCount + '</div><div class="s-sub">' + (total > 0 ? Math.round(doneCount / total * 100) + "%" : "0%") + "</div></div>" +
      '<div class="stat"><div class="s-lab">进行中</div><div class="s-val c-accent">' + activeCount + "</div></div>" +
      '<div class="stat"><div class="s-lab">逾期未完成</div><div class="s-val" style="color:' + (overdueCount > 0 ? "var(--danger)" : "var(--ok)") + '">' + overdueCount + "</div></div>" +
      "</div>" +
      '<div class="chart-box sp-b-3x">' +
      '<div class="chart-tt">近 30 天每日完成数</div><canvas id="rptTaskLine" height="160"></canvas></div>' +
      '<div class="card"><h2>优先级分布</h2>' +
      '<div class="reports-pri-grid">' + priCards + "</div></div></div>";

    if (typeof Chart !== "undefined") {
      var muted = cssVar("--muted"), line = cssVar("--line"), ok = cssVar("--ok");
      var cv = el.querySelector("#rptTaskLine");
      if (cv) {
        var hasData = false;
        for (var i = 0; i < dailyDone.length; i++) { if (dailyDone[i] > 0) { hasData = true; break; } }
        if (hasData) {
          var labs = thirtyDays.map(function (ds) { return ds.slice(5); });
          charts.push(new Chart(cv, {
            type: "line",
            data: { labels: labs, datasets: [{ data: dailyDone, borderColor: ok, backgroundColor: ok, tension: 0.35, pointRadius: 2.5, fill: false }] },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { color: muted, font: { size: 10 }, maxTicksLimit: 10 }, grid: { display: false } },
                y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 }, precision: 0 }, grid: { color: line } },
              },
            },
          }));
        }
      }
    }
  }

  // ========== AI 月报 ==========
  /** 把四类数据聚合成"当月 + 上月"的可读摘要，作为 prompt 输入 */
  function buildMonthDigest(finance, habits, health, tasks, ymKey) {
    const monthTx = finance.filter((t) => (t.date || "").slice(0, 7) === ymKey);
    const lastY = Number(ymKey.slice(0, 4));
    const lastM = Number(ymKey.slice(5, 7));
    const prevDate = new Date(lastY, lastM - 2, 1);
    const prevKey = prevDate.getFullYear() + "-" + String(prevDate.getMonth() + 1).padStart(2, "0");
    const prevTx = finance.filter((t) => (t.date || "").slice(0, 7) === prevKey);
    const sum = (arr, type) => arr.filter((t) => t.type === type).reduce((s, t) => s + Number(t.amount || 0), 0);
    const inc = sum(monthTx, "income"), exp = sum(monthTx, "expense"), sav = sum(monthTx, "saving");
    const pInc = sum(prevTx, "income"), pExp = sum(prevTx, "expense"), pSav = sum(prevTx, "saving");
    // 分类 top 3（支出）
    const catMap = {};
    monthTx.filter((t) => t.type === "expense").forEach((t) => { catMap[t.category || "other-e"] = (catMap[t.category || "other-e"] || 0) + Number(t.amount || 0); });
    const topCats = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v.toFixed(0)}`).join(", ");
    // 习惯：当前月打卡总数
    let checkinTotal = 0, habitCount = habits.length;
    habits.forEach((h) => {
      if (!h.checkins) return;
      Object.keys(h.checkins).forEach((d) => { if (d.slice(0, 7) === ymKey) checkinTotal++; });
    });
    // 任务：当月完成 / 新建
    const done = tasks.filter((t) => t.done && t.doneAt && t.doneAt.slice(0, 7) === ymKey).length;
    const created = tasks.filter((t) => (t.createdAt || "").slice(0, 7) === ymKey).length;
    // 健康：取近 30 天体重/步数均值（如有）
    const hs = health.filter((h) => h.date && h.date.slice(0, 7) === ymKey);
    const weights = hs.map((h) => Number(h.weight || 0)).filter((n) => n > 0);
    const steps = hs.map((h) => Number(h.steps || 0)).filter((n) => n > 0);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    return {
      ymKey, prevKey,
      inc, exp, sav, pInc, pExp, pSav,
      topCats, habitCount, checkinTotal, done, created,
      avgWeight: avg(weights).toFixed(1), avgSteps: Math.round(avg(steps)),
    };
  }

  /** 渲染 AI 月报 tab 面板：状态机 (未配置 / 无数据 / 加载中 / 已生成) */
  async function renderAiReportPanel(panel, sets) {
    const st = await ai.status();
    if (!st.configured) {
      panel.innerHTML = '<div class="card"><div class="empty">未配置 AI（智谱 API key）。请在服务器 .env 或 zhipu.key 写入 ZHIPU_API_KEY 后重启服务。</div></div>';
      return;
    }
    const now = new Date();
    const ymKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const digest = buildMonthDigest(sets.finance, sets.habits, sets.health, sets.tasks, ymKey);
    if (digest.inc === 0 && digest.exp === 0 && digest.habitCount === 0 && digest.done === 0 && sets.health.length === 0) {
      panel.innerHTML = '<div class="card"><div class="empty">' + ymKey + ' 暂无可汇总数据</div></div>';
      return;
    }
    const cache = (await getSetting("aiMonthlyReport", null)) || {};
    const cached = cache[ymKey] || null;
    panel.innerHTML = '<div class="card">' +
      '<h2>✨ AI 月报<span class="count">' + ymKey + ' · 由智谱生成</span></h2>' +
      '<div class="rpt-ai-grid">' +
        '<div class="rpt-ai-kpi"><div class="lab">本月收入</div><div class="val" style="color:var(--ok)">+' + fmtYuan(digest.inc) + '</div><div class="sub">较上月 ' + (digest.pInc ? (digest.inc >= digest.pInc ? '+' : '') + ((digest.inc - digest.pInc) / digest.pInc * 100).toFixed(1) + '%' : '—') + '</div></div>' +
        '<div class="rpt-ai-kpi"><div class="lab">本月支出</div><div class="val" style="color:var(--danger)">-' + fmtYuan(digest.exp) + '</div><div class="sub">较上月 ' + (digest.pExp ? (digest.exp >= digest.pExp ? '+' : '') + ((digest.exp - digest.pExp) / digest.pExp * 100).toFixed(1) + '%' : '—') + '</div></div>' +
        '<div class="rpt-ai-kpi"><div class="lab">本月储蓄</div><div class="val">+' + fmtYuan(digest.sav) + '</div><div class="sub">结余 ' + fmtYuan(digest.inc - digest.exp) + '</div></div>' +
        '<div class="rpt-ai-kpi"><div class="lab">任务完成</div><div class="val">' + digest.done + ' / ' + digest.created + '</div><div class="sub">习惯打卡 ' + digest.checkinTotal + ' 次</div></div>' +
      '</div>' +
      '<div class="rpt-ai-top">支出 Top 分类：' + (digest.topCats || '—') + '</div>' +
      '<div id="rptAiBody">' + (cached ? '<div class="ai-panel">' + MD.render(cached.text) + '</div>' : '') + '</div>' +
      '<div class="row sp-t-md">' +
        '<button class="btn" id="rptAiGen">' + (cached ? '重新生成' : '✨ 生成月报') + '</button>' +
        (cached ? '<span class="rpt-ai-meta">生成于 ' + esc(cached.at || '') + '</span>' : '') +
      '</div></div>';
    const genBtn = panel.querySelector("#rptAiGen");
    if (genBtn) {
      genBtn.addEventListener("click", async () => {
        const body = panel.querySelector("#rptAiBody");
        body.innerHTML = '<div class="ai-loading">AI 正在生成月报，请稍候…</div>';
        genBtn.disabled = true;
        try {
          const sys = "你是个人效率助理，帮用户写一份简洁的中文月度复盘。基于用户提供的当月和上月数据，给出 4-6 条要点（财务/任务/习惯/健康各 1-2 条），不夸大、不奉承，能指出明显问题（如某分类暴涨、打卡骤降）。输出使用 markdown 列表，每条不超过 60 字。不要寒暄。";
          const prompt = "当月：" + ymKey + "\n上月：" + digest.prevKey + "\n\n当月数据：\n- 收入 " + digest.inc + " 元 / 支出 " + digest.exp + " 元 / 储蓄 " + digest.sav + " 元\n- 结余 " + (digest.inc - digest.exp) + " 元\n- 支出分类 Top: " + (digest.topCats || "无") + "\n- 任务完成 " + digest.done + " / 新建 " + digest.created + "\n- 习惯 " + digest.habitCount + " 个 / 打卡 " + digest.checkinTotal + " 次\n- 平均体重 " + digest.avgWeight + " kg / 日均步数 " + digest.avgSteps + "\n\n上月数据：\n- 收入 " + digest.pInc + " 元 / 支出 " + digest.pExp + " 元 / 储蓄 " + digest.pSav + " 元";
          const text = await ai.chat(sys, prompt, 0.5);
          const cache2 = (await getSetting("aiMonthlyReport", null)) || {};
          cache2[ymKey] = { text, at: new Date().toLocaleString("zh-CN") };
          await setSetting("aiMonthlyReport", cache2);
          body.innerHTML = '<div class="ai-panel">' + MD.render(text) + '</div>';
          // 刷新按钮文案
          genBtn.textContent = "重新生成";
          // 补时间戳
          const meta = panel.querySelector(".rpt-ai-meta") || document.createElement("span");
          meta.className = "rpt-ai-meta";
          meta.textContent = "生成于 " + cache2[ymKey].at;
          if (!panel.querySelector(".rpt-ai-meta")) genBtn.parentNode.appendChild(meta);
        } catch (e) {
          body.innerHTML = '<div class="empty" style="color:var(--danger)">AI 生成失败：' + esc(e.message) + '</div>';
        } finally {
          genBtn.disabled = false;
        }
      });
    }
  }

  // ========== 年度报告：聚合当年全部业务数据的人生年报 ==========
  let annualYear = new Date().getFullYear();

  function renderAnnualPanel(panel, ctx) {
    var finance = ctx.finance, habits = ctx.habits, tasks = ctx.tasks, notes = ctx.notes;
    var media = ctx.media || [], timeline = ctx.timeline || [], stocks = ctx.stocks || [], bookmarks = ctx.bookmarks || [];
    var now = new Date();
    // 年份候选：出现在任一数据源里的年份（倒序）
    var ySet = new Set([String(now.getFullYear())]);
    finance.forEach(function (r) { if (r.date) ySet.add(r.date.slice(0, 4)); });
    tasks.forEach(function (t) {
      if (t.doneAt) ySet.add(t.doneAt.slice(0, 4));
      if (t.createdAt) ySet.add(t.createdAt.slice(0, 4));
    });
    timeline.forEach(function (e) { if (e.date) ySet.add(e.date.slice(0, 4)); });
    var years = Array.from(ySet).filter(function (y) { return y >= "1990"; }).sort(function (a, b) { return b.localeCompare(a); });
    var y = String(annualYear);
    var inYear = function (d) { return (d || "").slice(0, 4) === y; };

    var yTx = finance.filter(function (r) { return inYear(r.date); });
    var inc = yTx.filter(function (r) { return r.type === "income"; }).reduce(function (s, r) { return s + Number(r.amount || 0); }, 0);
    var exp = yTx.filter(function (r) { return r.type === "expense"; }).reduce(function (s, r) { return s + Number(r.amount || 0); }, 0);
    var sav = yTx.filter(function (r) { return r.type === "saving"; }).reduce(function (s, r) { return s + Number(r.amount || 0); }, 0);
    var done = tasks.filter(function (t) { return t.done && inYear(t.doneAt); }).length;
    var created = tasks.filter(function (t) { return inYear((t.createdAt || "").slice(0, 10)); }).length;
    var checkins = 0;
    habits.forEach(function (h) {
      Object.keys(h.checkins || {}).forEach(function (ds) { if (inYear(ds) && h.checkins[ds]) checkins++; });
    });
    var healthN = ctx.health.filter(function (r) { return inYear(r.date); }).length;
    var noteN = notes.filter(function (n) { return inYear((n.createdAt || "").slice(0, 10)); }).length;
    var bmN = bookmarks.filter(function (b) { return inYear((b.createdAt || "").slice(0, 10)); }).length;
    var mediaN = media.filter(function (m) { return m.status === "done" && inYear(m.finishedAt); }).length;
    var tlN = timeline.filter(function (e) { return inYear(e.date); }).length;
    var stk = stocks.filter(function (s) { return inYear((s.date || s.createdAt || "").slice(0, 10)); });
    var buy = stk.filter(function (s) { return s.action !== "sell"; }).reduce(function (s, t) { return s + Number(t.shares || 0) * Number(t.action ? t.price : t.cost || 0); }, 0);
    var sell = stk.filter(function (s) { return s.action === "sell"; }).reduce(function (s, t) { return s + Number(t.shares || 0) * Number(t.price || 0); }, 0);

    // 12 个月收支（图表用）
    var mInc = [], mExp = [];
    for (var m = 0; m < 12; m++) {
      var mk = y + "-" + String(m + 1).padStart(2, "0");
      mInc.push(yTx.filter(function (r) { return r.type === "income" && (r.date || "").slice(0, 7) === mk; }).reduce(function (s, r) { return s + Number(r.amount || 0); }, 0));
      mExp.push(yTx.filter(function (r) { return r.type === "expense" && (r.date || "").slice(0, 7) === mk; }).reduce(function (s, r) { return s + Number(r.amount || 0); }, 0));
    }

    panel.innerHTML = '<div class="card">' +
      '<h2>📖 年度报告<span class="count">' + y + ' 年 · 人生年报</span></h2>' +
      '<div class="row sp-b-md"><select id="rptAnnualYear">' +
        years.map(function (yy) { return '<option value="' + yy + '"' + (yy === y ? " selected" : "") + '>' + yy + ' 年</option>'; }).join("") +
      '</select></div>' +
      '<div class="stat-grid">' +
        '<div class="stat"><div class="s-lab">全年收入</div><div class="s-val" style="color:var(--ok)">+' + fmtYuan(inc) + '</div><div class="s-sub">' + yTx.filter(function (r) { return r.type === "income"; }).length + ' 笔</div></div>' +
        '<div class="stat"><div class="s-lab">全年支出</div><div class="s-val" style="color:var(--danger)">-' + fmtYuan(exp) + '</div><div class="s-sub">' + yTx.filter(function (r) { return r.type === "expense"; }).length + ' 笔</div></div>' +
        '<div class="stat"><div class="s-lab">年度结余</div><div class="s-val">' + (inc - exp >= 0 ? "+" : "") + fmtYuan(inc - exp) + '</div><div class="s-sub">储蓄新增 ' + fmtYuan(sav) + '</div></div>' +
        '<div class="stat"><div class="s-lab">理财买卖</div><div class="s-val">' + fmtYuan(buy) + '</div><div class="s-sub">买入 / 卖出 ' + fmtYuan(sell) + ' · 净投入 ' + fmtYuan(buy - sell) + '</div></div>' +
        '<div class="stat"><div class="s-lab">任务完成</div><div class="s-val">' + done + '</div><div class="s-sub">新建 ' + created + ' 个</div></div>' +
        '<div class="stat"><div class="s-lab">习惯打卡</div><div class="s-val">' + checkins + '</div><div class="s-sub">' + habits.length + ' 个习惯</div></div>' +
        '<div class="stat"><div class="s-lab">健康记录</div><div class="s-val">' + healthN + '</div><div class="s-sub">体重/步数等</div></div>' +
        '<div class="stat"><div class="s-lab">笔记沉淀</div><div class="s-val">' + noteN + '</div><div class="s-sub">收藏 ' + bmN + ' 条</div></div>' +
        '<div class="stat"><div class="s-lab">书影音</div><div class="s-val">' + mediaN + '</div><div class="s-sub">看完/读完</div></div>' +
        '<div class="stat"><div class="s-lab">人生大事</div><div class="s-val">' + tlN + '</div><div class="s-sub">时间轴事件</div></div>' +
      '</div>' +
      '<div class="chart-box sp-t-md"><div class="chart-tt">' + y + ' 年各月收入 / 支出（元）</div><canvas id="chartAnnual" height="160"></canvas></div>' +
      '<div id="annualAi"></div>' +
      '<div class="row sp-t-md"><button class="btn" id="annualGen">✨ 生成 AI 年度总结</button></div>' +
      '</div>';

    // 月度柱状图
    var cvs = panel.querySelector("#chartAnnual");
    if (cvs && window.Chart) {
      charts.push(new Chart(cvs, {
        type: "bar",
        data: {
          labels: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
          datasets: [
            { label: "收入", data: mInc, backgroundColor: cssVar("--ok") || "#5a9e6f", borderRadius: 3 },
            { label: "支出", data: mExp, backgroundColor: cssVar("--danger") || "#c96a5f", borderRadius: 3 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          plugins: { legend: { position: "bottom" } },
        },
      }));
    }

    // 年份切换：只重渲染本面板
    var yearSel = panel.querySelector("#rptAnnualYear");
    if (yearSel) {
      yearSel.addEventListener("change", function (e) {
        annualYear = Number(e.target.value);
        for (var i = 0; i < charts.length; i++) { try { charts[i].destroy(); } catch (err) {} }
        charts = [];
        renderAnnualPanel(panel, ctx);
      });
    }

    // AI 年度总结（只分析不写数据；按年缓存在 settings.annualAi）
    var genBtn = panel.querySelector("#annualGen");
    if (genBtn) {
      (async function () {
        var cache = (await getSetting("annualAi", null)) || {};
        var cached = cache[y];
        var body = panel.querySelector("#annualAi");
        if (cached && body) body.innerHTML = '<div class="ai-panel">' + MD.render(cached.text) + "</div>";
        genBtn.addEventListener("click", async function () {
          var body2 = panel.querySelector("#annualAi");
          body2.innerHTML = '<div class="ai-loading">AI 正在写年度总结，请稍候…</div>';
          genBtn.disabled = true;
          try {
            var sys = "你是个人效率助理，为用户写一份简洁温暖的中文年度总结。基于提供的全年数据，分 3-5 个方面（财务/任务/习惯/生活记录）各给 1-2 句，肯定坚持、点出可改进处，不夸大不奉承。markdown 列表输出，总长 300 字内，不要寒暄。";
            var prompt = y + " 年全年数据：\n- 收入 " + Math.round(inc) + " 元 / 支出 " + Math.round(exp) + " 元 / 结余 " + Math.round(inc - exp) + " 元\n- 储蓄新增 " + Math.round(sav) + " 元；理财买入 " + Math.round(buy) + " 元 / 卖出 " + Math.round(sell) + " 元\n- 任务完成 " + done + " 个（新建 " + created + "）\n- 习惯打卡 " + checkins + " 次（" + habits.length + " 个习惯）\n- 健康记录 " + healthN + " 条 / 笔记 " + noteN + " 篇 / 收藏 " + bmN + " 条 / 书影音 " + mediaN + " 部\n- 人生大事 " + tlN + " 件";
            var text = await ai.chat(sys, prompt, 0.6);
            var cache2 = (await getSetting("annualAi", null)) || {};
            cache2[y] = { text: text, at: new Date().toLocaleString("zh-CN") };
            await setSetting("annualAi", cache2);
            body2.innerHTML = '<div class="ai-panel">' + MD.render(text) + "</div>";
          } catch (e) {
            body2.innerHTML = '<div class="empty" style="color:var(--danger)">AI 生成失败：' + esc(e.message) + "</div>";
          } finally {
            genBtn.disabled = false;
          }
        });
      })();
    }
  }

  // ========== 主渲染 ==========
  routes.reports = {
    title: "数据统计",
    async render(el) {
      var data = await Promise.all([
        financeRepo.list(),
        habitsRepo.list(),
        healthRepo.list(),
        tasksRepo.list(),
        window.WB.getSettings ? window.WB.getSettings({ finCategories: { income: [], expense: [] } }) : Promise.resolve({ finCategories: { income: [], expense: [] } }),
        repo("notes").list().catch(function () { return []; }),
        repo("media").list().catch(function () { return []; }),
        repo("timeline").list().catch(function () { return []; }),
        repo("bookmarks").list().catch(function () { return []; }),
        repo("stocks").list().catch(function () { return []; }),
      ]);
      // #view 常驻文档、isConnected 恒为 true；校验 hash 防止慢请求覆写已切走的页面
      if (location.hash !== "#/reports") return;
      var finance = data[0], habits = data[1], health = data[2], tasks = data[3];
      // 自定义分类（Excel 导入/手动新建）：合并进 catName/catColor，否则图例显示原始 ID
      var finCats = (data[4] && data[4].finCategories) || { income: [], expense: [] };
      extraCatName = {}; extraCatColor = {};
      (finCats.income || []).concat(finCats.expense || []).forEach(function (c) {
        if (c && c.id) { extraCatName[c.id] = c.name || c.id; extraCatColor[c.id] = c.color || "#A5A29A"; }
      });

      // 销毁旧图表
      for (var i = 0; i < charts.length; i++) { try { charts[i].destroy(); } catch (e) {} }
      charts = [];

      // 读取保存的 tab 状态
      reportTab = reportTab || "finance";

      var tabs = [
        { k: "finance", label: "记账" },
        { k: "habits", label: "习惯" },
        { k: "health", label: "健康" },
        { k: "tasks", label: "任务" },
        { k: "annual", label: "📖 年度" },
        { k: "ai", label: "✨ AI 月报" },
      ];
      var tabHtml = tabs.map(function (t) {
        return '<button class="tab' + (t.k === reportTab ? " on" : "") + '" data-rpt-tab="' + t.k + '">' + t.label + "</button>";
      }).join("");

      el.innerHTML = '<div class="card">' +
        '<h2>数据统计报表</h2>' +
        '<div class="tabs" id="rptTabs">' + tabHtml + "</div></div>" +
        '<div id="rptPanel"></div>';

      var panel = el.querySelector("#rptPanel");
      if (!panel) return;

      if (reportTab === "finance") renderFinancePanel(panel, finance);
      else if (reportTab === "habits") renderHabitsPanel(panel, habits);
      else if (reportTab === "health") renderHealthPanel(panel, health);
      else if (reportTab === "tasks") renderTasksPanel(panel, tasks);
      else if (reportTab === "annual") renderAnnualPanel(panel, { finance: finance, habits: habits, health: health, tasks: tasks, notes: data[5], media: data[6], timeline: data[7], bookmarks: data[8], stocks: data[9] });
      else if (reportTab === "ai") renderAiReportPanel(panel, { finance: finance, habits: habits, health: health, tasks: tasks });

      // Tab 切换事件
      var tabContainer = el.querySelector("#rptTabs");
      if (tabContainer) {
        tabContainer.addEventListener("click", function (e) {
          var btn = e.target.closest("[data-rpt-tab]");
          if (!btn) return;
          var tab = btn.dataset.rptTab;
          if (tab === reportTab) return;
          reportTab = tab;
          routes.reports.render(el);
        });
      }

      // 记账年份切换
      var yearSel = el.querySelector("#rptYear");
      if (yearSel) {
        yearSel.addEventListener("change", function (e) {
          reportYear = Number(e.target.value);
          if (!el.isConnected) return;
          // 只重渲染记账面板
          var panel = el.querySelector("#rptPanel");
          if (panel && reportTab === "finance") {
            // 销毁旧图表
            for (var i = 0; i < charts.length; i++) { try { charts[i].destroy(); } catch (e) {} }
            charts = [];
            renderFinancePanel(panel, finance);
          }
        });
      }
    },
  };
})();
