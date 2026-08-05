/**
 * stocks.js — 股票 & 理财：A 股持仓 + 公募基金（理财）记录，实时行情盈亏
 *
 * 功能：
 * - 两个 tab：股票 / 理财（基金）。数据同存 stocks store，理财记录带 type:"fund"
 * - 股票：搜索（代码/名称/拼音，腾讯 smartbox 经后端代理）选中标的，录入数量 + 成本价；
 *   同一标的可多条记录（分批买入不同成本各记一笔）；行情 qt.gtimg.cn 经 /api/stock/quote 批量代理
 * - 理财：搜索公募基金（天天基金经后端代理），录入持有份额 + 成本净值（元/份）；
 *   净值天天基金 /api/fund/nav（东方财富）逐日更新，当日收益 = 净值差 × 份额
 * - 持仓表：现价(净值) / 今日涨跌 / 市值 / 持仓盈亏（额+比例）/ 今日盈亏，红涨绿跌（A 股惯例）
 * - 顶部汇总：总市值 / 总成本 / 持仓盈亏 / 今日盈亏
 * - 页面停留时每 30 秒自动刷新（编辑中/离开页面自动暂停）
 * - 本地离线模式无行情（代理在服务端），持仓仍可增删改，行情列显示 —
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, debounce, flashInvalid } = window.WB;
  const stocksRepo = repo("stocks");

  let stkEditId = null;   // 行内编辑中的持仓 id
  let stkSel = null;      // 搜索下拉选中的标的 {code, name}
  let stkTimer = null;    // 30s 自动刷新句柄
  let stkTab = "stock";   // "stock" | "fund"
  let stkSeq = 0;         // render 代数：防止慢请求/自动刷新回写覆盖用户刚切到的 tab
  let stkDocHandler = null; // 文档点击隐藏搜索建议的处理器，避免重复绑定
  const REFRESH_MS = 30 * 1000;

  const fmt2 = (n) => Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt4 = (n) => Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const signed2 = (n) => (n > 0.005 ? "+" + fmt2(n) : n < -0.005 ? "-" + fmt2(-n) : "0.00");
  /** A 股惯例：涨红跌绿 */
  const udColor = (n) => (n > 0.005 ? "var(--danger)" : n < -0.005 ? "var(--ok)" : "var(--muted)");

  function normalizeHolding(r) {
    return {
      id: r.id,
      code: r.code || "",
      name: r.name || r.code || "",
      shares: Number(r.shares || 0),
      cost: Number(r.cost || 0),
      type: r.type || "stock",
      createdAt: r.createdAt || "",
      updatedAt: r.updatedAt || "",
    };
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
      const res = await fetch("/api/stock/quote?codes=" + encodeURIComponent(codes.join(",")));
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
      const res = await fetch("/api/fund/nav?codes=" + encodeURIComponent(codes.join(",")));
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

  function summaryHtml(rows, isFund) {
    let mv = 0, cost = 0, day = 0, quoted = false;
    rows.forEach((r) => {
      cost += r.cost * r.shares;
      if (r.q) {
        quoted = true;
        mv += r.q.price * r.shares;
        day += r.q.change * r.shares;
      } else {
        mv += r.cost * r.shares; // 无行情按成本兜底，避免汇总失真为 0
      }
    });
    const pl = quoted ? mv - cost : 0;
    const plPct = quoted && cost > 0 ? (pl / cost) * 100 : 0;
    const dash = (v, suffix) => (quoted ? v : "—" + (suffix || ""));
    return `<div class="stat-grid">
      <div class="stat"><div class="s-lab">总市值</div><div class="s-val">${dash(fmt2(mv))}</div><div class="s-sub">共 ${rows.length} 笔持仓</div></div>
      <div class="stat"><div class="s-lab">总成本</div><div class="s-val">${fmt2(cost)}</div><div class="s-sub">买入金额合计</div></div>
      <div class="stat"><div class="s-lab">持仓盈亏</div><div class="s-val" style="color:${quoted ? udColor(pl) : "var(--muted)"}">${dash(signed2(pl))}</div><div class="s-sub">${quoted ? signed2(plPct) + "%" : "行情不可用"}</div></div>
      <div class="stat"><div class="s-lab">${isFund ? "当日收益" : "今日盈亏"}</div><div class="s-val" style="color:${quoted ? udColor(day) : "var(--muted)"}">${dash(signed2(day))}</div><div class="s-sub">${isFund ? "按净值差×份额" : "按当日涨跌估算"}</div></div>
    </div>`;
  }

  function rowHtml(r, isFund) {
    if (stkEditId === r.id) {
      return `<tr data-id="${r.id}">
        <td>${esc(r.name)}<span class="stk-code">${esc(r.code)}</span></td>
        <td colspan="4">
          <span class="stk-edit-row">
            ${isFund ? "买入金额" : "数量"} <input type="number" class="stk-in" data-f="shares" value="${isFund ? (r.shares * r.cost).toFixed(2) : r.shares}" min="0" step="${isFund ? "0.01" : "100"}" style="width:110px" />
            成本 <input type="number" class="stk-in" data-f="cost" value="${r.cost}" min="0" step="0.0001" style="width:110px" />
          </span>
        </td>
        <td colspan="2"></td>
        <td class="stk-ops">
          <button class="btn sm" data-act="save">保存</button>
          <button class="btn sm ghost" data-act="cancel">取消</button>
        </td>
      </tr>`;
    }
    const q = r.q;
    const mv = q ? q.price * r.shares : 0;
    const pl = q ? (q.price - r.cost) * r.shares : 0;
    const plPct = q && r.cost > 0 ? ((q.price - r.cost) / r.cost) * 100 : 0;
    const day = q ? q.change * r.shares : 0;
    const priceSub = q ? (isFund && q.isMoney ? "万份 " + fmt4(q.pct) : signed2(q.pct) + "%") : "";
    return `<tr data-id="${r.id}">
      <td>${esc(r.name)}<span class="stk-code">${esc(r.code)}</span></td>
      <td style="color:${q ? udColor(q.change) : "var(--muted)"}">${q ? (isFund && q.isMoney ? "1.0000" : isFund ? fmt4(q.price) : fmt2(q.price)) : "—"}<span class="stk-sub">${priceSub}</span></td>
      <td>${isFund ? fmt2(r.shares * r.cost) : r.shares}</td>
      <td>${isFund ? fmt4(r.cost) : fmt2(r.cost)}</td>
      <td>${q ? fmt2(mv) : "—"}</td>
      <td style="color:${q ? udColor(pl) : "var(--muted)"}">${q ? signed2(pl) : "—"}<span class="stk-sub">${q ? signed2(plPct) + "%" : ""}</span></td>
      <td style="color:${q ? udColor(day) : "var(--muted)"}">${q ? signed2(day) : "—"}</td>
      <td class="stk-ops">
        <button class="icon-btn plain" data-act="edit" title="修改数量/成本">${WB.icon("edit")}</button>
        <button class="icon-btn plain" data-act="del" title="删除该笔持仓">${WB.icon("del")}</button>
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
      const rows = records.map(normalizeHolding)
        .filter((r) => isFund ? r.type === "fund" : r.type !== "fund")
        .sort((a, b) => a.code.localeCompare(b.code) || (a.createdAt || "").localeCompare(b.createdAt || ""));
      const codes = [...new Set(rows.map((r) => r.code).filter(Boolean))];
      const quotes = isFund ? await fetchFundNavs(codes) : await fetchStockQuotes(codes);
      if (!stillHere() || mySeq !== stkSeq) return; // await 期间已切走（换页或切 tab），放弃渲染避免覆盖
      rows.forEach((r) => { r.q = quotes ? quotes[r.code] : null; });

      const qTime = quotes ? Object.values(quotes).map((q) => q.time).sort().pop() : "";
      const searchPh = isFund ? "基金代码 / 名称，如 023636 或 易方达安旭" : "代码 / 名称 / 拼音，如 600519 或 茅台";
      const tip = isFund
        ? (window.WB.USE_API ? "录入买入金额即可，份额按成本净值自动换算；成本净值留空自动取最新净值" : "本地离线模式：无净值与搜索，录入买入金额 + 成本净值")
        : (window.WB.USE_API ? "同一股票可分多笔记录不同成本" : "本地离线模式：无行情与搜索，可先手动记持仓");
      const empty = isFund
        ? '<div class="empty">还没有理财记录，用上方搜索添加第一笔（支持公募基金 / 货币基金）</div>'
        : '<div class="empty">还没有持仓记录，用上方搜索添加第一笔（支持股票 / ETF）</div>';
      const foot = isFund
        ? "净值来自天天基金（免费接口，交易日 16:00 后更新）· 当日收益 = 今日净值 − 前日净值 × 份额 · 涨红跌绿"
        : "行情来自腾讯财经（免费接口，盘中约实时；ETF 同样支持）· 涨红跌绿";

      el.innerHTML = `
        <div class="tabs" id="stkTabbar">
          <button class="tab ${!isFund ? "on" : ""}" data-tab="stock">股票</button>
          <button class="tab ${isFund ? "on" : ""}" data-tab="fund">理财 / 基金</button>
        </div>
        ${summaryHtml(rows, isFund)}
        <div class="card">
          <h2>${isFund ? "添加理财" : "添加持仓"}</h2>
          <div class="row stk-form">
            <span class="stk-search-wrap">
              <input id="stkSearch" placeholder="${searchPh}" autocomplete="off" style="width:250px" />
              <div class="stk-sug" id="stkSug" hidden></div>
            </span>
            <input type="number" id="stkShares" placeholder="${isFund ? "买入金额(元)" : "数量(股)"}" min="0" step="${isFund ? "0.01" : "100"}" style="width:120px" />
            <input type="number" id="stkCost" placeholder="${isFund ? "成本净值(元/份)" : "成本价(元/股)"}" min="0" step="0.0001" style="width:130px" />
            <button class="btn" id="stkAdd">添加</button>
            <span class="stk-tip">${tip}</span>
          </div>
        </div>
        <div class="card">
          <h2>持仓明细
            <span class="count">
              ${qTime ? (isFund ? "净值 " : "行情 ") + esc(fmtQuoteTime(qTime)) + " · 30 秒自动刷新 · " : window.WB.USE_API && codes.length ? "行情获取失败 · " : ""}
              <a href="javascript:void(0)" id="stkRefresh" style="color:var(--accent)">手动刷新</a>
            </span>
          </h2>
          ${rows.length ? `<div class="stk-wrap"><table class="stk-table">
            <thead><tr>
              <th>名称</th><th>${isFund ? "净值 / 今日" : "现价 / 今日"}</th><th>${isFund ? "买入金额" : "数量"}</th><th>${isFund ? "成本净值" : "成本价"}</th><th>市值</th><th>持仓盈亏</th><th>${isFund ? "当日收益" : "今日盈亏"}</th><th></th>
            </tr></thead>
            <tbody id="stkBody">${rows.map((r) => rowHtml(r, isFund)).join("")}</tbody>
          </table></div>
          <div class="stk-foot">${foot}</div>`
          : empty}
        </div>`;

      const rerender = () => routes.stocks.render(el);
      const $ = (sel) => el.querySelector(sel);
      const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };

      // ---- tab 切换 ----
      on("#stkTabbar", "click", (e) => {
        const btn = e.target.closest("[data-tab]");
        if (!btn) return;
        stkTab = btn.dataset.tab;
        stkEditId = null;
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
          const res = await fetch("/api/" + (isFund ? "fund" : "stock") + "/search?q=" + encodeURIComponent(q));
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

      // ---- 添加持仓 ----
      const addStk = async () => {
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
        const sharesEl = $("#stkShares"), costEl = $("#stkCost");
        // 理财：输入的是买入金额（元），份额 = 金额 ÷ 成本净值，成本净值留空则自动取最新净值
        const amount = isFund ? parseFloat(sharesEl.value) : 0;
        let cost = parseFloat(costEl.value);
        if (isFund) {
          if (!(amount > 0)) return flashInvalid(sharesEl);
        } else {
          if (!(parseFloat(sharesEl.value) > 0)) return flashInvalid(sharesEl);
          if (!(cost >= 0)) return flashInvalid(costEl);
        }
        // 名称尽量取真实名（手输代码时输入框里只有数字；基金名用搜索接口补，货基同样适用）
        let name = stkSel.name;
        if (isFund && /^\d{6}$/.test(name) && window.WB.USE_API) {
          try {
            const res = await fetch("/api/fund/search?q=" + encodeURIComponent(stkSel.code));
            const list = res.ok ? await res.json() : [];
            if (list.length) name = list[0].name;
          } catch (e) { /* 补名失败保持原样 */ }
        }
        const fresh = isFund ? await fetchFundNavs([stkSel.code]) : await fetchStockQuotes([stkSel.code]);
        if (fresh && fresh[stkSel.code]) {
          name = fresh[stkSel.code].name || name;
          if (isFund && !(cost > 0)) cost = fresh[stkSel.code].price; // 成本净值留空 → 用最新净值
        } else if (window.WB.USE_API && /^\d{6}$/.test(name)) return window.WB.showToast("未查到该代码的行情，请确认代码是否正确", "error");
        if (isFund && !(cost > 0)) return flashInvalid(costEl); // 拿不到净值又没填成本净值
        const shares = isFund ? amount / cost : parseFloat(sharesEl.value);
        const stamp = nowStamp();
        await stocksRepo.put({ id: uid(), code: stkSel.code, name, shares, cost, type: isFund ? "fund" : "stock", createdAt: stamp, updatedAt: stamp });
        stkSel = null;
        rerender();
      };
      on("#stkAdd", "click", addStk);
      on("#stkCost", "keydown", (e) => { if (e.key === "Enter") addStk(); });

      // ---- 行操作：编辑 / 删除 ----
      on("#stkBody", "click", async (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const tr = btn.closest("[data-id]");
        const id = tr.dataset.id;
        const act = btn.dataset.act;
        if (act === "edit") { stkEditId = id; rerender(); }
        else if (act === "cancel") { stkEditId = null; rerender(); }
        else if (act === "save") {
          const rec = await stocksRepo.get(id);
          if (!rec) return;
          if (isFund) {
            // 理财编辑：买入金额 + 成本净值 → 份额 = 金额 ÷ 净值
            const amount = parseFloat(tr.querySelector('[data-f="shares"]').value);
            const cost = parseFloat(tr.querySelector('[data-f="cost"]').value);
            if (!(amount > 0) || !(cost > 0)) return flashInvalid(tr.querySelector('[data-f="shares"]'));
            rec.shares = amount / cost;
            rec.cost = cost;
          } else {
            const shares = parseFloat(tr.querySelector('[data-f="shares"]').value);
            const cost = parseFloat(tr.querySelector('[data-f="cost"]').value);
            if (!(shares > 0) || !(cost >= 0)) return flashInvalid(tr.querySelector('[data-f="shares"]'));
            rec.shares = shares;
            rec.cost = cost;
          }
          rec.updatedAt = nowStamp();
          await stocksRepo.put(rec);
          stkEditId = null;
          rerender();
        } else if (act === "del") {
          const rec = rows.find((r) => r.id === id);
          if (!confirm(`删除持仓「${(rec && rec.name) || ""}」这笔记录？`)) return;
          await stocksRepo.delete(id);
          rerender();
        }
      });

      on("#stkRefresh", "click", rerender);

      // ---- 30s 自动刷新：离开页面自动停（按路由判断）；编辑中/搜索中跳过本轮避免打断输入 ----
      if (window.WB.USE_API && codes.length) {
        stkTimer = setInterval(() => {
          if (!stillHere()) { clearInterval(stkTimer); stkTimer = null; return; }
          if (stkEditId !== null) return;
          const s = el.querySelector("#stkSearch");
          if (s && (s.value.trim() || document.activeElement === s)) return;
          if (["#stkShares", "#stkCost"].some((x) => el.querySelector(x) === document.activeElement)) return;
          rerender();
        }, REFRESH_MS);
      }
    },
  };
})();
