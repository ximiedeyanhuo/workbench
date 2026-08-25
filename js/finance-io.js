/**
 * finance-io.js — 记账导入/导出引擎（从 finance.js 拆出，自包含无视图状态）
 * 依赖：finance.js 必须先加载（提供 WB.finU 工具集）。
 * 支持：本站导出格式、海豚云记录格式；CSV（含 GBK 降级）与 xlsx/xlsm（SheetJS 按需加载）；
 *       双道去重（id + 内容指纹）、未知分类自动新建、防 CSV 公式注入。
 */
(function () {
  "use strict";

  const { nowStamp, catOf, typeLabel } = window.WB.finU;
  const { repo, getSetting, setSetting, uid } = window.WB;
  const financeRepo = repo("finance");

  /** 通用 CSV 下载（\uFEFF BOM：让 Excel 正确识别 UTF-8 中文） */
  function downloadCsv(filename, rows, cats) {
    const head = "日期,类型,分类,金额,备注";
    // 防 CSV 公式注入：以 = + - @ 或制表符开头的单元格前加单引号
    const safeCsv = (v) => {
      const s = String(v == null ? "" : v);
      return /^[=+\-@\t]/.test(s) ? "'" + s : s;
    };
    const lines = rows.map((t) => {
      const c = catOf(cats, t.type, t.category);
      // CSV 转义：字段含逗号/引号/换行时用双引号包裹
      const note = /[",\n]/.test(t.note) ? `"${t.note.replace(/"/g, '""')}"` : t.note;
      return [safeCsv(t.date), safeCsv(typeLabel(t.type)), safeCsv(c.name), safeCsv(t.amount), note].join(",");
    });
    const blob = new Blob(["\uFEFF" + head + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- 导入 ----------
  const TYPE_BY_LABEL = { 收入: "income", 支出: "expense", 储蓄: "saving" };
  const IMPORT_CAT_COLORS = ["#FF5A36", "#3B82F6", "#F59E0B", "#8B5CF6", "#EC4899", "#10B981", "#06B6D4", "#75726B"];

  /** 判断引号是否会在本行内闭合（用于「字段开头的 " 是否是合法引号」）：
   *  能闭合才按引号解析；否则视为备注里的普通字符（如 6.7"手机、行首裸引号），
   *  避免单个裸引号把后续所有行吞并成一行导致「解析到 1 行」。 */
  function lineHasClosingQuote(text, start) {
    for (let j = start + 1; j < text.length; j++) {
      const c = text[j];
      if (c === "\n" || c === "\r") return false;
      if (c === '"') {
        if (text[j + 1] === '"') { j++; continue; } // "" 转义对，跳过
        return true;
      }
    }
    return false;
  }

  /** 通用 CSV 解析（支持引号包裹、"" 转义、\r\n / \n），返回 string[][]，跳过全空行。
   *  容错：只有「字段开头且本行内能闭合」的 " 才当引号，备注里的裸引号按字面处理。 */
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += ch;
      } else if (ch === '"' && field === "" && lineHasClosingQuote(text, i)) inQ = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f.trim() !== "")) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    return rows;
  }

  /** 读取 CSV 文件：先按 UTF-8 解码；若表头识别失败（Excel 另存的 GBK/ANSI 中文文件
   *  按 UTF-8 解码会产生乱码），再尝试 GBK 解码兜底。 */
  async function decodeCsvFile(file) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder("utf-8").decode(buf);
    const first = parseCsv(text)[0] || [];
    if (mapCsvHeader(first)) return text;
    try {
      text = new TextDecoder("gbk").decode(buf);
    } catch (e) { /* 浏览器不支持 gbk 时保持乱码原文，由导入环节报「无法识别表头」 */ }
    return text;
  }

  /** 识别表头列位置：兼容本站导出（日期,类型,分类,金额,备注）与
   *  海豚云记录（金额(元),交易日期,收/支,收/支类型,备注）。
   *  判断顺序关键：先精确匹配类型列（收/支 或 类型），再模糊匹配分类列，
   *  避免「收/支类型」被误认为类型列。 */
  function mapCsvHeader(header) {
    const idx = { amount: -1, date: -1, type: -1, cat: -1, note: -1 };
    header.forEach((h, i) => {
      const s = String(h).replace(/\s/g, "");
      if (idx.amount < 0 && s.includes("金额")) idx.amount = i;
      else if (idx.date < 0 && s.includes("日期")) idx.date = i;
      else if (idx.type < 0 && (s === "收/支" || s === "类型" || s === "收支")) idx.type = i;
      else if (idx.cat < 0 && (s.includes("类型") || s.includes("分类"))) idx.cat = i;
      else if (idx.note < 0 && s.includes("备注")) idx.note = i;
    });
    return idx.amount >= 0 && idx.date >= 0 && idx.type >= 0 ? idx : null;
  }

  /** 日期规整为 YYYY-MM-DD（兼容 2026/7/3、2026.07.03） */
  function normImportDate(s) {
    const m = String(s).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    return m ? m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0") : "";
  }

  /** 导入核心：rows 为二维数组（含表头行），确认后批量入库，未知分类自动建为自定义分类。
   *  返回 {added, skipped, newCats} / {cancelled} / {err}。 */
  async function importRows(rows, cats) {
    if (rows.length < 2) return { err: "文件为空或只有表头" };
    const idx = mapCsvHeader(rows[0]);
    if (!idx) return { err: "无法识别表头，需包含金额、日期、收/支（类型）三列" };

    // 分类名 → id 映射；未知分类攒到 catAdd 统一新建
    const nameToId = {
      income: new Map(cats.income.map((c) => [c.name, c.id])),
      expense: new Map(cats.expense.map((c) => [c.name, c.id])),
    };
    const catAdd = { income: [], expense: [] };
    let records = [];
    let skipped = 0;
    const stamp = nowStamp();
    for (const r of rows.slice(1)) {
      const type = TYPE_BY_LABEL[String(r[idx.type] || "").trim()];
      const amount = parseFloat(String(r[idx.amount] || "").replace(/[,，¥￥\s]/g, ""));
      const date = normImportDate(r[idx.date]);
      if (!type || !(amount > 0) || !date) { skipped++; continue; }
      let category = "saving";
      if (type !== "saving") {
        const name = String(idx.cat >= 0 ? r[idx.cat] || "" : "").trim() || (type === "income" ? "其它收入" : "其它支出");
        let cid = nameToId[type].get(name);
        if (!cid) {
          cid = "c" + uid();
          nameToId[type].set(name, cid);
          catAdd[type].push({ id: cid, name, color: IMPORT_CAT_COLORS[(catAdd.income.length + catAdd.expense.length) % IMPORT_CAT_COLORS.length] });
        }
        category = cid;
      }
      records.push({
        id: uid(), type, amount, category,
        note: String(idx.note >= 0 ? r[idx.note] || "" : "").trim(),
        date, createdAt: stamp, updatedAt: stamp,
      });
    }
    if (!records.length) return { err: `没有可导入的有效行（跳过 ${skipped} 行）` };

    // 去重两道闸：
    // 1) id 命中（自己导的重复文件）; 2) 内容指纹（date|type|amount|note|category 与已有重复，跨来源也拦）。
    //    指纹含 category：同日同额同注但分类不同的两行是不同交易，不再被误判为重复
    const existing = await financeRepo.list();
    const existingIds = new Set(existing.map((r) => r.id));
    const contentHash = (r) => [r.date || "", r.type || "", String(r.amount || 0), (r.note || "").trim(), r.category || ""].join("|");
    const existingHashes = new Set(existing.map(contentHash));
    const before = records.length;
    const idDup = records.filter((r) => existingIds.has(r.id)).length;
    records = records.filter((r) => !existingIds.has(r.id));
    const hashesSeen = new Set(existingHashes);
    const contentDup = [];
    records = records.filter((r) => {
      const h = contentHash(r);
      if (hashesSeen.has(h)) { contentDup.push(r); return false; }
      hashesSeen.add(h);
      return true;
    });
    const deduped = before - records.length;
    if (!records.length) return { err: `所有 ${before} 条记录均已存在或内容重复，无需导入` };
    skipped += deduped;

    const newCats = catAdd.income.concat(catAdd.expense).map((c) => c.name);
    let msg = `解析到 ${rows.length - 1} 行，可导入 ${records.length} 条`;
    if (idDup) msg += `，id 已存在跳过 ${idDup} 条`;
    if (contentDup.length) msg += `，内容重复跳过 ${contentDup.length} 条`;
    if (skipped) msg += `，无效跳过 ${skipped} 行`;
    if (newCats.length) msg += `\n将自动新建分类：${newCats.join("、")}`;
    if (!window.confirm(msg + "\n\n确认导入？")) return { cancelled: true };

    if (newCats.length) {
      const cur = await getSetting("finCategories", { income: [], expense: [] });
      cur.income = (cur.income || []).concat(catAdd.income);
      cur.expense = (cur.expense || []).concat(catAdd.expense);
      await setSetting("finCategories", cur);
    }
    await financeRepo.bulkPut(records);
    // 导入走整段失效（低频操作，正确性优先）：下次 render 重新全量拉取
    if (window.WB.finCache) window.WB.finCache.invalidate();
    return { added: records.length, skipped, newCats, addedDates: records.map((r) => r.date) };
  }

  /** 解析 CSV 文本并导入（confirm 在 importRows 内） */
  async function importCsvText(text, cats) {
    return importRows(parseCsv(text), cats);
  }

  /** 解析 xlsx/xlsm（SheetJS mini，cellDates 让日期单元格变为 Date）并导入。
   *  单元格统一转字符串：Date 用本地时间取年月日，避免 toISOString 的 UTC 偏移差一天。 */
  async function importXlsxFile(file, cats) {
    if (typeof XLSX === "undefined") {
      // xlsx 只在导入时才需要：按需拉取（SW 有预缓存，离线也能取到）
      try { await window.WB.loadScript("/lib/xlsx.mini.min.js"); } catch (e) { return { err: "xlsx 解析库加载失败，请检查网络后重试" }; }
    }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const name = wb.SheetNames[0];
    if (!name) return { err: "文件中没有工作表" };
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
    const norm = rows.map((r) => r.map((v) => {
      if (v instanceof Date) {
        return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0");
      }
      return v == null ? "" : String(v);
    }));
    return importRows(norm, cats);
  }

  window.WB.finIO = { downloadCsv, decodeCsvFile, importCsvText, importXlsxFile };
})();
