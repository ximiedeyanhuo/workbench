/**
 * stocks.js — 股票 & 理财：A 股持仓 + 公募基金（理财）交易流水，实时行情盈亏
 *
 * 功能：
 * - 两个 tab：股票 / 理财（基金）。数据同存 stocks store，理财记录带 type:"fund"
 * - 流水模型：每条记录 = 一笔交易（买入/卖出，带成交日期 date），当前持仓从流水实时聚合
 * - 股票：搜索（代码/名称/拼音，腾讯 smartbox 经后端代理）选中标的，录入数量 + 价格 + 日期；
 *   同一标的可多条买入/卖出记录；行情 qt.gtimg.cn 经 /api/stock/quote 批量代理
 * - 理财：搜索公募基金（天天基金经后端代理），录入买入金额 + 成本净值（元/份），份额=金额÷净值；
 *   净值天天基金 /api/fund/nav（东方财富）逐日更新，当日收益 = 净值差 × 份额
 * - 持仓表：按 code 聚合（数量=Σ买-Σ卖，平均成本=Σ买额/Σ买量），现价(净值)/今日涨跌/市值/盈亏
 * - 交易流水表：全部买入/卖出明细，可删除单笔；持仓表操作=清仓（删该标的全部流水）
 * - 顶部汇总：总市值 / 总成本 / 持仓盈亏 / 今日盈亏
 * - 页面停留时每 30 秒自动刷新（离开页面自动暂停）
 * - 本地离线模式无行情（代理在服务端），仍可记流水，行情列显示 —
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, debounce, flashInvalid, todayStr } = window.WB;
  const stocksRepo = repo("stocks");

  let stkSel = null;      // 搜索下拉选中的标的 {code, name}
  let stkTimer = null;    // 30s 自动刷新句柄
  let stkTab = "stock";   // "stock" | "fund"
  let stkSeq = 0;         // render 代数：防止慢请求/自动刷新回写覆盖用户刚切到的 tab
  let stkDocHandler = null; // 文档点击隐藏搜索建议的处理器，避免重复绑定
  const REFRESH_MS = 30 * 1000;

  const fmt2 = (n) => Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt4 = (n) => Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const signed2 = (n) => (n > 0.005 ? "+" + fmt2(n) : n < -0.005 ? "-" + fmt2(-n) : "0.00");
  /** A 股惯例：涨红跌绿（--rise=红/涨，--fall=绿/跌） */
  const udColor = (n) => (n > 0.005 ? "var(--rise)" : n < -0.005 ? "var(--fall)" : "var(--muted)");

  /** 归一化单笔流水（含旧快照迁移）：
   *  旧快照（无 action）视为一次买入，成交价=原成本，日期取 createdAt 日期部分（无效则今天） */
  function normalizeTx(r) {
    if (!r.action) {
      r.action = "buy";
      r.price = r.cost;
      r.date = (r.createdAt || "").slice(0, 10) || todayStr();
    }
    return {
      id: r.id,
      code: r.code || "",
      name: r.name || r.code || "",
      shares: Number(r.shares || 0),
      price: Number(r.price || 0),
      type: r.type || "stock",
      action: r.action || "buy",
      date: r.date || "",
      createdAt: r.createdAt || "",
      updatedAt: r.updatedAt || "",
    };
  }

  /** 按 code 聚合流水为持仓组：唯一实现在 db.js 的 WB.aggregateStocks（先按日期排序，
   *  补录历史交易顺序正确；卖出量钳制到持仓，卖超不再虚计利润）。此处保留函数名做委托，
   *  页内 buyList/sellList 字段仍由公共实现提供 */
  function aggregateHoldings(txs) {
    return window.WB.aggregateStocks(txs);
  }

  function nowStamp() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /** 是否仍在股票页：路由共用 #view 容器，document.body.contains(el) 永远为真，
   *  必须用路由态判断，否则定时器会在其他页把股票内容渲染进去覆盖当前页 */
  function stillHere() {
    return /^#\/stocks/.test(location.hash || "");
  }

  /** 股票批量行情，失败返回 null（页面降级显示 —） */
  async function fetchStockQuotes(codes) {
    if (!window.WB.USE_API || !codes.length) return null;
    try {
      const res = await WB.rawApi("/api/stock/quote?codes=" + encodeURIComponent(codes.join(",")));
      if (!res.ok) return null;
      const list = await res.json();
      const map = {};
      list.forEach((q) => { map[q.code] = q; });
      return map;
    } catch (e) {
      return null;
    }
  }

  /** 基金（理财）批量净值：/api/fund/nav → 归一化成与股票行情同构的 {code,name,price,change,pct,time}
   *  货币基金（isMoney）口径：净值恒 1，当日收益 = 每万份收益 × 份额 / 10000，
   *  change 记成「每份当日收益」，市值按份额 × 1 计算；pct 字段改存万份收益供展示 */
  async function fetchFundNavs(codes) {
    if (!window.WB.USE_API || !codes.length) return null;
    try {
      const res = await WB.rawApi("/api/fund/nav?codes=" + encodeURIComponent(codes.join(",")));
      if (!res.ok) return null;
      const list = await res.json();
      const map = {};
      list.forEach((q) => {
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

  /** 行情时间 "20260731111447" → "07-31 11:14:47"；净值日期 "2026-08-03" 原样显示 */
  function fmtQuoteTime(t) {
    const s = String(t || "");
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return s.length === 14 ? `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12)}` : "";
  }

  /** XIRR 年化收益率：flows = [{t: Date, v}]（投入为负、回收为正），二分解 NPV=0。
   *  无解 / 期限过短返回 null（页面显示 —） */
  function xirr(flows) {
    const valid = flows.filter((f) => f.t && !isNaN(f.t.getTime()) && isFinite(f.v));
    if (valid.length < 2) return null;
    const t0 = Math.min(...valid.map((f) => f.t.getTime()));
    const spanDays = (Math.max(...valid.map((f) => f.t.getTime())) - t0) / 86400000;
    if (spanDays < 30) return null; // 持有太短年化没有参考意义
    const npv = (r) => valid.reduce((s, f) => s + f.v / Math.pow(1 + r, (f.t.getTime() - t0) / (365 * 86400000)), 0);
    let lo = -0.9999, hi = 10;
    const fLo = npv(lo), fHi = npv(hi);
    if (!isFinite(fLo) || !isFinite(fHi) || fLo * fHi > 0) return null;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const v = npv(mid);
      if (Math.abs(v) < 1e-7) return mid;
      if (fLo > 0 ? v > 0 : v < 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** 顶部汇总：总市值/总成本/持仓盈亏/已实现盈亏/今日盈亏/年化收益(XIRR)
   *  - 已实现盈亏改成"卖出时按均成本扣"的累计值，不再因为部分卖出就“消失”
   *  - 持仓成本用扣减后的剩余成本，避免卖半仓后成本虚高
   *  - 年化按现金流口径：买入=投入(负)、卖出=回收(正)、期末市值按最新价折算(正) */
  function summaryHtml(groups, isFund) {
    let mv = 0, cost = 0, day = 0, realizedSum = 0, quoted = false;
    groups.forEach((g) => {
      if (g.holding <= 0) return;
      cost += (g.avgCost || 0) * g.holding;
      if (g.q) {
        quoted = true;
        mv += g.q.price * g.holding;
        day += g.q.change * g.holding;
      } else {
        mv += (g.avgCost || 0) * g.holding; // 无行情按成本兜底，避免汇总失真为 0
      }
    });
    groups.forEach((g) => { realizedSum += g.realized || 0; });
    // XIRR 现金流：买卖流水 + 期末市值（无行情按成本）
    const flows = [];
    groups.forEach((g) => {
      (g.buyList || []).forEach((t) => flows.push({ t: new Date((t.date || "") + "T00:00:00"), v: -(t.shares * t.price) }));
      (g.sellList || []).forEach((t) => flows.push({ t: new Date((t.date || "") + "T00:00:00"), v: t.shares * t.price }));
      if (g.holding > 0) {
        const px = g.q ? g.q.price : g.avgCost;
        flows.push({ t: new Date(todayStr() + "T00:00:00"), v: px * g.holding });
      }
    });
    const irr = xirr(flows);
    const pl = quoted ? mv - cost : 0;
    const plPct = quoted && cost > 0 ? (pl / cost) * 100 : 0;
    const dash = (v, suffix) => (quoted ? v : "—" + (suffix || ""));
    const heldCount = groups.filter((g) => g.holding > 0).length;
    return `<div class="stat-grid">
      <div class="stat"><div class="s-lab">总市值</div><div class="s-val">${dash(fmt2(mv))}</div><div class="s-sub">共 ${heldCount} 个持仓</div></div>
      <div class="stat"><div class="s-lab">总成本</div><div class="s-val">${fmt2(cost)}</div><div class="s-sub">剩余持仓按均成本</div></div>
      <div class="stat"><div class="s-lab">持仓盈亏</div><div class="s-val" style="color:${quoted ? udColor(pl) : "var(--muted)"}">${dash(signed2(pl))}</div><div class="s-sub">${quoted ? signed2(plPct) + "%" : "行情不可用"}</div></div>
      <div class="stat"><div class="s-lab">已实现</div><div class="s-val" style="color:${udColor(realizedSum)}">${signed2(realizedSum)}</div><div class="s-sub">累计卖出盈亏</div></div>
      <div class="stat"><div class="s-lab">${isFund ? "当日收益" : "今日盈亏"}</div><div class="s-val" style="color:${quoted ? udColor(day) : "var(--muted)"}">${dash(signed2(day))}</div><div class="s-sub">${isFund ? "按净值差×份额" : "按当日涨跌估算"}</div></div>
      <div class="stat"><div class="s-lab">年化收益</div><div class="s-val" style="color:${irr === null ? "var(--muted)" : udColor(irr)}">${irr === null ? "—" : (irr > 0.005 ? "+" : "") + (irr * 100).toFixed(1) + "%"}</div><div class="s-sub">XIRR · 含期末市值</div></div>
    </div>`;
  }

  /** 持仓表行（仅 holding>0 的组） */
  function holdingRowHtml(g, isFund) {
    const q = g.q;
    const mv = q ? q.price * g.holding : 0;
    const pl = q ? (q.price - g.avgCost) * g.holding : 0;
    const plPct = q && g.avgCost > 0 ? ((q.price - g.avgCost) / g.avgCost) * 100 : 0;
    const day = q ? q.change * g.holding : 0;
    const priceSub = q ? (isFund && q.isMoney ? "万份 " + fmt4(q.pct) : signed2(q.pct) + "%") : "";
    return `<tr data-code="${esc(g.code)}">
      <td>${esc(g.name)}<span class="stk-code">${esc(g.code)}</span></td>
      <td style="color:${q ? udColor(q.change) : "var(--muted)"}">${q ? (isFund && q.isMoney ? "1.0000" : isFund ? fmt4(q.price) : fmt2(q.price)) : "—"}<span class="stk-sub">${priceSub}</span></td>
      <td>${isFund ? fmt2(g.holding) : g.holding}</td>
      <td>${isFund ? fmt4(g.avgCost) : fmt2(g.avgCost)}</td>
      <td>${q ? fmt2(mv) : "—"}</td>
      <td style="color:${q ? udColor(pl) : "var(--muted)"}">${q ? signed2(pl) : "—"}<span class="stk-sub">${q ? signed2(plPct) + "%" : ""}</span></td>
      <td style="color:${q ? udColor(day) : "var(--muted)"}">${q ? signed2(day) : "—"}</td>
      <td class="stk-ops">
        <button class="btn sm ghost" data-act="clear" title="清仓该标的（删除其全部买卖流水）">清仓</button>
      </td>
    </tr>`;
  }

  /** 交易流水表行（买=流出红，卖=流入绿） */
  function flowRowHtml(tx, isFund) {
    const isBuy = tx.action === "buy";
    return `<tr data-id="${tx.id}">
      <td>${esc(tx.date)}</td>
      <td>${esc(tx.name)}<span class="stk-code">${esc(tx.code)}</span></td>
      <td style="color:${isBuy ? "var(--danger)" : "var(--ok)"}">${isBuy ? "买" : "卖"}</td>
      <td>${isFund ? fmt2(tx.shares) : tx.shares}</td>
      <td>${isFund ? fmt4(tx.price) : fmt2(tx.price)}</td>
      <td>${fmt2(tx.shares * tx.price)}</td>
      <td class="stk-ops">
        <button class="icon-btn plain" data-act="deltx" title="删除该笔流水">${WB.icon("del")}</button>
      </td>
    </tr>`;
  }
  routes.stocks = {
    title: "股票",
    async render(el) {
      if (stkTimer) { clearInterval(stkTimer); stkTimer = null; }
      const mySeq = ++stkSeq;
      const isFund = stkTab === "fund";

      const records = await stocksRepo.list();
      const txs = records.map(normalizeTx)
        .filter((t) => isFund ? t.type === "fund" : t.type !== "fund");
      const groups = aggregateHoldings(txs);
      const codes = [...new Set(groups.map((g) => g.code).filter(Boolean))];
      const quotes = isFund ? await fetchFundNavs(codes) : await fetchStockQuotes(codes);
      if (!stillHere() || mySeq !== stkSeq) return; // await 期间已切走（换页或切 tab），放弃渲染避免覆盖
      groups.forEach((g) => { g.q = quotes ? quotes[g.code] : null; });

      const heldGroups = groups.filter((g) => g.holding > 0).sort((a, b) => a.code.localeCompare(b.code));
      const flowTxs = txs.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
      let flowBuy = 0, flowSell = 0;
      flowTxs.forEach((t) => {
        const amt = t.shares * t.price;
        if (t.action === "sell") flowSell += amt;
        else flowBuy += amt;
      });

      const qTime = quotes ? Object.values(quotes).map((q) => q.time).sort().pop() : "";
      const searchPh = isFund ? "基金代码 / 名称，如 023636 或 易方达安旭" : "代码 / 名称 / 拼音，如 600519 或 茅台";
      const tip = (isFund
        ? (window.WB.USE_API ? "录入金额即可，份额按净值自动换算；净值留空自动取最新净值" : "本地离线模式：无净值与搜索，录入金额 + 净值")
        : (window.WB.USE_API ? "同一标的可分多笔买入/卖出" : "本地离线模式：无行情与搜索，可先手动记流水"))
        + " · 买入=资金流出，卖出=资金流入 · 卖出价/买入价留空自动取当前行情价";
      const emptyHeld = isFund
        ? '<div class="empty">还没有持仓，用上方搜索添加第一笔买入（支持公募基金 / 货币基金）</div>'
        : '<div class="empty">还没有持仓，用上方搜索添加第一笔买入（支持股票 / ETF）</div>';
      const emptyFlow = '<div class="empty">暂无交易流水</div>';
      const foot = isFund
        ? "净值来自天天基金（免费接口，交易日 16:00 后更新）· 当日收益 = 今日净值 − 前日净值 × 份额 · 涨红跌绿"
        : "行情来自腾讯财经（免费接口，盘中约实时；ETF 同样支持）· 涨红跌绿";

      el.innerHTML = `
        <div class="tabs" id="stkTabbar">
          <button class="tab ${!isFund ? "on" : ""}" data-tab="stock">股票</button>
          <button class="tab ${isFund ? "on" : ""}" data-tab="fund">理财 / 基金</button>
        </div>
        ${summaryHtml(groups, isFund)}
        <div class="card">
          <h2>${isFund ? "记一笔理财交易" : "记一笔交易"}</h2>
          <div class="row stk-form">
            <span class="stk-search-wrap">
              <input id="stkSearch" placeholder="${searchPh}" autocomplete="off" class="w-200" />
              <div class="stk-sug" id="stkSug" hidden></div>
            </span>
            <select id="stkAction" class="w-80">
              <option value="buy">买入</option>
              <option value="sell">卖出</option>
            </select>
            <input type="date" id="stkDate" value="${todayStr()}" class="w-130" />
            <input type="number" id="stkShares" placeholder="${isFund ? "金额(元)" : "数量(股)"}" min="0" step="${isFund ? "0.01" : "100"}" class="w-100" />
            <input type="number" id="stkCost" placeholder="${isFund ? "净值(元/份)" : "价格(元/股)"}" min="0" step="0.0001" class="w-110" />
            <button class="btn in-card-btn" id="stkAdd">添加</button>
            <span class="stk-tip">${tip}</span>
          </div>
        </div>
        <div class="card">
          <h2>持仓明细
            <span class="count">
              ${qTime ? (isFund ? "净值 " : "行情 ") + esc(fmtQuoteTime(qTime)) + " · 30 秒自动刷新 · " : window.WB.USE_API && codes.length ? "行情获取失败 · " : ""}
              <a href="javascript:void(0)" id="stkRefresh" class="accent-link">手动刷新</a>
            </span>
          </h2>
          ${heldGroups.length ? `<div class="stk-wrap"><table class="stk-table">
            <thead><tr>
              <th>名称</th><th>${isFund ? "净值 / 今日" : "现价 / 今日"}</th><th>持仓${isFund ? "份额" : "数量"}</th><th>平均成本</th><th>市值</th><th>持仓盈亏</th><th>${isFund ? "当日收益" : "今日盈亏"}</th><th></th>
            </tr></thead>
            <tbody id="stkBody">${heldGroups.map((g) => holdingRowHtml(g, isFund)).join("")}</tbody>
          </table></div>
          <div class="stk-foot">${foot}</div>`
          : emptyHeld}
        </div>
        <div class="card">
          <h2>交易流水</h2>
          ${flowTxs.length ? `<div class="stk-wrap"><table class="stk-table">
            <thead><tr><th>日期</th><th>名称</th><th>类型</th><th>${isFund ? "份额" : "数量"}</th><th>成交价</th><th>金额</th><th></th></tr></thead>
            <tbody id="stkFlowBody">${flowTxs.map((t) => flowRowHtml(t, isFund)).join("")}</tbody>
          </table></div>
          <div class="stk-foot">买入合计 ${fmt2(flowBuy)} · 卖出合计 ${fmt2(flowSell)} · 净流入 <span style="color:${flowSell - flowBuy >= 0 ? "var(--ok)" : "var(--danger)"}">${fmt2(flowSell - flowBuy)}</span></div>` : emptyFlow}
        </div>`;

      const rerender = () => routes.stocks.render(el);
      const $ = (sel) => el.querySelector(sel);
      const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };

      // ---- tab 切换 ----
      on("#stkTabbar", "click", (e) => {
        const btn = e.target.closest("[data-tab]");
        if (!btn) return;
        stkTab = btn.dataset.tab;
        stkSel = null;
        rerender();
      });

      // ---- 搜索建议 ----
      const sugEl = $("#stkSug");
      const searchEl = $("#stkSearch");
      const hideSug = () => { if (sugEl) sugEl.hidden = true; };
      const doSearch = async () => {
        const q = searchEl.value.trim();
        stkSel = null;
        if (!q || !window.WB.USE_API) return hideSug();
        // 直接输入完整代码：股票 sh600519，基金 023636
        const isCode = isFund ? /^\d{6}$/.test(q) : /^(sh|sz|bj)?\d{6}$/i.test(q);
        if (isCode) stkSel = { code: isFund ? q : q.toLowerCase(), name: q };
        try {
          const res = await WB.rawApi("/api/" + (isFund ? "fund" : "stock") + "/search?q=" + encodeURIComponent(q));
          const list = res.ok ? await res.json() : [];
          if (!list.length) return hideSug();
          sugEl.innerHTML = list
            .map((s) => `<div class="stk-sug-item" data-code="${esc(s.code)}" data-name="${esc(s.name)}"><b>${esc(s.name)}</b><span>${esc(s.code)}</span></div>`)
            .join("");
          sugEl.hidden = false;
        } catch (e) { hideSug(); }
      };
      on("#stkSearch", "input", debounce(doSearch, 300));
      on("#stkSearch", "focus", () => { if (searchEl.value.trim()) doSearch(); });
      on("#stkSug", "click", (e) => {
        const item = e.target.closest(".stk-sug-item");
        if (!item) return;
        stkSel = { code: item.dataset.code, name: item.dataset.name };
        searchEl.value = `${item.dataset.name}（${item.dataset.code}）`;
        hideSug();
      });
      if (stkDocHandler) document.removeEventListener("click", stkDocHandler);
      stkDocHandler = (e) => { if (!e.target.closest(".stk-search-wrap")) hideSug(); };
      document.addEventListener("click", stkDocHandler);

      // ---- 添加交易（买入/卖出）；adding 锁防双击/双 Enter 重复记账（写入前有行情请求，双击窗口大） ----
      let adding = false;
      const addStk = async () => {
        if (adding) return;
        const action = ($("#stkAction") || {}).value || "buy";
        // 未点建议但输入了裸代码：股票补全市场前缀（6/5/9 沪，0/1/2/3 深，4/8 北）；基金直接 6 位
        if (!stkSel) {
          const m = searchEl.value.trim().toLowerCase().match(/^(sh|sz|bj)?(\d{6})$/);
          if (m) {
            if (isFund) stkSel = { code: m[2], name: m[2] };
            else {
              const n = m[2];
              const mkt = m[1] || (/^[569]/.test(n) ? "sh" : /^[48]/.test(n) ? "bj" : "sz");
              stkSel = { code: mkt + n, name: n };
            }
          }
        }
        if (!stkSel) return flashInvalid(searchEl);
        const sharesEl = $("#stkShares"), costEl = $("#stkCost"), dateEl = $("#stkDate");
        const date = (dateEl && dateEl.value) || todayStr();
        let price = parseFloat(costEl.value);
        const amount = isFund ? parseFloat(sharesEl.value) : 0;
        // 基础校验
        if (isFund) {
          if (!(amount > 0)) return flashInvalid(sharesEl);
        } else {
          if (!(parseFloat(sharesEl.value) > 0)) return flashInvalid(sharesEl);
          if (!(price >= 0)) return flashInvalid(costEl);
        }
        adding = true;
        try {
          // 名称尽量取真实名（手输代码时输入框里只有数字；基金名用搜索接口补，货基同样适用）
          let name = stkSel.name;
          if (isFund && /^\d{6}$/.test(name) && window.WB.USE_API) {
            try {
              const res = await WB.rawApi("/api/fund/search?q=" + encodeURIComponent(stkSel.code));
              const list = res.ok ? await res.json() : [];
              if (list.length) name = list[0].name;
            } catch (e) { /* 补名失败保持原样 */ }
          }
          const fresh = isFund ? await fetchFundNavs([stkSel.code]) : await fetchStockQuotes([stkSel.code]);
          const q = fresh ? fresh[stkSel.code] : null;
          if (q) name = q.name || name;
          let shares;
          if (action === "sell") {
            // 卖出：用户填了价格就用填的，没填才取当前现价（有行情时）；卖出数量不得超过当前持仓
            if (isFund) {
              if (!(price > 0)) price = q ? q.price : 0;
              if (!(price > 0)) return flashInvalid(costEl);
              shares = amount / price;
            } else {
              if (!(price > 0)) price = q ? q.price : 0;
              if (!(price > 0)) return flashInvalid(costEl);
              shares = parseFloat(sharesEl.value);
            }
            const grp = groups.find((g) => g.code === stkSel.code && g.type === (isFund ? "fund" : "stock"));
            const held = grp ? grp.holding : 0;
            if (shares > held + 1e-9) {
              flashInvalid(sharesEl);
              window.WB.showToast("卖出数量超过当前持仓", "error");
              return;
            }
          } else {
            // 买入：买入价留空时有行情就取现价（与基金行为一致）
            if (isFund) {
              if (!(price > 0)) price = q ? q.price : 0;
              if (!(price > 0)) return flashInvalid(costEl); // 拿不到净值又没填净值
              shares = amount / price;
            } else {
              if (!(price > 0)) price = q ? q.price : 0;
              if (!(price > 0)) return flashInvalid(costEl); // 拿不到行情又没填价格
              shares = parseFloat(sharesEl.value);
            }
          }
          if (!(shares > 0)) { flashInvalid(sharesEl); return; }
          if (!(price >= 0)) { flashInvalid(costEl); return; }
          const stamp = nowStamp();
          await stocksRepo.put({ id: uid(), code: stkSel.code, name, type: isFund ? "fund" : "stock", action, shares, price, date, createdAt: stamp, updatedAt: stamp });
        } finally { adding = false; }
        stkSel = null;
        rerender();
      };
      on("#stkAdd", "click", addStk);
      on("#stkCost", "keydown", (e) => { if (e.key === "Enter") addStk(); });

      // ---- 持仓表：清仓（删除该 code 全部流水） ----
      on("#stkBody", "click", async (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        if (btn.dataset.act === "clear") {
          const code = btn.closest("[data-code]").dataset.code;
          if (!confirm("确认清仓该标的？将删除其全部买入/卖出流水")) return;
          const recs = await stocksRepo.list();
          const toDel = recs.filter((r) => (r.code || "") === code && (isFund ? r.type === "fund" : r.type !== "fund"));
          for (const r of toDel) await stocksRepo.delete(r.id);
          rerender();
        }
      });

      // ---- 流水表：删除单笔流水 ----
      on("#stkFlowBody", "click", async (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        if (btn.dataset.act === "deltx") {
          const tr = btn.closest("[data-id]");
          const tx = flowTxs.find((t) => t.id === tr.dataset.id);
          if (!tx) return;
          if (!confirm(`确认删除 ${tx.date} ${tx.name}（${tx.action === "buy" ? "买入" : "卖出"} ${fmt2(tx.shares * tx.price)} 元）这笔流水？`)) return;
          await stocksRepo.delete(tx.id);
          rerender();
        }
      });

      on("#stkRefresh", "click", rerender);

      // ---- 30s 自动刷新：离开页面自动停（按路由判断）；搜索中跳过本轮避免打断输入 ----
      if (window.WB.USE_API && codes.length) {
        stkTimer = setInterval(() => {
          if (!stillHere()) { clearInterval(stkTimer); stkTimer = null; return; }
          const s = el.querySelector("#stkSearch");
          if (s && (s.value.trim() || document.activeElement === s)) return;
          if (["#stkShares", "#stkCost", "#stkDate", "#stkAction"].some((x) => el.querySelector(x) === document.activeElement)) return;
          rerender();
        }, REFRESH_MS);
      }
    },
  };
})();
