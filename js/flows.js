/**
 * flows.js — 消费流水：微信/支付宝账单的独立仓库
 *
 * 与正式账本完全隔离：导入的原始明细只存本仓库（exttx store），
 * 自动打标签仅供筛选，统计零参与；正式账本继续纯手工记录。
 * 支持：微信支付账单 .xlsx（SheetJS 解析）、支付宝账单 .csv（GBK 自动降级）。
 */
(function () {
  "use strict";

  const { routes, repo, esc, debounce, uid } = window.WB;
  const flowsRepo = repo("exttx");

  // ---------- 状态 ----------
  let flowsMonth = "";   // "YYYY-MM"，"" = 全部月份
  let flowsTag = "";     // "" = 全部标签
  let flowsQ = "";       // 关键词（交易对方/商品/备注）
  let flowsSource = "";  // wechat | alipay | "" = 全部来源

  const TAGS = ["消费", "收入", "转账", "还款", "其他"];
  const TAG_COLOR = { "消费": "var(--danger)", "收入": "var(--ok)", "转账": "var(--accent)", "还款": "var(--purple)", "其他": "var(--muted)" };
  const SOURCE_NAME = { wechat: "微信", alipay: "支付宝" };

  // ---------- 解析工具 ----------
  function normDate(s) {
    const d = String(s).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : "";
  }
  function dirOf(s) {
    const v = String(s).trim();
    return v === "收入" ? "in" : v === "支出" ? "out" : "neutral";
  }
  function amtOf(s) {
    return parseFloat(String(s).replace(/[¥￥,，\s]/g, "")) || 0;
  }
  /** 自动标签（仅筛选展示用）：还款 > 账户间移动 > 方向兜底 */
  function tagOf(direction, rawType, counterparty, note) {
    const s = [rawType, counterparty, note].join(" ");
    if (/还款/.test(s)) return "还款";
    if (/余额宝|零钱提现|零钱充值|提现|转出|转入/.test(s)) return "转账";
    if (direction === "in") return "收入";
    if (direction === "out") return "消费";
    return "其他";
  }

  /** 微信账单行映射：表头含「交易时间/交易类型/交易对方/商品/收/支/金额(元)」 */
  function mapWechatRows(rows) {
    const hi = rows.findIndex((r) => r.some((c) => String(c).includes("交易时间")));
    if (hi < 0) return { err: "没找到微信账单表头（需包含「交易时间」列）" };
    const header = rows[hi].map((c) => String(c).replace(/\s/g, ""));
    const col = (kw) => header.findIndex((h) => h.includes(kw));
    const i = { time: col("交易时间"), type: col("交易类型"), party: col("交易对方"), goods: col("商品"), dir: col("收/支"), amt: col("金额"), note: col("备注") };
    if (i.time < 0 || i.dir < 0 || i.amt < 0) return { err: "微信账单缺关键列（交易时间 / 收/支 / 金额）" };
    const out = [];
    for (const r of rows.slice(hi + 1)) {
      const date = normDate(r[i.time]);
      const amount = amtOf(r[i.amt]);
      if (!date || !(amount > 0)) continue;
      out.push({
        date,
        counterparty: String(r[i.party] || "").trim(),
        note: String(r[i.goods] || "").trim(),
        amount,
        direction: dirOf(r[i.dir]),
        rawType: String(r[i.type] || "").trim(),
        source: "wechat",
      });
    }
    return { rows: out };
  }

  /** 支付宝账单行映射：表头含「交易创建时间/类型/交易对方/商品名称/金额（元）/收/支」 */
  function mapAlipayRows(rows) {
    const hi = rows.findIndex((r) => r.some((c) => { const s = String(c); return s.includes("交易创建时间") || s.includes("交易时间"); }));
    if (hi < 0) return { err: "没找到支付宝账单表头（需包含「交易创建时间」列）" };
    const header = rows[hi].map((c) => String(c).replace(/\s/g, ""));
    const col = (kw) => header.findIndex((h) => h.includes(kw));
    const i = {
      time: col("交易创建时间") >= 0 ? col("交易创建时间") : col("交易时间"),
      type: col("类型"), party: col("交易对方"), goods: col("商品名称"),
      dir: col("收/支"), amt: col("金额"), status: col("交易状态"), note: col("备注"),
    };
    if (i.time < 0 || i.dir < 0 || i.amt < 0) return { err: "支付宝账单缺关键列（交易创建时间 / 收/支 / 金额）" };
    const out = [];
    for (const r of rows.slice(hi + 1)) {
      if (/失败|关闭/.test(String(r[i.status] || ""))) continue; // 失败/关闭的交易不入库
      const date = normDate(r[i.time]);
      const amount = amtOf(r[i.amt]);
      if (!date || !(amount > 0)) continue;
      out.push({
        date,
        counterparty: String(r[i.party] || "").trim(),
        note: String(r[i.goods] || "").trim(),
        amount,
        direction: dirOf(r[i.dir]),
        rawType: String(r[i.type] || "").trim(),
        source: "alipay",
      });
    }
    return { rows: out };
  }

  /** 读账单文件：xlsx 走 SheetJS，csv 先 UTF-8 后 GBK 降级；
   *  按表头内容自动识别微信/支付宝格式（不依赖扩展名）。 */
  async function readTableFile(file) {
    let rows;
    if (/\.xlsx$|\.xlsm$/i.test(file.name)) {
      if (typeof XLSX === "undefined") {
        try { await window.WB.loadScript("/lib/xlsx.mini.min.js"); } catch (e) { return { err: "xlsx 解析库加载失败，请检查网络后重试" }; }
      }
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
      const w = mapWechatRows(rows);
      if (!w.err) return w;
      const a = mapAlipayRows(rows);
      return a.err ? { err: w.err } : a;
    }
    const buf = await file.arrayBuffer();
    const attempts = [new TextDecoder("utf-8").decode(buf)];
    try { attempts.push(new TextDecoder("gbk").decode(buf)); } catch (e) { /* 浏览器不支持 gbk 就只试 utf-8 */ }
    let lastErr = "无法识别账单格式";
    for (const text of attempts) {
      const rs = window.WB.finIO.parseCsv(text);
      // 微信映射优先：其表头「交易时间」是支付宝「交易创建时间」的子串反例，
      // 若支付宝映射先试会误吞微信格式（来源/商品列错位）
      const w = mapWechatRows(rs);
      if (!w.err) return w;
      lastErr = w.err;
      const a = mapAlipayRows(rs);
      if (!a.err) return a;
      lastErr = a.err;
    }
    return { err: lastErr };
  }

  /** 导入：指纹去重（source|date|amount|counterparty|note）→ 确认 → 入库 */
  async function importFile(file) {
    const parsed = await readTableFile(file);
    if (parsed.err) return parsed;
    const rows = parsed.rows;
    if (!rows.length) return { err: "没有有效交易行（日期/金额不全的行已跳过）" };
    const existing = await flowsRepo.list();
    const hash = (r) => [r.source, r.date, r.amount, r.counterparty, r.note].join("|");
    const seen = new Set(existing.map(hash));
    const fresh = [];
    let dup = 0;
    for (const r of rows) {
      r.id = uid();
      r.tag = tagOf(r.direction, r.rawType, r.counterparty, r.note);
      const h = hash(r);
      if (seen.has(h)) { dup++; continue; }
      seen.add(h);
      fresh.push(r);
    }
    if (!fresh.length) return { err: `全部 ${rows.length} 条均已导入过，无需重复` };
    if (!window.confirm(`解析到 ${rows.length} 条，新导入 ${fresh.length} 条${dup ? `（重复跳过 ${dup} 条）` : ""}。\n仅存入消费流水仓库，不影响正式账本与统计。确认导入？`)) return { cancelled: true };
    await flowsRepo.bulkPut(fresh);
    return { added: fresh.length, dup };
  }

  // ---------- 渲染 ----------
  function flowsHtml(all) {
    const months = [];
    all.forEach((r) => { const m = (r.date || "").slice(0, 7); if (m && months.indexOf(m) === -1) months.push(m); });
    months.sort((a, b) => b.localeCompare(a));

    let list = all;
    if (flowsMonth) list = list.filter((r) => (r.date || "").slice(0, 7) === flowsMonth);
    if (flowsTag) list = list.filter((r) => r.tag === flowsTag);
    if (flowsSource) list = list.filter((r) => r.source === flowsSource);
    if (flowsQ) {
      const q = flowsQ.toLowerCase();
      list = list.filter((r) => String(r.counterparty || "").toLowerCase().includes(q) || String(r.note || "").toLowerCase().includes(q) || String(r.rawType || "").toLowerCase().includes(q));
    }
    list = list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.id || "").localeCompare(a.id || ""));

    // 小计（当前筛选范围）
    const sumOf = (tag) => list.filter((r) => !tag || r.tag === tag).reduce((s, r) => s + Number(r.amount || 0), 0);
    const consume = sumOf("消费"), income = sumOf("收入");

    const monthOpts = ['<option value=""' + (flowsMonth ? "" : " selected") + '>全部月份</option>']
      .concat(months.map((m) => `<option value="${m}" ${flowsMonth === m ? "selected" : ""}>${m}</option>`)).join("");
    const tagChips = ['<button class="tab ' + (flowsTag === "" ? "on" : "") + '" data-ftag="">全部</button>']
      .concat(TAGS.map((t) => `<button class="tab ${flowsTag === t ? "on" : ""}" data-ftag="${t}">${t}</button>`)).join("");
    const srcChips = ['<button class="tab ' + (flowsSource === "" ? "on" : "") + '" data-fsrc="">全部来源</button>']
      .concat(Object.keys(SOURCE_NAME).map((s) => `<button class="tab ${flowsSource === s ? "on" : ""}" data-fsrc="${s}">${SOURCE_NAME[s]}</button>`)).join("");

    // 按日期分组
    const byDate = {};
    list.forEach((r) => { (byDate[r.date] = byDate[r.date] || []).push(r); });
    const listHtml = list.length
      ? Object.keys(byDate).sort((a, b) => b.localeCompare(a)).map((d) => {
          const rows = byDate[d].map((r) => {
            const sign = r.direction === "in" ? "+" : r.direction === "out" ? "-" : "±";
            const color = r.direction === "in" ? "var(--ok)" : r.direction === "out" ? "var(--danger)" : "var(--muted)";
            return `<li class="flow-li">
              <div class="flow-main">
                <div class="flow-party">${esc(r.counterparty || "(无对方)")}${r.note ? `<span class="flow-note">${esc(r.note)}</span>` : ""}</div>
                <div class="flow-sub"><span class="flow-badge" style="color:${TAG_COLOR[r.tag] || "var(--muted)"}">${esc(r.tag)}</span><span>${esc(SOURCE_NAME[r.source] || r.source || "")}</span>${r.rawType ? `<span>${esc(r.rawType)}</span>` : ""}</div>
              </div>
              <div class="flow-amt" style="color:${color}">${sign}${fmtYuan(r.amount)}</div>
              <button class="icon-btn" data-act="del-flow" data-id="${esc(r.id)}" title="删除">${window.WB.icon("del")}</button>
            </li>`;
          }).join("");
          return `<div class="tx-day"><div class="tx-day-head">${d}</div><ul class="tx-list">${rows}</ul></div>`;
        }).join("")
      : `<div class="empty">${all.length ? "当前筛选没有匹配的流水" : "还没有导入过账单。把微信/支付宝的账单文件存进来，消费明细随时可查，且不影响正式账本。"}</div>`;

    return `<div class="card">
      <div class="row sp-b-md">
        <h2 style="margin:0">消费流水 <span class="count">外部仓库 · 不计入统计</span></h2>
        <div class="row">
          <button class="btn sm ghost" id="flowsImport">导入账单</button>
          <input type="file" id="flowsFile" accept=".csv,text/csv,.xlsx,.xlsm" hidden />
          <button class="btn danger sm" id="flowsClear">清空</button>
        </div>
      </div>
      <div class="row sp-b-md" style="flex-wrap:wrap;gap:8px">
        <select id="flowsMonth" class="w-130" title="月份">${monthOpts}</select>
        <div class="tx-stat-seg">${tagChips}</div>
        <div class="tx-stat-seg">${srcChips}</div>
        <input id="flowsQ" placeholder="搜交易对方 / 商品…" value="${esc(flowsQ)}" class="w-150" />
      </div>
      <div class="row sp-b-sm" style="gap:16px">
        <span>消费 <b class="c-danger">${fmtYuan(consume)}</b></span>
        <span>收入 <b class="c-ok">${fmtYuan(income)}</b></span>
        <span class="tx-day-sub">共 ${list.length} 条</span>
      </div>
      <div id="flowList">${listHtml}</div>
    </div>`;
  }

  function fmtYuan(n) {
    return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  routes.flows = {
    title: "消费流水",
    async render(el) {
      const all = await flowsRepo.list();
      el.innerHTML = flowsHtml(all);

      const rerender = () => routes.flows.render(el);
      const $ = (sel) => el.querySelector(sel);
      const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };

      on("#flowsMonth", "change", (e) => { flowsMonth = e.target.value; rerender(); });
      on("#flowsQ", "input", debounce((e) => { flowsQ = e.target.value.trim(); rerender(); }, 250));
      el.querySelectorAll("[data-ftag]").forEach((b) => b.addEventListener("click", () => { flowsTag = b.dataset.ftag; rerender(); }));
      el.querySelectorAll("[data-fsrc]").forEach((b) => b.addEventListener("click", () => { flowsSource = b.dataset.fsrc; rerender(); }));

      on("#flowsImport", "click", () => $("#flowsFile").click());
      on("#flowsFile", "change", async (e) => {
        const file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        const hide = window.WB.showLoading ? window.WB.showLoading("解析账单中...") : null;
        try {
          const res = await importFile(file);
          if (hide) hide();
          if (res.cancelled) return;
          if (res.err) { window.WB.showToast("导入失败：" + res.err, "error"); return; }
          window.WB.showToast(`导入完成：新增 ${res.added} 条${res.dup ? `，重复跳过 ${res.dup} 条` : ""}`, "success");
          rerender();
        } catch (err) {
          if (hide) hide();
          window.WB.showToast("导入出错：" + ((err && err.message) || err), "error");
        }
      });

      on("#flowsClear", "click", async () => {
        if (!confirm("清空全部消费流水？正式账本不受影响，但外部明细将无法恢复（建议先留好原始账单文件）。")) return;
        await flowsRepo.clear();
        flowsMonth = ""; flowsTag = ""; flowsQ = "";
        rerender();
      });

      on("#flowList", "click", async (e) => {
        const btn = e.target.closest('[data-act="del-flow"]');
        if (!btn) return;
        const id = btn.dataset.id;
        if (!confirm("删除这条流水？")) return;
        await flowsRepo.delete(id);
        rerender();
      });
    },
  };
})();
