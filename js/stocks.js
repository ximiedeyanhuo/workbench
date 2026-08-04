/**
 * stocks.js — 股票：A 股持仓记录 + 实时行情盈亏
 *
 * 功能：
 * - 添加持仓：搜索（代码/名称/拼音，腾讯 smartbox 经后端代理）选中标的，录入数量 + 成本价；
 *   同一标的可多条记录（分批买入不同成本各记一笔）
 * - 持仓表：现价 / 今日涨跌幅 / 市值 / 持仓盈亏（额+比例）/ 今日盈亏，红涨绿跌（A 股惯例）
 * - 顶部汇总：总市值 / 总成本 / 持仓盈亏 / 今日盈亏
 * - 行情来源 qt.gtimg.cn（经 /api/stock/quote 批量代理，一次请求拉全部持仓）；
 *   页面停留时每 30 秒自动刷新（编辑中/离开页面自动暂停）
 * - 本地离线模式无行情（代理在服务端），持仓仍可增删改，行情列显示 —
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, debounce, flashInvalid } = window.WB;
  const stocksRepo = repo("stocks");

  let stkEditId = null;   // 行内编辑中的持仓 id
  let stkSel = null;      // 搜索下拉选中的标的 {code, name}
  let stkTimer = null;    // 30s 自动刷新句柄
  const REFRESH_MS = 30 * 1000;

  const fmt2 = (n) => Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  /** 批量拉行情，失败返回 null（页面降级显示 —） */
  async function fetchQuotes(codes) {
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

  /** 行情时间 "20260731111447" → "07-31 11:14:47" */
  function fmtQuoteTime(t) {
    const s = String(t || "");
    return s.length === 14 ? `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12)}` : "";
  }

  function summaryHtml(rows) {
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
      <div class="stat"><div class="s-lab">今日盈亏</div><div class="s-val" style="color:${quoted ? udColor(day) : "var(--muted)"}">${dash(signed2(day))}</div><div class="s-sub">按当日涨跌估算</div></div>
    </div>`;
  }

  function rowHtml(r) {
    if (stkEditId === r.id) {
      return `<tr data-id="${r.id}">
        <td>${esc(r.name)}<span class="stk-code">${esc(r.code)}</span></td>
        <td colspan="4">
          <span class="stk-edit-row">
            数量 <input type="number" class="stk-in" data-f="shares" value="${r.shares}" min="0" step="100" style="width:90px" />
            成本 <input type="number" class="stk-in" data-f="cost" value="${r.cost}" min="0" step="0.001" style="width:90px" />
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
    return `<tr data-id="${r.id}">
      <td>${esc(r.name)}<span class="stk-code">${esc(r.code)}</span></td>
      <td style="color:${q ? udColor(q.change) : "var(--muted)"}">${q ? fmt2(q.price) : "—"}<span class="stk-sub">${q ? signed2(q.pct) + "%" : ""}</span></td>
      <td>${r.shares}</td>
      <td>${fmt2(r.cost)}</td>
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

      const records = await stocksRepo.list();
      const rows = records.map(normalizeHolding).sort((a, b) => a.code.localeCompare(b.code) || (a.createdAt || "").localeCompare(b.createdAt || ""));
      const codes = [...new Set(rows.map((r) => r.code).filter(Boolean))];
      const quotes = await fetchQuotes(codes);
      if (!stillHere()) return; // await 期间用户已切走，放弃渲染避免覆盖其他页
      rows.forEach((r) => { r.q = quotes ? quotes[r.code] : null; });

      const qTime = quotes ? Object.values(quotes).map((q) => q.time).sort().pop() : "";

      el.innerHTML = `
        ${summaryHtml(rows)}
        <div class="card">
          <h2>添加持仓</h2>
          <div class="row stk-form">
            <span class="stk-search-wrap">
              <input id="stkSearch" placeholder="代码 / 名称 / 拼音，如 600519 或 茅台" autocomplete="off" style="width:230px" />
              <div class="stk-sug" id="stkSug" hidden></div>
            </span>
            <input type="number" id="stkShares" placeholder="数量(股)" min="0" step="100" style="width:110px" />
            <input type="number" id="stkCost" placeholder="成本价(元/股)" min="0" step="0.001" style="width:130px" />
            <button class="btn" id="stkAdd">添加</button>
            <span class="stk-tip">${window.WB.USE_API ? "同一股票可分多笔记录不同成本" : "本地离线模式：无行情与搜索，可先手动记持仓"}</span>
          </div>
        </div>
        <div class="card">
          <h2>持仓明细
            <span class="count">
              ${qTime ? "行情 " + esc(fmtQuoteTime(qTime)) + " · 30 秒自动刷新 · " : window.WB.USE_API && codes.length ? "行情获取失败 · " : ""}
              <a href="javascript:void(0)" id="stkRefresh" style="color:var(--accent)">手动刷新</a>
            </span>
          </h2>
          ${rows.length ? `<div class="stk-wrap"><table class="stk-table">
            <thead><tr>
              <th>名称</th><th>现价 / 今日</th><th>数量</th><th>成本价</th><th>市值</th><th>持仓盈亏</th><th>今日盈亏</th><th></th>
            </tr></thead>
            <tbody id="stkBody">${rows.map(rowHtml).join("")}</tbody>
          </table></div>
          <div class="stk-foot">行情来自腾讯财经（免费接口，盘中约实时；ETF 同样支持）· 涨红跌绿</div>`
          : '<div class="empty">还没有持仓记录，用上方搜索添加第一笔（支持股票 / ETF）</div>'}
        </div>`;

      const rerender = () => routes.stocks.render(el);
      const $ = (sel) => el.querySelector(sel);
      const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };

      // ---- 搜索建议 ----
      const sugEl = $("#stkSug");
      const searchEl = $("#stkSearch");
      const hideSug = () => { if (sugEl) sugEl.hidden = true; };
      const doSearch = async () => {
        const q = searchEl.value.trim();
        stkSel = null;
        if (!q || !window.WB.USE_API) return hideSug();
        // 直接输入完整代码（600519 / sh600519）时无需等搜索也能添加
        const m = q.toLowerCase().match(/^(sh|sz|bj)?(\d{6})$/);
        if (m && m[1]) stkSel = { code: m[1] + m[2], name: q };
        try {
          const res = await fetch("/api/stock/search?q=" + encodeURIComponent(q));
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
      document.addEventListener("click", (e) => { if (!e.target.closest(".stk-search-wrap")) hideSug(); }, { once: true });

      // ---- 添加持仓 ----
      const addStk = async () => {
        // 未点建议但输入了裸代码：补全市场前缀（6/5/9 沪，0/1/2/3 深，4/8 北）
        if (!stkSel) {
          const m = searchEl.value.trim().toLowerCase().match(/^(sh|sz|bj)?(\d{6})$/);
          if (m) {
            const n = m[2];
            const mkt = m[1] || (/^[569]/.test(n) ? "sh" : /^[48]/.test(n) ? "bj" : "sz");
            stkSel = { code: mkt + n, name: n };
          }
        }
        if (!stkSel) return flashInvalid(searchEl);
        const sharesEl = $("#stkShares"), costEl = $("#stkCost");
        const shares = parseFloat(sharesEl.value);
        const cost = parseFloat(costEl.value);
        if (!(shares > 0)) return flashInvalid(sharesEl);
        if (!(cost >= 0)) return flashInvalid(costEl);
        // 名称尽量取行情真实名（手输代码时输入框里只有数字）
        let name = stkSel.name;
        const fresh = await fetchQuotes([stkSel.code]);
        if (fresh && fresh[stkSel.code]) name = fresh[stkSel.code].name;
        else if (window.WB.USE_API && /^\d{6}$/.test(name)) return alert("未查到该代码的行情，请确认代码是否正确");
        const stamp = nowStamp();
        await stocksRepo.put({ id: uid(), code: stkSel.code, name, shares, cost, createdAt: stamp, updatedAt: stamp });
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
          const shares = parseFloat(tr.querySelector('[data-f="shares"]').value);
          const cost = parseFloat(tr.querySelector('[data-f="cost"]').value);
          if (!(shares > 0) || !(cost >= 0)) return flashInvalid(tr.querySelector('[data-f="shares"]'));
          const rec = await stocksRepo.get(id);
          if (rec) { rec.shares = shares; rec.cost = cost; rec.updatedAt = nowStamp(); await stocksRepo.put(rec); }
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
