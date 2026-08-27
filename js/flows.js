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
  let flowsPage = 1;     // 列表分页（每页 20 条）
  let flowsTrendMode = "recent"; // 趋势图：recent = 近 6 月 | year = 今年逐月
  let _totalPages = 1;
  let _trendRows = [];   // 趋势图数据源（随标签/来源/关键词筛选，忽略月份——趋势天然跨月）
  let _charts = [];      // 图表实例注册表（重渲染前销毁）
  const _state = { all: [] }; // 当前全量数据快照（供编辑/导出查找）

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

  /** 定位表头行：同时含「金额」和「收/支或类型」的行（跳过文件开头的元数据说明） */
  function findHeaderRow(rows) {
    return rows.findIndex((r) => {
      const cells = r.map((c) => String(c).replace(/\s/g, ""));
      return cells.some((c) => c.includes("金额")) && cells.some((c) => c.includes("收/支") || c.includes("收支") || c.includes("类型"));
    });
  }

  /** 表头特征计分判源：微信独有「支付方式/当前状态/交易类型」，
   *  支付宝独有「交易创建时间/交易号/商家订单号/交易来源地/资金状态」。
   *  两家共有的子串（如「交易时间」⊂「交易创建时间」的反例）不参与计分，杜绝顺序依赖误判。 */
  function detectFormat(header) {
    const has = (kw) => header.some((c) => String(c).replace(/\s/g, "").includes(kw));
    let w = 0, a = 0;
    if (has("支付方式")) w += 2;
    if (has("当前状态")) w += 1;
    if (has("交易类型")) w += 1;
    if (has("交易创建时间")) a += 2;
    if (has("交易号") || has("商家订单号")) a += 2;
    if (has("交易来源地") || has("资金状态")) a += 1;
    if (w > a) return "wechat";
    if (a > w) return "alipay";
    return null;
  }

  /** 读账单文件：xlsx 走 SheetJS，csv 先 UTF-8 后 GBK 降级；
   *  表头特征计分自动识别微信/支付宝格式（不依赖扩展名与尝试顺序）。 */
  async function readTableFile(file) {
    let rows = null;
    let decodeErr = "没找到账单表头（需包含金额和收/支或类型列）";
    if (/\.xlsx$|\.xlsm$/i.test(file.name)) {
      if (typeof XLSX === "undefined") {
        try { await window.WB.loadScript("/lib/xlsx.mini.min.js"); } catch (e) { return { err: "xlsx 解析库加载失败，请检查网络后重试" }; }
      }
      const buf = await file.arrayBuffer();
      let wb;
      try { wb = XLSX.read(buf, { type: "array", cellDates: true }); } catch (e) { return { err: "文件解析失败：不是有效的 xlsx 文件" }; }
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
      // 微信账单的「交易时间」是日期单元格：cellDates 会解析成 Date 对象，
      // 必须统一转回本地 "YYYY-MM-DD HH:MM:SS" 字符串，否则日期匹配全部失败
      rows = rows.map((r) => r.map((v) => {
        if (v instanceof Date) {
          return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0")
            + " " + String(v.getHours()).padStart(2, "0") + ":" + String(v.getMinutes()).padStart(2, "0") + ":" + String(v.getSeconds()).padStart(2, "0");
        }
        return v == null ? "" : String(v);
      }));
    } else {
      const buf = await file.arrayBuffer();
      const attempts = [new TextDecoder("utf-8").decode(buf)];
      try { attempts.push(new TextDecoder("gbk").decode(buf)); } catch (e) { /* 浏览器不支持 gbk 就只试 utf-8 */ }
      for (const text of attempts) {
        const rs = window.WB.finIO.parseCsv(text);
        if (findHeaderRow(rs) >= 0) { rows = rs; break; } // 乱码解码找不到表头 → 换下一种编码
      }
    }
    if (!rows) return { err: decodeErr };
    const hi = findHeaderRow(rows);
    const fmt = hi >= 0 ? detectFormat(rows[hi]) : null;
    if (!fmt) return { err: "无法识别账单来源：表头不是微信/支付宝格式（可把表头前两行发我加适配）" };
    return fmt === "wechat" ? mapWechatRows(rows) : mapAlipayRows(rows);
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
    const importStamp = new Date().toISOString();
    for (const r of rows) {
      r.id = uid();
      r.tag = tagOf(r.direction, r.rawType, r.counterparty, r.note);
      const h = hash(r);
      if (seen.has(h)) { dup++; continue; }
      seen.add(h);
      // updatedAt 仅作乐观锁基线，统一在指纹计算后补戳（若未来 hash 纳入全字段也不破坏去重）
      r.updatedAt = importStamp;
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

    // 分页：大数据量（千条级）避免一次渲染全部 DOM
    const PAGE_SIZE = 20;
    _totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (flowsPage > _totalPages) flowsPage = _totalPages;
    const pageRows = list.slice((flowsPage - 1) * PAGE_SIZE, flowsPage * PAGE_SIZE);
    const pageBar = _totalPages > 1 ? `<div class="flow-pagebar">
      <button class="icon-btn plain" data-fpage="prev" title="上一页" ${flowsPage <= 1 ? "disabled" : ""}>${window.WB.icon("prev")}</button>
      <span class="tx-day-sub">第 ${flowsPage} / ${_totalPages} 页</span>
      <button class="icon-btn plain" data-fpage="next" title="下一页" ${flowsPage >= _totalPages ? "disabled" : ""}>${window.WB.icon("next")}</button>
    </div>` : "";

    // 趋势图数据源：同筛选但忽略月份（跨月才有趋势意义）
    _trendRows = all.filter((r) => {
      if (flowsTag && r.tag !== flowsTag) return false;
      if (flowsSource && r.source !== flowsSource) return false;
      if (flowsQ) {
        const q = flowsQ.toLowerCase();
        const hit = String(r.counterparty || "").toLowerCase().includes(q) || String(r.note || "").toLowerCase().includes(q) || String(r.rawType || "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });

    // 小计（当前筛选范围）
    const sumOf = (tag) => list.filter((r) => !tag || r.tag === tag).reduce((s, r) => s + Number(r.amount || 0), 0);
    const consume = sumOf("消费"), income = sumOf("收入");

    // 交易对方 TOP5：聚焦当前标签（未选标签时默认看消费）
    const topTag = flowsTag || "消费";
    const byParty = {};
    list.filter((r) => r.tag === topTag).forEach((r) => {
      const k = r.counterparty || "(无对方)";
      if (!byParty[k]) byParty[k] = { n: 0, sum: 0 };
      byParty[k].n += 1;
      byParty[k].sum += Number(r.amount || 0);
    });
    const top5 = Object.entries(byParty).sort((a, b) => b[1].sum - a[1].sum).slice(0, 5);
    const topHtml = top5.length
      ? top5.map(([name, v]) => `<div class="flow-top-item"><span class="flow-top-name">${esc(name)}</span><span class="flow-top-meta">${v.n} 次 · <b>${fmtYuan(v.sum)}</b></span></div>`).join("")
      : `<div class="empty">当前范围没有${topTag}记录</div>`;

    // 交易类型分布：当前标签范围内按 rawType 聚合（微信的商户消费/红包/转账…很有信息量）
    const byType = {};
    list.filter((r) => r.tag === topTag).forEach((r) => {
      const k = r.rawType || "未分类";
      if (!byType[k]) byType[k] = { n: 0, sum: 0 };
      byType[k].n += 1;
      byType[k].sum += Number(r.amount || 0);
    });
    const typeTotal = Object.values(byType).reduce((s, v) => s + v.sum, 0);
    const typeTop = Object.entries(byType).sort((a, b) => b[1].sum - a[1].sum).slice(0, 5);
    const typeHtml = typeTop.length
      ? typeTop.map(([name, v]) => {
          const pct = typeTotal > 0 ? Math.round((v.sum / typeTotal) * 100) : 0;
          return `<div class="flow-type-item">
            <div class="flow-type-line"><span class="flow-top-name">${esc(name)}</span><span class="flow-top-meta">${v.n} 次 · ${fmtYuan(v.sum)} · ${pct}%</span></div>
            <div class="flow-type-bar"><i style="width:${pct}%"></i></div>
          </div>`;
        }).join("")
      : `<div class="empty">当前范围没有${topTag}记录</div>`;

    // 关键数字：日均消费 / 最大单笔 / 来源占比（消费口径）
    const consumeRows = list.filter((r) => r.tag === "消费");
    const consumeSum = consumeRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    let days = 0;
    if (flowsMonth) {
      days = new Date(Number(flowsMonth.slice(0, 4)), Number(flowsMonth.slice(5, 7)), 0).getDate();
    } else {
      const ds = list.map((r) => r.date).filter(Boolean).sort();
      days = ds.length ? Math.max(1, Math.round((new Date(ds[ds.length - 1]) - new Date(ds[0])) / 86400000) + 1) : 0;
    }
    const dailyAvg = days > 0 ? consumeSum / days : 0;
    const maxRow = consumeRows.slice().sort((a, b) => b.amount - a.amount)[0];
    const bySrc = {};
    consumeRows.forEach((r) => { const k = SOURCE_NAME[r.source] || r.source || "其他"; bySrc[k] = (bySrc[k] || 0) + Number(r.amount || 0); });
    const srcHtml = Object.entries(bySrc).sort((a, b) => b[1] - a[1]).map(([name, v]) => {
      const pct = consumeSum > 0 ? Math.round((v / consumeSum) * 100) : 0;
      return `<div class="flow-type-line"><span class="flow-top-name">${esc(name)}</span><span class="flow-top-meta">${fmtYuan(v)} · ${pct}%</span></div><div class="flow-type-bar"><i style="width:${pct}%"></i></div>`;
    }).join("");

    // 年度汇总：按年聚合（跟随标签/来源/关键词，忽略月份）
    const byYear = {};
    _trendRows.forEach((r) => {
      const y = (r.date || "").slice(0, 4);
      if (!y) return;
      if (!byYear[y]) byYear[y] = { consume: 0, income: 0, n: 0 };
      byYear[y].n += 1;
      if (r.tag === "消费") byYear[y].consume += Number(r.amount || 0);
      else if (r.tag === "收入") byYear[y].income += Number(r.amount || 0);
    });
    const curYear = String(new Date().getFullYear());
    const yearRows = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
    const yearHtml = yearRows.length
      ? `<table class="flow-year-table"><thead><tr><th>年份</th><th>消费</th><th>收入</th><th>笔数</th></tr></thead><tbody>
        ${yearRows.map((y) => `<tr class="${y === curYear ? "cur" : ""}"><td>${y}${y === curYear ? " · 今年" : ""}</td><td>${fmtYuan(byYear[y].consume)}</td><td>${fmtYuan(byYear[y].income)}</td><td>${byYear[y].n}</td></tr>`).join("")}
      </tbody></table>`
      : `<div class="empty">暂无数据</div>`;

    const monthOpts = ['<option value=""' + (flowsMonth ? "" : " selected") + '>全部月份</option>']
      .concat(months.map((m) => `<option value="${m}" ${flowsMonth === m ? "selected" : ""}>${m}</option>`)).join("");
    const tagChips = ['<button class="tab ' + (flowsTag === "" ? "on" : "") + '" data-ftag="">全部</button>']
      .concat(TAGS.map((t) => `<button class="tab ${flowsTag === t ? "on" : ""}" data-ftag="${t}">${t}</button>`)).join("");
    const srcChips = ['<button class="tab ' + (flowsSource === "" ? "on" : "") + '" data-fsrc="">全部来源</button>']
      .concat(Object.keys(SOURCE_NAME).map((s) => `<button class="tab ${flowsSource === s ? "on" : ""}" data-fsrc="${s}">${SOURCE_NAME[s]}</button>`)).join("");

    // 按日期分组（仅当前页）
    const byDate = {};
    pageRows.forEach((r) => { (byDate[r.date] = byDate[r.date] || []).push(r); });
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
              <button class="icon-btn" data-act="edit-flow" data-id="${esc(r.id)}" title="编辑">${window.WB.icon("edit")}</button>
              <button class="icon-btn" data-act="del-flow" data-id="${esc(r.id)}" title="删除">${window.WB.icon("del")}</button>
            </li>`;
          }).join("");
          const dayConsume = byDate[d].filter((r) => r.tag === "消费").reduce((s, r) => s + Number(r.amount || 0), 0);
          return `<div class="tx-day"><div class="tx-day-head">${d}<span class="tx-day-sub">消费 ${fmtYuan(dayConsume)}</span></div><ul class="tx-list">${rows}</ul></div>`;
        }).join("") + pageBar
      : `<div class="empty">${all.length ? "当前筛选没有匹配的流水" : "还没有导入过账单。把微信/支付宝的账单文件存进来，消费明细随时可查，且不影响正式账本。"}</div>`;

    return `<div class="card">
      <div class="row sp-b-md">
        <h2 style="margin:0">消费流水 <span class="count">外部仓库 · 不计入统计</span></h2>
        <div class="row">
          <button class="btn sm ghost" id="flowsImport">导入账单</button>
          <input type="file" id="flowsFile" accept=".csv,text/csv,.xlsx,.xlsm" hidden />
          <button class="btn sm ghost" id="flowsExport">导出</button>
          <button class="btn danger sm" id="flowsClear">清空</button>
        </div>
      </div>
      <div class="row sp-b-md" style="flex-wrap:wrap;gap:8px">
        <select id="flowsMonth" class="w-130" title="月份">${monthOpts}</select>
        <div class="tx-stat-seg">${tagChips}</div>
        <div class="tx-stat-seg">${srcChips}</div>
        <input id="flowsQ" placeholder="搜交易对方 / 商品…" value="${esc(flowsQ)}" class="w-150" />
      </div>
      <div class="row sp-b-sm" style="gap:16px;flex-wrap:wrap">
        ${TAGS.map((t) => `<span>${t} <b style="color:${TAG_COLOR[t]}">${fmtYuan(sumOf(t))}</b></span>`).join("")}
        <span class="tx-day-sub">共 ${list.length} 条</span>
      </div>
      ${list.length ? `<div class="flow-stat-grid sp-b-sm">
        <div>
          <div class="tx-day-head">交易对方 TOP5 · ${esc(topTag)}</div>
          ${topHtml}
        </div>
        <div>
          <div class="tx-day-head" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span>消费 / 收入趋势</span>
            <span class="tx-stat-seg">
              <button class="tab ${flowsTrendMode === "recent" ? "on" : ""}" data-tmode="recent">近 6 月</button>
              <button class="tab ${flowsTrendMode === "year" ? "on" : ""}" data-tmode="year">今年逐月</button>
            </span>
          </div>
          <div class="tx-chart-wrap"><canvas id="flowTrend" height="170"></canvas></div>
        </div>
        <div>
          <div class="tx-day-head">交易类型分布 · ${esc(topTag)}</div>
          ${typeHtml}
        </div>
        <div>
          <div class="tx-day-head">关键数字 · 消费</div>
          <div class="flow-kpi"><span>日均消费（${days > 0 ? days + " 天" : "无数据"}）</span><b>${fmtYuan(dailyAvg)}</b></div>
          <div class="flow-kpi"><span>最大单笔</span><b>${fmtYuan(maxRow ? maxRow.amount : 0)}</b>${maxRow ? `<em>${esc(maxRow.counterparty || "")}</em>` : ""}</div>
          <div class="flow-kpi" style="border-bottom:none"><span>来源占比</span></div>
          ${srcHtml || '<div class="empty">无消费记录</div>'}
        </div>
        <div class="flow-span2">
          <div class="tx-day-head">年度汇总</div>
          ${yearHtml}
        </div>
      </div>` : ""}
      <div id="flowList">${listHtml}</div>
    </div>`;
  }

  function fmtYuan(n) {
    return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------- 统计图表 ----------
  function destroyCharts() {
    _charts.forEach((c) => c.destroy());
    _charts = [];
  }

  /** 近 6 月消费/收入柱图（数据源随标签/来源/关键词筛选，忽略月份） */
  function renderTrend(el) {
    destroyCharts();
    const cv = el.querySelector("#flowTrend");
    if (!cv) return;
    if (typeof Chart === "undefined") {
      // Chart.js 懒加载：加载完成重试；期间已切走路由则放弃（防污染新页面）
      window.WB.loadScript("/lib/chart.umd.min.js").then(() => {
        if (/^#\/flows/.test(location.hash || "")) renderTrend(el);
      }).catch(() => {});
      return;
    }
    const now = new Date();
    let months;
    if (flowsTrendMode === "year") {
      const y = now.getFullYear();
      months = Array.from({ length: 12 }, (_, i) => y + "-" + String(i + 1).padStart(2, "0"));
    } else {
      months = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
      }
    }
    const consumeArr = months.map((m) => _trendRows.filter((r) => r.tag === "消费" && (r.date || "").slice(0, 7) === m).reduce((s, r) => s + Number(r.amount || 0), 0));
    const incomeArr = months.map((m) => _trendRows.filter((r) => r.tag === "收入" && (r.date || "").slice(0, 7) === m).reduce((s, r) => s + Number(r.amount || 0), 0));
    if (!consumeArr.some((v) => v > 0) && !incomeArr.some((v) => v > 0)) return;
    const muted = window.WB.cssVar("--muted"), line = window.WB.cssVar("--line"), ok = window.WB.cssVar("--ok"), danger = window.WB.cssVar("--danger");
    _charts.push(new Chart(cv, {
      type: "bar",
      data: {
        labels: months.map((m) => m.slice(2)),
        datasets: [
          { label: "消费", data: consumeArr, backgroundColor: danger, borderRadius: 6 },
          { label: "收入", data: incomeArr, backgroundColor: ok, borderRadius: 6 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", labels: { color: muted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, padding: 8 } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} ${fmtYuan(c.parsed.y)} 元` } },
        },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 } }, grid: { color: line } },
        },
      },
    }));
  }

  routes.flows = {
    title: "消费流水",
    async render(el) {
      const all = await flowsRepo.list();
      _state.all = all;
      destroyCharts();
      el.innerHTML = flowsHtml(all);
      renderTrend(el);

      const rerender = () => routes.flows.render(el);
      const $ = (sel) => el.querySelector(sel);
      const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };

      on("#flowsMonth", "change", (e) => { flowsMonth = e.target.value; flowsPage = 1; rerender(); });
      on("#flowsQ", "input", debounce((e) => { flowsQ = e.target.value.trim(); flowsPage = 1; rerender(); }, 250));
      el.querySelectorAll("[data-ftag]").forEach((b) => b.addEventListener("click", () => { flowsTag = b.dataset.ftag; flowsPage = 1; rerender(); }));
      el.querySelectorAll("[data-fsrc]").forEach((b) => b.addEventListener("click", () => { flowsSource = b.dataset.fsrc; flowsPage = 1; rerender(); }));
      el.querySelectorAll("[data-fpage]").forEach((b) => b.addEventListener("click", () => {
        if (b.dataset.fpage === "prev" && flowsPage > 1) flowsPage--;
        else if (b.dataset.fpage === "next" && flowsPage < _totalPages) flowsPage++;
        rerender();
      }));
      el.querySelectorAll("[data-tmode]").forEach((b) => b.addEventListener("click", () => {
        if (flowsTrendMode !== b.dataset.tmode) { flowsTrendMode = b.dataset.tmode; rerender(); }
      }));

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

      on("#flowsExport", "click", () => {
        const all = _state.all || [];
        const rows = all.filter((r) => {
          if (flowsMonth && !(r.date || "").startsWith(flowsMonth)) return false;
          if (flowsTag && r.tag !== flowsTag) return false;
          if (flowsSource && r.source !== flowsSource) return false;
          if (flowsQ && !(r.counterparty || "").includes(flowsQ) && !(r.note || "").includes(flowsQ) && !(r.detail || "").includes(flowsQ)) return false;
          return true;
        });
        if (!rows.length) { window.WB.showToast("当前筛选无数据可导出", "error"); return; }
        const fmt = (n) => Number(n || 0).toFixed(2);
        const csvRows = [["交易时间", "收支类型", "金额", "交易对方", "商品说明", "收/支", "交易类型", "当前状态", "来源"]].concat(
          rows.map((r) => [
            r.date || "", r.tag || "", fmt(r.amount), r.counterparty || "", r.note || "",
            r.direction === "in" ? "收入" : r.direction === "out" ? "支出" : "",
            r.rawType || "", r.status || "", SOURCE_NAME[r.source] || r.source || ""
          ])
        );
        const csv = csvRows.map((row) => row.map((cell) => String(cell).includes(",") || String(cell).includes('"') || String(cell).includes("\n") ? '"' + String(cell).replace(/"/g, '""') + '"' : String(cell)).join(",")).join("\n");
        const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `消费流水_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        window.WB.showToast(`已导出 ${rows.length} 条流水`, "success");
      });

      on("#flowsClear", "click", async () => {
        if (!confirm("清空全部消费流水？正式账本不受影响，但外部明细将无法恢复（建议先留好原始账单文件）。")) return;
        await flowsRepo.clear();
        flowsMonth = ""; flowsTag = ""; flowsQ = "";
        rerender();
      });

      el.addEventListener("click", async (e) => {
        const editBtn = e.target.closest('[data-act="edit-flow"]');
        if (editBtn) {
          e.stopPropagation();
          const li = editBtn.closest(".flow-li");
          if (!li || li.classList.contains("editing")) return;
          const id = editBtn.dataset.id;
          const rec = (_state.all || []).find((r) => r.id === id);
          if (!rec) return;
          const origParty = rec.counterparty || "";
          const origNote = rec.note || "";
          const origTag = rec.tag || "消费";
          const editBase = rec.updatedAt || "";
          li.classList.add("editing");
          li.innerHTML = `<div class="flow-edit-form">
            <div class="flow-edit-row"><label>交易对方</label><input class="flow-edit-party" value="${esc(origParty)}" /></div>
            <div class="flow-edit-row"><label>备注</label><input class="flow-edit-note" value="${esc(origNote)}" placeholder="可选" /></div>
            <div class="flow-edit-row"><label>标签</label><select class="flow-edit-tag">${TAGS.map((t) => `<option value="${t}" ${t === origTag ? "selected" : ""}>${t}</option>`).join("")}</select></div>
            <div class="flow-edit-actions">
              <button class="btn sm ghost flow-edit-save">保存</button>
              <button class="btn sm ghost flow-edit-cancel">取消</button>
            </div>
          </div>`;
          li.querySelector(".flow-edit-cancel").addEventListener("click", () => { rerender(); });
          li.querySelector(".flow-edit-save").addEventListener("click", async () => {
            const newParty = li.querySelector(".flow-edit-party").value.trim();
            const newNote = li.querySelector(".flow-edit-note").value.trim();
            const newTag = li.querySelector(".flow-edit-tag").value;
            const d = {};
            if (newParty !== origParty) d.counterparty = newParty;
            if (newNote !== origNote) d.note = newNote;
            if (newTag !== origTag) d.tag = newTag;
            if (Object.keys(d).length) {
              const existing = await flowsRepo.get(id);
              if (existing) {
                d.updatedAt = new Date().toISOString();
                try {
                  // 乐观锁：打开编辑后若被其他端改过，服务端 409 拒绝，防整行覆盖
                  await flowsRepo.put({ ...existing, ...d }, editBase ? { ifUpdated: editBase } : undefined);
                } catch (err) {
                  if (String((err && err.message) || "").indexOf("其他窗口") >= 0) {
                    window.WB.showToast("该流水已在其他窗口被修改，本次未保存；请刷新后对比", "error");
                    return;
                  }
                  throw err;
                }
              }
            }
            rerender();
          });
          return;
        }
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
