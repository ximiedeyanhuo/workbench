/**
 * finance.js — 记账：收入 / 支出 / 储蓄 三类交易 + 分类 + 月度概览 + 年度储蓄目标
 *
 * v3（按「海豚云记录」账务模块需求文档落地）：
 * - 模块拆分：「流水明细」卡（类型 tab + 记一笔 + 筛选 + 列表）与「统计」卡（日历 / 周账 / 月账 / 年账，全类型聚合不分收支 tab）
 *   · 周账：周一~周日聚合，含日均支出，金额可点跳明细（§3）
 *   · 月账：12 个月收入/支出/结余/日均支出/笔数（原"年账"，对齐文档更名，§4）
 *   · 年账：跨年聚合，点年份行跳当年月账（§5）
 * - 金额展示统一两位小数；结余 正+/负-/零 0.00（§0 / §9.2）
 * - 顶部汇总带笔数（§0）
 * - 列表筛选：分类 + 备注关键词 + 交易日期范围（起止）+ 重置（§1.2）
 * - 流水默认展示当年全部记录（当月数据少时更实用），明细卡顶部 ←→ 切年份
 * - 行操作：详细（展开看提交/修改时间）/ 编辑 / 复制（预填表单、日期改今天）/ 删除（§1.4）
 * - CSV 导出（UTF-8 BOM）：列表页导当前筛选结果；周/月/年账按行导出该期间明细（§0 / §7）
 * - CSV / xlsx 导入：兼容本站导出格式（日期,类型,分类,金额,备注）与海豚云记录格式；
 *   xlsx 走 SheetJS 解析（日期/数字/文本单元格自动识别，备注里的裸引号按字面处理）
 * - CSV 导入/导出移动端同样可用（支持本站导出、海豚云记录格式；Excel 另存的 GBK 文件自动降级解码）
 * - 分类管理：自定义分类的新增 / 删除（预置分类不可删）
 *
 * 数据兼容：老版 finance 记录只有 {id, amount, note, date}，读取时兜底为
 * type=saving、category=saving；老记录无 createdAt/updatedAt，详细里显示 "—"。
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, todayStr, fmtMoney, getSetting, setSetting, flashInvalid, cssVar } = window.WB;
  const financeRepo = repo("finance");

  // 预置分类（用户可通过分类管理追加自定义分类，存 settings.finCategories）
  const PRESET_CATS = {
    expense: [
      { id: "food",     name: "餐饮",     color: "#FF5A36" },
      { id: "traffic",  name: "交通",     color: "#3B82F6" },
      { id: "shopping", name: "购物",     color: "#F59E0B" },
      { id: "housing",  name: "居家",     color: "#8B5CF6" },
      { id: "fun",      name: "娱乐",     color: "#EC4899" },
      { id: "health",   name: "医疗健康", color: "#10B981" },
      { id: "study",    name: "学习",     color: "#06B6D4" },
      { id: "other-e",  name: "其它支出", color: "#75726B" },
    ],
    income: [
      { id: "salary",   name: "工资",     color: "#10B981" },
      { id: "bonus",    name: "奖金",     color: "#F59E0B" },
      { id: "invest",   name: "理财",     color: "#8B5CF6" },
      { id: "other-i",  name: "其它收入", color: "#3B82F6" },
    ],
  };
  const SAVING_CAT = { id: "saving", name: "储蓄", color: "#FF5A36" };
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

  const now = new Date();
  let finYear = now.getFullYear();
  let finAllYears = false;        // 流水明细：true = 全部年份（不影响统计卡/趋势等 finYear 共享方）
  let finMonth = now.getMonth();
  let finTab = "expense";
  let finStatView = "cal";      // 统计卡视图：cal | week | month | year（明细列表固定在明细卡）
  let finSelDay = null;          // 日历视图选中的日期 "YYYY-MM-DD"
  let finFilterCat = "";         // 列表分类筛选（"" = 全部）
  let finKeyword = "";           // 备注关键词
  let finDateStart = "";         // 交易日期范围-起（设了范围则列表跨月查询）
  let finDateEnd = "";           // 交易日期范围-止
  let finEditId = null;          // 行内编辑中的记录 id
  let finDetailId = null;        // 详细展开中的记录 id
  let finShowCatMgr = false;     // 分类管理面板开关

  let finCharts = []; // 重渲染前销毁旧 Chart 实例
  let finPage = 1;
  const FIN_PAGE_SIZE = 20;

  function monthKey(y, m) {
    return y + "-" + String(m + 1).padStart(2, "0");
  }

  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /** 该日期所在周的周一（ISO 周首日 = 周一） */
  function weekStartOf(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d)) return "";
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return ymd(d);
  }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function nowStamp() {
    const d = new Date();
    return ymd(d) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
  }

  // 金额展示：记账模块统一两位小数（需求 §0；全站 fmtMoney 千分位不动，仅本模块加小数）
  const fmtYuan = (n) => Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // 结余符号：正 + / 负 - / 零 0.00（需求 §9.2）
  const signedYuan = (n) => (n > 0.005 ? "+" + fmtYuan(n) : n < -0.005 ? "-" + fmtYuan(-n) : "0.00");

  /** 老记录兜底 */
  function normalizeTx(r) {
    return {
      id: r.id,
      type: r.type || "saving",
      amount: Number(r.amount || 0),
      category: r.category || (r.type === "saving" || !r.type ? "saving" : ""),
      note: r.note || "",
      date: r.date || "",
      createdAt: r.createdAt || "",
      updatedAt: r.updatedAt || "",
    };
  }

  function mergeCats(custom) {
    const c = custom || {};
    return {
      expense: PRESET_CATS.expense.concat(c.expense || []),
      income: PRESET_CATS.income.concat(c.income || []),
      saving: [SAVING_CAT],
    };
  }

  function catOf(cats, type, id) {
    const list = cats[type] || [];
    return list.find((c) => c.id === id) || { id, name: id || "未分类", color: "#A5A29A" };
  }

  function typeLabel(t) {
    if (t === "all") return "全部";
    return t === "expense" ? "支出" : t === "income" ? "收入" : "储蓄";
  }

  /** 收入/支出合计与笔数 */
  function sumBy(list, type) {
    const rows = list.filter((t) => t.type === type);
    return { amt: rows.reduce((s, t) => s + t.amount, 0), cnt: rows.length };
  }

  // ---------- HTML 片段 ----------
  function summaryHtml(mtx, ytx, txs) {
    const inc = sumBy(mtx, "income"), exp = sumBy(mtx, "expense");
    const yinc = sumBy(ytx, "income"), yexp = sumBy(ytx, "expense");
    const ynet = yinc.amt - yexp.amt;
    const allInc = sumBy(txs, "income"), allExp = sumBy(txs, "expense");
    const allNet = allInc.amt - allExp.amt;
    return `<div class="tx-summary">
      <div class="tx-total">
        <span class="tx-total-lab">累计结余</span>
        <span class="tx-total-val" style="color:${allNet >= 0 ? "var(--ok)" : "var(--danger)"}">${signedYuan(allNet)}</span>
      </div>
      <div class="tx-cards">
        <div class="tx-card">
          <span class="tx-card-lab">本月收入</span>
          <b class="c-ok">+${fmtYuan(inc.amt)}</b>
          <span class="tx-card-sub">${inc.cnt} 笔</span>
        </div>
        <div class="tx-card">
          <span class="tx-card-lab">本月支出</span>
          <b class="c-danger">-${fmtYuan(exp.amt)}</b>
          <span class="tx-card-sub">${exp.cnt} 笔</span>
        </div>
        <div class="tx-card">
          <span class="tx-card-lab">本年收入</span>
          <b class="c-ok">+${fmtYuan(yinc.amt)}</b>
          <span class="tx-card-sub">${yinc.cnt} 笔</span>
        </div>
        <div class="tx-card">
          <span class="tx-card-lab">本年支出</span>
          <b class="c-danger">-${fmtYuan(yexp.amt)}</b>
          <span class="tx-card-sub">${yexp.cnt} 笔</span>
        </div>
        <div class="tx-card">
          <span class="tx-card-lab">本年结余</span>
          <b style="color:${ynet >= 0 ? "var(--ok)" : "var(--danger)"}">${signedYuan(ynet)}</b>
        </div>
      </div>
    </div>`;
  }

  function goalHtml(saved, target, pct) {
    return `<div class="card">
      <h2>年度储蓄目标</h2>
      <div class="progress-top"><span>已存 ${fmtMoney(saved)} / ${fmtMoney(target)}</span><b>${pct}%</b></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="tx-goal-edit">
        目标金额 <input type="number" id="finTarget" value="${Number(target)}" min="0" /> 元 <span class="mla">仅统计「储蓄」类型</span>
      </div>
    </div>`;
  }

  /** 月度预算卡：本月支出 vs 预算，超支标红提醒（预算存 settings.monthBudget，0 = 未设） */
  function budgetHtml(mtx, budget) {
    const exp = sumBy(mtx, "expense").amt;
    const has = budget > 0;
    const pct = has ? Math.min(100, Math.round((exp / budget) * 100)) : 0;
    const over = has && exp > budget;
    const warn80 = has && !over && exp >= budget * 0.8;
    // 按本月已过天数推算"日均 × 全月天数 = 整月预计"；给"节奏失控"用户一个早期信号
    const todayD = new Date();
    const daysInMonth = new Date(todayD.getFullYear(), todayD.getMonth() + 1, 0).getDate();
    const passed = Math.max(1, todayD.getDate());
    const dailyAvg = exp / passed;
    const projFull = Math.round(dailyAvg * daysInMonth);
    const projOver = has && projFull > budget;
    const tip = !has
      ? '<div class="tx-budget-tip">设个预算，支出进度一目了然（仪表盘也会同步提醒）</div>'
      : over
        ? `<div class="tx-budget-tip over">⚠ 本月已超支 ${fmtYuan(exp - budget)} 元，注意控制开销</div>`
        : warn80
          ? `<div class="tx-budget-tip warn">已用掉预算的 ${pct}%，剩余 ${fmtYuan(budget - exp)} 元${projOver ? `；按当前日均 ${fmtYuan(dailyAvg)} 推算整月 ${fmtYuan(projFull)}，会超 ${fmtYuan(projFull - budget)}` : ""}</div>`
          : `<div class="tx-budget-tip">剩余 ${fmtYuan(budget - exp)} 元，节奏健康${has ? ` · 日均 ${fmtYuan(dailyAvg)}` : ""}</div>`;
    return `<div class="card ${over ? "card-over" : projOver ? "card-warn" : ""}" id="finBudgetCard">
      <h2>月度预算<span class="count">${finYear}年${finMonth + 1}月</span></h2>
      ${has ? `<div class="progress-top"><span>已支出 ${fmtYuan(exp)} / ${fmtYuan(budget)}</span><b style="${over ? "color:var(--danger)" : projOver ? "color:var(--warn)" : ""}">${pct}%</b></div>
      <div class="bar"><i style="width:${pct}%;${over ? "background:var(--danger)" : warn80 ? "background:var(--warn)" : ""}"></i></div>` : ""}
      ${tip}
      <div class="tx-goal-edit">
        每月预算 <input type="number" id="finBudget" value="${Number(budget) || ""}" min="0" placeholder="如 3000" /> 元 <span class="mla">仅统计「支出」类型</span>
      </div>
    </div>`;
  }

  /** 固定支出模板卡：房租/话费这类每月固定项一键记入今天（模板存 settings.finTemplates） */
  function templateHtml(cats, templates) {
    const rows = templates.length
      ? templates
          .map((tp) => {
            const c = catOf(cats, "expense", tp.category);
            return `<li class="item" data-tpl="${tp.id}">
              <span class="tx-dot" style="background:${esc(c.color)}"></span>
              <span class="txt">${esc(tp.name)}<div class="sub">${esc(c.name)} · ${fmtYuan(tp.amount)} 元</div></span>
              <button class="btn sm" data-act="use-tpl" title="按模板记一笔今天的支出">记入</button>
              <button class="icon-btn" data-act="del-tpl" title="删除模板">${WB.icon("del")}</button>
            </li>`;
          })
          .join("")
      : '<div class="empty">把房租、话费、会员这类固定支出存成模板，每月一键记入</div>';
    const catOpts = (cats.expense || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    return `<div class="card" id="finTplCard">
      <h2>固定支出模板<span class="count">${templates.length} 个</span></h2>
      <ul class="list">${rows}</ul>
      <div class="row sp-t-md">
        <input id="tplName" placeholder="名称，如：房租" class="w-110" maxlength="20" />
        <select id="tplCat">${catOpts}</select>
        <input type="number" id="tplAmount" placeholder="金额" class="w-90" min="0.01" step="0.01" />
        <button class="btn sm" id="tplAdd">存模板</button>
      </div>
    </div>`;
  }

  /** 定期账单卡：房贷/房租这类每月固定日期扣款项。auto=到日自动记入；remind=到期宽限 5 天内未记则提醒 */
  function schedHtml(cats, schedules) {
    const rows = schedules.length
      ? schedules
          .map((s) => {
            const c = catOf(cats, s.type === "income" ? "income" : "expense", s.category);
            const modeTxt = s.mode === "auto" ? "每月自动记入" : "到期提醒";
            return `<li class="item" data-sched="${s.id}">
              <span class="tx-dot" style="background:${esc(c.color)}"></span>
              <span class="txt">${esc(s.name)}<div class="sub">每月 ${s.dueDay} 号 · ${esc(c.name)} · ${fmtYuan(s.amount)} 元</div></span>
              <span class="badge ${s.mode === "auto" ? "b-ok" : "b-warn"}" data-act="toggle-sched" title="点击切换自动记入/到期提醒">${modeTxt}</span>
              <button class="icon-btn" data-act="del-sched" title="删除定期账单">${WB.icon("del")}</button>
            </li>`;
          })
          .join("")
      : '<div class="empty">把房贷、房租这类每月固定日期扣款设成定期账单：到日子自动记入，或到期未记提醒你</div>';
    const catOpts = (cats.expense || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    return `<div class="card" id="finSchedCard">
      <h2>定期账单<span class="count">${schedules.length} 项</span></h2>
      <ul class="list">${rows}</ul>
      <div class="stack-md sp-t-md">
        <div class="row">
          <input id="schedName" placeholder="名称，如：房贷" class="w-100" maxlength="20" />
          <select id="schedType"><option value="expense">支出</option><option value="income">收入</option></select>
          <select id="schedCat">${catOpts}</select>
          <input type="number" id="schedAmount" placeholder="金额" class="w-90" min="0.01" step="0.01" />
        </div>
        <div class="row">
          <span class="sub nowrap">每月</span>
          <input type="number" id="schedDay" placeholder="15" class="w-60" min="1" max="31" />
          <span class="sub nowrap">号自动记入 / 到期提醒</span>
          <button class="btn sm mla" id="schedAdd">添加</button>
        </div>
      </div>
    </div>`;
  }

  function chartCardHtml(mtx) {
    const expRows = mtx.filter((t) => t.type === "expense");
    if (!expRows.length) return "";
    const total = expRows.reduce((s, t) => s + t.amount, 0);
    const catSet = new Set(expRows.map((t) => t.category));
    return `<div class="card">
      <h2>本月支出分类</h2>
      <div class="tx-chart-meta">
        <span>本月支出 <b class="c-danger">${fmtYuan(total)}</b></span>
        <span>${catSet.size} 个分类</span>
      </div>
      <div class="tx-chart-wrap"><canvas id="chartExp" height="180"></canvas></div>
    </div>`;
  }

  function trendCardHtml(txs) {
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(finYear, finMonth - i, 1);
      months.push(monthKey(d.getFullYear(), d.getMonth()));
    }
    const incTotal = months.reduce((sum, m) => sum + txs.filter((t) => t.type === "income" && (t.date || "").slice(0, 7) === m).reduce((s, t) => s + t.amount, 0), 0);
    const expTotal = months.reduce((sum, m) => sum + txs.filter((t) => t.type === "expense" && (t.date || "").slice(0, 7) === m).reduce((s, t) => s + t.amount, 0), 0);
    const hasData = incTotal || expTotal;
    return `<div class="card">
      <h2>近 6 月收支</h2>
      <div class="tx-chart-meta">
        <span>收入 <b class="c-ok">+${fmtYuan(incTotal)}</b></span>
        <span>支出 <b class="c-danger">-${fmtYuan(expTotal)}</b></span>
      </div>
      ${hasData ? `<div class="tx-chart-wrap"><canvas id="chartTrend" height="180"></canvas></div>` : `<div class="empty tx-chart-empty">近 6 个月暂无收支记录</div>`}
    </div>`;
  }

  /** 单条流水（普通展示行；点行身展开详细） */
  function txItemHtml(cats, t) {
    const c = catOf(cats, t.type, t.category);
    const sign = t.type === "expense" ? "-" : "+";
    const color = t.type === "expense" ? "var(--danger)" : "var(--ok)";
    let html = `<li class="tx-item" data-id="${t.id}" data-type="${t.type}" title="点击查看详细">
      <span class="tx-dot" style="background:${esc(c.color)}"></span>
      <span class="tx-cat">${esc(c.name)}</span>
      <span class="tx-note">${esc(t.note)}</span>
      <span class="tx-amt" style="color:${color}">${sign}${fmtYuan(t.amount)}</span>
      <span class="tx-acts">
        <button class="icon-btn plain" data-act="copy-fin" title="复制为新记录">${WB.icon("copy")}</button>
        <button class="icon-btn plain" data-act="edit-fin" title="编辑">${WB.icon("edit")}</button>
        <button class="icon-btn" data-act="del-fin" title="删除">${WB.icon("del")}</button>
      </span>
    </li>`;
    if (t.id === finDetailId) {
      html += `<li class="tx-detail" data-id="${t.id}">
        <div><span>类型</span>${typeLabel(t.type)} · ${esc(c.name)}</div>
        <div><span>金额</span>${sign}${fmtYuan(t.amount)} 元</div>
        <div><span>交易日期</span>${esc(t.date) || "—"}</div>
        <div><span>备注</span>${esc(t.note) || "—"}</div>
        <div><span>提交时间</span>${esc(t.createdAt) || "—"}</div>
        <div><span>最后修改</span>${esc(t.updatedAt) || "—"}</div>
      </li>`;
    }
    return html;
  }

  /** 单条流水（行内编辑态） */
  function txEditHtml(cats, t) {
    const opts = (cats[t.type] || [])
      .map((c) => `<option value="${c.id}" ${c.id === t.category ? "selected" : ""}>${esc(c.name)}</option>`)
      .join("");
    return `<li class="tx-item tx-editing" data-id="${t.id}" data-type="${t.type}">
      <div class="row tx-edit-form">
        <select data-ed="cat">${opts}</select>
        <input type="number" data-ed="amount" value="${t.amount}" min="0" step="0.01" class="w-100" />
        <input data-ed="note" value="${esc(t.note)}" placeholder="备注" maxlength="40" class="grow" />
        <input type="date" data-ed="date" value="${esc(t.date)}" />
        <button class="btn sm" data-act="save-fin">保存</button>
        <button class="btn sm ghost" data-act="cancel-fin">取消</button>
      </div>
    </li>`;
  }

  /** 按日期分组的流水列表（混合类型时按各自类型着色） */
  function groupedListHtml(cats, list, emptyText) {
    if (!list.length) return `<div class="empty">${emptyText}</div>`;
    const byDate = {};
    list.forEach((t) => { (byDate[t.date] = byDate[t.date] || []).push(t); });
    return Object.keys(byDate)
      .sort((a, b) => b.localeCompare(a))
      .map((d) => {
        const rows = byDate[d];
        // 日小计：支出为负、其余为正
        const sub = rows.reduce((s, t) => s + (t.type === "expense" ? -t.amount : t.amount), 0);
        const items = rows.map((t) => (t.id === finEditId ? txEditHtml(cats, t) : txItemHtml(cats, t))).join("");
        return `<div class="tx-day">
          <div class="tx-day-head">${d}<span class="tx-day-sub">${signedYuan(sub)}</span></div>
          <ul class="tx-list">${items}</ul>
        </div>`;
      })
      .join("");
  }

  /** 列表数据源：设了日期范围按范围取；否则默认取 finYear 全年
   *  （当月数据太少，默认展示当年流水，明细卡顶部 ←→ 切年份；finAllYears=true 时查全部年份） */
  function scopedTx(txs) {
    if (finDateStart || finDateEnd) {
      return txs.filter((t) => (!finDateStart || t.date >= finDateStart) && (!finDateEnd || t.date <= finDateEnd));
    }
    if (finAllYears) return txs.filter((t) => t.date);
    return txs.filter((t) => t.date && t.date.slice(0, 4) === String(finYear));
  }

  function filteredTabTx(cats, txs) {
    const scope = scopedTx(txs);
    let tabTx = scope
      .filter((t) => finTab === "all" || t.type === finTab)
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.id || "").localeCompare(a.id || ""));
    if (finFilterCat) tabTx = tabTx.filter((t) => t.category === finFilterCat);
    if (finKeyword) tabTx = tabTx.filter((t) => (t.note || "").toLowerCase().includes(finKeyword.toLowerCase()));
    return tabTx;
  }

  function pageBarHtml(total, totalPages) {
    if (!total) return "";
    return `<div class="tx-page-bar">
      <span class="tx-page-info">共 ${total} 条 · 第 ${finPage}/${totalPages} 页</span>
      <div class="tx-page-btns">
        <button class="btn sm ghost" id="finPagePrev" ${finPage <= 1 ? "disabled" : ""}>上一页</button>
        <button class="btn sm ghost" id="finPageNext" ${finPage >= totalPages ? "disabled" : ""}>下一页</button>
      </div>
    </div>`;
  }

  /** 列表视图主体（应用类型 tab + 分类筛选 + 关键词 + 日期范围） */
  function buildListHtml(cats, txs) {
    const tabTx = filteredTabTx(cats, txs);
    const total = tabTx.length;
    const totalPages = Math.max(1, Math.ceil(total / FIN_PAGE_SIZE));
    if (finPage > totalPages) finPage = totalPages;

    // 筛选生效时：汇总跟随筛选口径（需求 §9.1），展示当前范围收入/支出/结余
    let sumBar = "";
    if (finFilterCat || finKeyword || finDateStart || finDateEnd) {
      let base = scopedTx(txs);
      if (finKeyword) base = base.filter((t) => (t.note || "").toLowerCase().includes(finKeyword.toLowerCase()));
      const inc = sumBy(base, "income"), exp = sumBy(base, "expense");
      sumBar = `<div class="tx-filter-sum">筛选范围：
        <b class="c-ok">收入 ${fmtYuan(inc.amt)} (${inc.cnt}笔)</b>
        <b class="c-danger">支出 ${fmtYuan(exp.amt)} (${exp.cnt}笔)</b>
        <b>结余 ${signedYuan(inc.amt - exp.amt)}</b>
        <span class="tx-cat-tip">当前列表：${typeLabel(finTab)} ${total} 笔</span>
      </div>`;
    }

    const pageTx = tabTx.slice((finPage - 1) * FIN_PAGE_SIZE, finPage * FIN_PAGE_SIZE);
    const empty = finFilterCat || finKeyword || finDateStart || finDateEnd
      ? "没有匹配的记录"
      : finAllYears ? (finTab === "all" ? "还没有任何记录" : `还没有${typeLabel(finTab)}记录`)
        : (finTab === "all" ? `${finYear}年还没有记录` : `${finYear}年还没有${typeLabel(finTab)}记录`);
    return sumBar + groupedListHtml(cats, pageTx, empty) + pageBarHtml(total, totalPages);
  }

  /** 日历视图：月历格子 + 选中日明细 */
  function buildCalHtml(cats, mtx) {
    const first = new Date(finYear, finMonth, 1);
    const days = new Date(finYear, finMonth + 1, 0).getDate();
    const lead = first.getDay();
    // 每日收支汇总
    const daily = {};
    mtx.forEach((t) => {
      const d = daily[t.date] = daily[t.date] || { income: 0, expense: 0 };
      if (t.type === "expense") d.expense += t.amount;
      else if (t.type === "income") d.income += t.amount;
    });
    const today = todayStr();

    let cells = WEEKDAYS.map((w) => `<div class="cal-wd">${w}</div>`).join("");
    for (let i = 0; i < lead; i++) cells += `<div class="cal-cell dim"></div>`;
    for (let d = 1; d <= days; d++) {
      const key = monthKey(finYear, finMonth) + "-" + String(d).padStart(2, "0");
      const agg = daily[key];
      const cls = ["cal-cell", "tx-cal-cell"];
      if (key === today) cls.push("today");
      if (key === finSelDay) cls.push("sel");
      // 格子小，金额用紧凑格式（不带两位小数）
      cells += `<div class="${cls.join(" ")}" data-day="${key}">
        <span class="d-num">${d}</span>
        ${agg && agg.income ? `<span class="tx-cal-in">+${fmtMoney(agg.income)}</span>` : ""}
        ${agg && agg.expense ? `<span class="tx-cal-out">-${fmtMoney(agg.expense)}</span>` : ""}
      </div>`;
    }

    // 选中日明细（全类型混合）
    let detail = `<div class="empty">点击日期查看当日明细</div>`;
    if (finSelDay) {
      const dayTx = mtx.filter((t) => t.date === finSelDay);
      detail = `<div class="tx-cal-detail-head">${finSelDay} 明细</div>` +
        groupedListHtml(cats, dayTx, "当日没有记录");
    }
    return `<div class="cal-grid" id="txCal">${cells}</div><div id="finCalList" class="sp-t-xl">${detail}</div>`;
  }

  /** 周账视图：finYear 内有记录的自然周（周一~周日），金额可点跳明细（需求 §3） */
  function buildWeekHtml(txs) {
    const byWeek = {};
    txs.forEach((t) => {
      if (!t.date) return;
      const ws = weekStartOf(t.date);
      if (ws.slice(0, 4) !== String(finYear)) return;
      (byWeek[ws] = byWeek[ws] || []).push(t);
    });
    const keys = Object.keys(byWeek).sort((a, b) => b.localeCompare(a));
    if (!keys.length) return `<div class="empty">${finYear}年还没有记录</div>`;

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
        <td><button class="icon-btn plain pc-only" data-act="exp-range" title="导出该周明细 CSV">${WB.icon("export")}</button></td>
      </tr>`;
    });
    return `<div class="tx-year-wrap" id="finWeekWrap"><table class="tx-year-table">
      <thead><tr><th>周（一~日）</th><th>收入</th><th>支出</th><th>结余</th><th>日均支出</th><th>笔数</th><th></th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>
    <div class="tx-year-tip">点收入/支出金额跳该周明细<span class="pc-only"> · ⤓ 导出该周全部流水</span></div>`;
  }

  /** 月账视图：finYear 12 个月汇总表（需求 §4；原"年账"更名） */
  function buildMonthHtml(txs) {
    const rows = [];
    let yIncome = 0, yExpense = 0, yInCnt = 0, yExCnt = 0;
    for (let m = 0; m < 12; m++) {
      const mk = monthKey(finYear, m);
      const list = txs.filter((t) => (t.date || "").slice(0, 7) === mk);
      const inc = sumBy(list, "income"), exp = sumBy(list, "expense");
      yIncome += inc.amt; yExpense += exp.amt; yInCnt += inc.cnt; yExCnt += exp.cnt;
      const net = inc.amt - exp.amt;
      const hasData = inc.amt || exp.amt;
      const daysInMonth = new Date(finYear, m + 1, 0).getDate();
      // 当月日均按已过天数算，过往月份按整月天数算
      const daysForAvg = (finYear === now.getFullYear() && m === now.getMonth()) ? Math.max(1, now.getDate()) : daysInMonth;
      rows.push(`<tr class="${hasData ? "tx-yr-row" : "tx-yr-row dim"}" data-month="${m}">
        <td>${m + 1}月</td>
        <td class="${inc.amt ? "tx-lnk" : ""}" data-jt="income" style="color:${inc.amt ? "var(--ok)" : "inherit"}">${inc.amt ? "+" + fmtYuan(inc.amt) : "—"}</td>
        <td class="${exp.amt ? "tx-lnk" : ""}" data-jt="expense" style="color:${exp.amt ? "var(--danger)" : "inherit"}">${exp.amt ? "-" + fmtYuan(exp.amt) : "—"}</td>
        <td style="color:${net >= 0 ? "var(--ok)" : "var(--danger)"}">${hasData ? signedYuan(net) : "—"}</td>
        <td class="tx-yr-cnt">${exp.amt ? fmtYuan(exp.amt / daysForAvg) : "—"}</td>
        <td class="tx-yr-cnt">${inc.cnt + exp.cnt || "—"}</td>
        <td>${hasData ? `<button class="icon-btn plain pc-only" data-act="exp-range" title="导出该月明细 CSV">${WB.icon("export")}</button>` : ""}</td>
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
  function buildYearHtml(txs) {
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
        <td>${hasData ? `<button class="icon-btn plain pc-only" data-act="exp-range" title="导出该年明细 CSV">${WB.icon("export")}</button>` : ""}</td>
      </tr>`;
    });
    return `<div class="tx-year-wrap" id="finYearWrap"><table class="tx-year-table">
      <thead><tr><th>年份</th><th>收入</th><th>支出</th><th>结余</th><th>笔数</th><th></th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>
    <div class="tx-year-tip">点收入/支出金额跳该年明细 · 点年份行看该年月账</div>
    ${yearCompareHtml(txs)}`;
  }

  /** 年账视图辅助：今年 vs 去年月度支出对比柱图 + 同比变化文案 */
  function yearCompareHtml(txs) {
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

  /** 分类管理面板 */
  function catMgrHtml(cats, custom) {
    if (finTab === "saving" || finTab === "all") return "";
    const customIds = new Set(((custom || {})[finTab] || []).map((c) => c.id));
    const chips = (cats[finTab] || [])
      .map((c) => {
        const removable = customIds.has(c.id);
        return `<span class="tag tx-cat-chip" style="border-color:${esc(c.color)}">
          <i class="tx-dot" style="background:${esc(c.color)}"></i>${esc(c.name)}
          ${removable ? `<button class="tx-cat-del" data-del-cat="${esc(c.id)}" title="删除分类">${WB.icon("del")}</button>` : ""}
        </span>`;
      })
      .join("");
    return `<div class="tx-cat-mgr" id="finCatMgr">
      <div class="tx-cat-chips">${chips}</div>
      <div class="row sp-t-sm">
        <input id="finNewCatName" placeholder="新分类名" maxlength="8" class="w-120" />
        <input type="color" id="finNewCatColor" value="#3B82F6" title="分类颜色" />
        <button class="btn sm" id="finAddCat">添加分类</button>
        <span class="tx-cat-tip">预置分类不可删；删除自定义分类不影响已有记录</span>
      </div>
    </div>`;
  }

  /** 明细卡片：类型 tab + 记一笔 + 筛选 + 列表 */
  function listCardHtml(cats, custom, mtx, txs) {
    const typeOpts = [
      { k: "all", label: "全部" },
      { k: "expense", label: "支出" },
      { k: "income", label: "收入" },
      { k: "saving", label: "储蓄" },
    ];
    const typeToggle = typeOpts
      .map((o) => `<button class="tab ${finTab === o.k ? "on" : ""}" data-tx-tab="${o.k}">${o.label}</button>`)
      .join("");

    // "全部"模式下分类合并所有类型（去重）；否则取当前类型分类
    const allCats = (() => {
      const m = [], seen = new Set();
      Object.keys(cats).forEach((t) => (cats[t] || []).forEach((c) => {
        if (!seen.has(c.id)) { seen.add(c.id); m.push(c); }
      }));
      return m;
    })();
    const tabCats = finTab === "all" ? allCats : (cats[finTab] || []);
    const catOpts = tabCats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    const filterOpts = `<option value="">全部分类</option>` + tabCats
      .map((c) => `<option value="${c.id}" ${c.id === finFilterCat ? "selected" : ""}>${esc(c.name)}</option>`)
      .join("");

    // "全部"模式不提供记一笔（需要具体类型），给出提示
    const addFormHtml = finTab === "all"
      ? `<div class="row tx-form sp-b-sm" style="color:var(--muted);font-size:12.5px">当前为全部类型视图 · 切到上方具体类型标签即可记一笔</div>`
      : `<div class="row tx-form sp-b-sm">
        <select id="finCategory">${catOpts}</select>
        <input type="number" id="finAmount" placeholder="金额" class="w-100" min="0" step="0.01" />
        <input class="grow" id="finNote" placeholder="备注（可空）" maxlength="40" />
        <input type="date" id="finDate" value="${finSelDay || todayStr()}" />
        <button class="btn in-card-btn" id="finAdd">记一笔</button>
      </div>`;

    // 年份选项：数据中实际存在的年份 + 当前年（降序），另含"全部年份"
    const yearSet = new Set([String(now.getFullYear())]);
    txs.forEach((t) => { if (t.date) yearSet.add(t.date.slice(0, 4)); });
    const yearOpts = [...yearSet].sort((a, b) => b.localeCompare(a))
      .map((y) => `<option value="${y}" ${!finAllYears && y === String(finYear) ? "selected" : ""}>${y}年</option>`)
      .join("");

    return `<div class="card" id="finListCard">
      <h2>流水明细
        <span class="mla">
          <select id="finYearSel" class="tx-year-sel" title="选择年份；「全部年份」查看所有流水">
            <option value="" ${finAllYears ? "selected" : ""}>全部年份</option>
            ${yearOpts}
          </select>
        </span>
      </h2>
      <div class="tabs sp-b-lg" id="txTabs">${typeToggle}</div>
      ${addFormHtml}
      <div class="row tx-filter sp-b-sm">
        <select id="finFilterCat">${filterOpts}</select>
        <input id="finKeyword" placeholder="搜备注…" value="${esc(finKeyword)}" class="w-110" />
        <input type="date" id="finDateStart" value="${esc(finDateStart)}" title="交易日期-起" />
        <span class="tx-range-sep">~</span>
        <input type="date" id="finDateEnd" value="${esc(finDateEnd)}" title="交易日期-止" />
        <button class="btn sm ghost" id="finResetFilter" title="清空筛选条件">重置</button>
        ${finTab !== "saving" && finTab !== "all" ? `<button class="btn sm ghost" id="finCatMgrBtn">${finShowCatMgr ? "收起分类管理" : "分类管理"}</button>` : ""}
        <button class="btn sm ghost" id="finImport" title="导入流水（支持 CSV / xlsx；本站导出、海豚云记录格式、Excel GBK 文件）">导入 CSV</button>
        <button class="btn sm ghost" id="finExport" title="导出当前筛选结果">导出 CSV</button>
        <input type="file" id="finImportFile" accept=".csv,text/csv,.xlsx,.xlsm" hidden />
      </div>
      ${finShowCatMgr ? catMgrHtml(cats, custom) : ""}
      <div id="finList" class="sp-t-lg">${buildListHtml(cats, txs)}</div>
    </div>`;
  }

  /** 统计卡片：日历 / 周账 / 月账 / 年账（全类型聚合，不分收支 tab） */
  function statCardHtml(cats, mtx, txs) {
    const viewOpts = [
      { k: "cal", label: "日历" },
      { k: "week", label: "周账" },
      { k: "month", label: "月账" },
      { k: "year", label: "年账" },
    ];
    const viewToggle = viewOpts
      .map((o) => `<button class="tab ${finStatView === o.k ? "on" : ""}" data-tx-view="${o.k}">${o.label}</button>`)
      .join("");

    // 头部导航：日历切月份，周账/月账切年份，年账无导航
    const isYearNav = finStatView === "week" || finStatView === "month";
    const navLabel = finStatView === "year" ? "全部年份" : isYearNav ? `${finYear}年` : `${finYear}年${finMonth + 1}月`;
    const showNav = finStatView !== "year";

    let body = "";
    if (finStatView === "cal") body = buildCalHtml(cats, mtx);
    else if (finStatView === "week") body = buildWeekHtml(txs);
    else if (finStatView === "month") body = buildMonthHtml(txs);
    else body = buildYearHtml(txs);

    return `<div class="card">
      <h2>统计
        <span class="count" style="display:flex;gap:6px;align-items:center">
          ${showNav ? `<button class="icon-btn plain" id="statPrev" title="上一${isYearNav ? "年" : "个月"}">${WB.icon("prev")}</button>` : ""}
          ${navLabel}
          ${showNav ? `<button class="icon-btn plain" id="statNext" title="下一${isYearNav ? "年" : "个月"}">${WB.icon("next")}</button>` : ""}
        </span>
      </h2>
      <div class="tabs sp-b-lg" id="txViews">${viewToggle}</div>
      ${body}
    </div>`;
  }

  // ---------- 图表 ----------
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
    finCharts.push(new Chart(cv, {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: card, borderWidth: 2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "58%",
        plugins: {
          legend: { position: "bottom", labels: { color: muted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, padding: 12, usePointStyle: true, pointStyle: "circle" } },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.label}  ${fmtYuan(ctx.parsed)} 元  (${((ctx.parsed / total) * 100).toFixed(1)}%)`,
            },
          },
        },
      },
    }));
  }

  /** 收支趋势：近 6 个月柱状图（收入 / 支出 分组） */
  function renderTrendChart(el, txs) {
    if (typeof Chart === "undefined") return;
    const cv = el.querySelector("#chartTrend");
    if (!cv) return;
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(finYear, finMonth - i, 1);
      months.push(monthKey(d.getFullYear(), d.getMonth()));
    }
    const incomeArr = months.map((m) => txs.filter((t) => t.type === "income" && (t.date || "").slice(0, 7) === m).reduce((s, t) => s + t.amount, 0));
    const expenseArr = months.map((m) => txs.filter((t) => t.type === "expense" && (t.date || "").slice(0, 7) === m).reduce((s, t) => s + t.amount, 0));
    const muted = cssVar("--muted"), line = cssVar("--line"), ok = cssVar("--ok"), danger = cssVar("--danger");
    finCharts.push(new Chart(cv, {
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
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label} ${ctx.parsed.y >= 0 ? "+" : ""}${fmtYuan(ctx.parsed.y)} 元`,
            },
          },
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
    const thisYear = now.getFullYear();
    const lastYear = thisYear - 1;
    const months = ["01","02","03","04","05","06","07","08","09","10","11","12"];
    const byM = (y) => months.map((m) => txs.filter((t) => t.type === "expense" && (t.date || "").slice(0, 7) === `${y}-${m}`).reduce((s, t) => s + Number(t.amount || 0), 0));
    const cur = byM(thisYear), prev = byM(lastYear);
    if (cur.every((v) => v === 0) && prev.every((v) => v === 0)) return;
    const muted = cssVar("--muted"), line = cssVar("--line"), danger = cssVar("--danger");
    finCharts.push(new Chart(cv, {
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
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} ${fmtYuan(c.parsed.y)} 元` } },
        },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 } }, grid: { color: line } },
        },
      },
    }));
  }
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

  /** 列表页导出：当前筛选结果（需求 §9.4 导出与页面对齐） */
  function exportList(cats, txs) {
    const scope = scopedTx(txs);
    let rows = scope.filter((t) => finTab === "all" || t.type === finTab);
    if (finFilterCat) rows = rows.filter((t) => t.category === finFilterCat);
    if (finKeyword) rows = rows.filter((t) => (t.note || "").toLowerCase().includes(finKeyword.toLowerCase()));
    rows = rows.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const label = finDateStart || finDateEnd
      ? `${finDateStart || "起"}至${finDateEnd || "今"}`
      : finYear + "年";
    downloadCsv(`记账_${label}_${typeLabel(finTab)}.csv`, rows, cats);
  }

  /** 周/月/年账按行导出：该期间全部类型明细（需求 §7） */
  function exportRange(cats, txs, start, end, label) {
    const rows = txs
      .filter((t) => t.date >= start && t.date <= end)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    downloadCsv(`记账_${label}.csv`, rows, cats);
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
    const records = [];
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

    // 按 id 去重：已有记录跳过，避免重复导入
    const existing = await financeRepo.list();
    const existingIds = new Set(existing.map((r) => r.id));
    const before = records.length;
    records = records.filter((r) => !existingIds.has(r.id));
    const deduped = before - records.length;
    if (!records.length) return { err: `所有 ${before} 条记录均已存在，无需导入` };
    skipped += deduped;

    const newCats = catAdd.income.concat(catAdd.expense).map((c) => c.name);
    let msg = `解析到 ${rows.length - 1} 行，可导入 ${records.length} 条`;
    if (deduped) msg += `，已存在跳过 ${deduped} 条`;
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
    return { added: records.length, skipped, newCats, addedDates: records.map((r) => r.date) };
  }

  /** 解析 CSV 文本并导入（confirm 在 importRows 内） */
  async function importCsvText(text, cats) {
    return importRows(parseCsv(text), cats);
  }

  /** 解析 xlsx/xlsm（SheetJS mini，cellDates 让日期单元格变为 Date）并导入。
   *  单元格统一转字符串：Date 用本地时间取年月日，避免 toISOString 的 UTC 偏移差一天。 */
  async function importXlsxFile(file, cats) {
    if (typeof XLSX === "undefined") return { err: "xlsx 解析库未加载，请刷新页面重试" };
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

  // ---------- 定期账单 ----------
  /** 本月该规则是否已记（note 含规则名视为已记；income/expense 均可） */
  function schedRecordedThisMonth(records, s, curMonth) {
    return records.some((r) => (r.date || "").slice(0, 7) === curMonth && (r.note || "").indexOf(s.name) !== -1);
  }

  /** 检查定期账单：auto 模式自动记入，remind 模式到期弹框提醒。返回是否新增过记录（调用方可重渲染） */
  async function checkSchedules(records) {
    const schedules = await getSetting("finSchedules", []);
    if (!schedules.length) return false;
    const today = todayStr();
    const curMonth = today.slice(0, 7);
    // 已处理的月份 + 规则名：同月不重复触发；顺带清掉上月及更早的键防无限膨胀
    const doneKey = (await getSetting("finSchedDone", {})) || {};
    const curYM = curMonth.replace("-", "");
    for (const k of Object.keys(doneKey)) {
      const m = k.slice(0, 6);
      if (m && m < curYM) delete doneKey[k];
    }
    const stamp = nowStamp();
    let changed = false;
    for (const s of schedules) {
      if (!s.enabled && s.enabled !== undefined) continue;
      const due = Math.min(Number(s.dueDay || 1), new Date(today.slice(0, 4), Number(today.slice(5, 7)), 0).getDate());
      // 本月扣款日还没到 → 不处理
      const todayD = Number(today.slice(8, 10));
      if (todayD < due) continue;
      // 本月已记过这笔 → 跳过
      if (schedRecordedThisMonth(records, s, curMonth)) continue;
      const key = curMonth + "|" + s.name;
      if (doneKey[key]) continue;
      const type = s.type === "income" ? "income" : "expense";
      const rec = {
        id: uid(),
        type,
        category: s.category,
        amount: Number(s.amount || 0),
        note: s.name,
        date: today,
        createdAt: stamp,
        updatedAt: stamp,
      };
      if (s.mode === "auto") {
        // 自动记入：补记到扣款日当天（若该月扣款日已过则记今天）
        const dueDate = curMonth + "-" + String(due).padStart(2, "0");
        rec.date = dueDate <= today ? dueDate : today;
        await financeRepo.put(rec);
        doneKey[key] = 1;
        changed = true;
      } else {
        // 到期提醒：dueDay 当天到 dueDay+5 天内弹框（超宽限期不再打扰）
        const graceEnd = due + 5;
        if (todayD <= graceEnd) {
          const ok = confirm(`「${s.name}」本月 ${due} 号该扣 ${fmtYuan(rec.amount)} 元，今天 ${today.slice(5)} 还没记。\n\n现在记一笔吗？`);
          if (ok) {
            await financeRepo.put(rec);
            changed = true;
          }
          doneKey[key] = 1; // 无论记不记，本月只提醒一次
        }
      }
    }
    await setSetting("finSchedDone", doneKey);
    return changed;
  }

  // ---------- 主渲染 ----------
  routes.finance = {
    title: "记账",
    async render(el) {
      const [records, target, finCatsCustom, monthBudget, finTemplates, finSchedules] = await Promise.all([
        financeRepo.list(),
        getSetting("saveTarget", 60000),
        getSetting("finCategories", { income: [], expense: [] }),
        getSetting("monthBudget", 0),
        getSetting("finTemplates", []),
        getSetting("finSchedules", []),
      ]);
      const cats = mergeCats(finCatsCustom);
      const txs = records.map(normalizeTx);

      // 全期储蓄
      const saved = txs.filter((t) => t.type === "saving").reduce((s, t) => s + t.amount, 0);
      const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;

      // 本月概览
      const mk = monthKey(finYear, finMonth);
      const mtx = txs.filter((t) => (t.date || "").slice(0, 7) === mk);
      const ytx = txs.filter((t) => (t.date || "").slice(0, 4) === String(finYear));

      // 销毁旧图表
      finCharts.forEach((c) => c.destroy());
      finCharts = [];

      el.innerHTML = `
        ${summaryHtml(mtx, ytx, txs)}
        <div class="fin-grid">
          <div class="fin-col-left">
            ${listCardHtml(cats, finCatsCustom, mtx, txs)}
            ${statCardHtml(cats, mtx, txs)}
          </div>
          <div class="fin-col-right">
            ${budgetHtml(mtx, monthBudget)}
            ${goalHtml(saved, target, pct)}
            ${templateHtml(cats, finTemplates)}
            ${schedHtml(cats, finSchedules)}
            ${chartCardHtml(mtx)}
            ${trendCardHtml(txs)}
          </div>
        </div>
      `;

      renderFinChart(el, mtx, cats);
      renderTrendChart(el, txs);
      renderYearCmpChart(el, txs);

      const rerender = () => routes.finance.render(el);
      const $ = (sel) => el.querySelector(sel);
      const on = (sel, ev, fn) => { const n = $(sel); if (n) n.addEventListener(ev, fn); };

      // 明细卡：年份选择（含"全部年份"；切换只影响明细列表数据源，不动 finYear 供统计卡共享）
      on("#finYearSel", "change", (e) => {
        const v = e.target.value;
        if (v === "") { finAllYears = true; }
        else { finAllYears = false; finYear = Number(v); }
        finPage = 1;
        finSelDay = null; finEditId = null; finDetailId = null; rerender();
      });

      // 统计卡：日历切月份，周账/月账切年份（与明细卡共享 finYear/finMonth）
      const statYearNav = () => finStatView === "week" || finStatView === "month";
      on("#statPrev", "click", () => {
        if (statYearNav()) { finYear--; }
        else { finMonth--; if (finMonth < 0) { finMonth = 11; finYear--; } }
        finSelDay = null; finEditId = null; finDetailId = null; rerender();
      });
      on("#statNext", "click", () => {
        if (statYearNav()) { finYear++; }
        else { finMonth++; if (finMonth > 11) { finMonth = 0; finYear++; } }
        finSelDay = null; finEditId = null; finDetailId = null; rerender();
      });

      // 类型 tab
      on("#txTabs", "click", (e) => {
        const btn = e.target.closest("[data-tx-tab]");
        if (!btn) return;
        finTab = btn.dataset.txTab;
        finFilterCat = ""; finKeyword = ""; finPage = 1; finEditId = null; finDetailId = null;
        rerender();
      });

      // 统计卡视图 tab
      on("#txViews", "click", (e) => {
        const btn = e.target.closest("[data-tx-view]");
        if (!btn) return;
        finStatView = btn.dataset.txView;
        finSelDay = null; finEditId = null; finDetailId = null;
        rerender();
      });

      // 新增（记提交时间，需求 §1.4 详细）
      const addFin = async () => {
        const amountInput = $("#finAmount");
        const amount = parseFloat(amountInput.value);
        if (!(amount > 0)) return flashInvalid(amountInput);
        const stamp = nowStamp();
        await financeRepo.put({
          id: uid(),
          type: finTab,
          category: $("#finCategory").value,
          amount,
          note: $("#finNote").value.trim(),
          date: $("#finDate").value || todayStr(),
          createdAt: stamp,
          updatedAt: stamp,
        });
        rerender();
      };
      on("#finAdd", "click", addFin);
      on("#finNote", "keydown", (e) => { if (e.key === "Enter") addFin(); });
      on("#finAmount", "keydown", (e) => { if (e.key === "Enter") addFin(); });

      // 目标
      on("#finTarget", "change", async (e) => {
        const v = Math.max(0, parseFloat(e.target.value) || 0);
        await setSetting("saveTarget", v);
        rerender();
      });

      // 月度预算
      on("#finBudget", "change", async (e) => {
        const v = Math.max(0, parseFloat(e.target.value) || 0);
        await setSetting("monthBudget", v);
        rerender();
      });

      // 固定支出模板：新增 / 一键记入（今天）/ 删除
      on("#tplAdd", "click", async () => {
        const nameInput = $("#tplName"), amtInput = $("#tplAmount");
        const name = nameInput.value.trim();
        if (!name) return flashInvalid(nameInput);
        const amount = parseFloat(amtInput.value);
        if (!(amount > 0)) return flashInvalid(amtInput);
        const list = await getSetting("finTemplates", []);
        list.push({ id: "t" + uid(), name, category: $("#tplCat").value, amount });
        await setSetting("finTemplates", list);
        rerender();
      });
      on("#finTplCard", "click", async (e) => {
        const li = e.target.closest("[data-tpl]");
        if (!li) return;
        const list = await getSetting("finTemplates", []);
        const tp = list.find((x) => x.id === li.dataset.tpl);
        if (!tp) return;
        if (e.target.closest('[data-act="use-tpl"]')) {
          const stamp = nowStamp();
          await financeRepo.put({
            id: uid(),
            type: "expense",
            category: tp.category,
            amount: tp.amount,
            note: tp.name,
            date: todayStr(),
            createdAt: stamp,
            updatedAt: stamp,
          });
          rerender();
        } else if (e.target.closest('[data-act="del-tpl"]')) {
          if (!confirm(`删除模板「${tp.name}」？`)) return;
          await setSetting("finTemplates", list.filter((x) => x.id !== tp.id));
          rerender();
        }
      });

      // 定期账单：新增 / 删除 / 切换模式
      on("#schedAdd", "click", async () => {
        const nameInput = $("#schedName"), amtInput = $("#schedAmount"), dayInput = $("#schedDay");
        const name = nameInput.value.trim();
        if (!name) return flashInvalid(nameInput);
        const amount = parseFloat(amtInput.value);
        if (!(amount > 0)) return flashInvalid(amtInput);
        const dueDay = parseInt(dayInput.value, 10);
        if (!(dueDay >= 1 && dueDay <= 31)) return flashInvalid(dayInput);
        const type = $("#schedType").value;
        const list = await getSetting("finSchedules", []);
        list.push({ id: "s" + uid(), name, type, category: $("#schedCat").value, amount, dueDay, mode: "remind", enabled: true });
        await setSetting("finSchedules", list);
        rerender();
      });
      on("#finSchedCard", "click", async (e) => {
        const li = e.target.closest("[data-sched]");
        if (!li) return;
        const list = await getSetting("finSchedules", []);
        const s = list.find((x) => x.id === li.dataset.sched);
        if (!s) return;
        if (e.target.closest('[data-act="del-sched"]')) {
          if (!confirm(`删除定期账单「${s.name}」？`)) return;
          await setSetting("finSchedules", list.filter((x) => x.id !== s.id));
          rerender();
        } else if (e.target.closest('[data-act="toggle-sched"]')) {
          s.mode = s.mode === "auto" ? "remind" : "auto";
          await setSetting("finSchedules", list);
          rerender();
        }
      });

      // 到期检查：auto 自动记入 / remind 弹框（页面打开即检查，同月同规则只触发一次）
      if (await checkSchedules(records)) rerender();

      // 筛选（局部刷新列表，避免搜索框失焦）
      const refreshList = () => {
        const listEl = $("#finList");
        if (listEl) listEl.innerHTML = buildListHtml(cats, txs);
      };
      on("#finFilterCat", "change", (e) => { finFilterCat = e.target.value; finPage = 1; finEditId = null; finDetailId = null; refreshList(); });
      on("#finKeyword", "input", (e) => { finKeyword = e.target.value.trim(); finPage = 1; finEditId = null; finDetailId = null; refreshList(); });
      on("#finDateStart", "change", (e) => { finDateStart = e.target.value; finPage = 1; finEditId = null; finDetailId = null; refreshList(); });
      on("#finDateEnd", "change", (e) => { finDateEnd = e.target.value; finPage = 1; finEditId = null; finDetailId = null; refreshList(); });
      on("#finResetFilter", "click", () => {
        finFilterCat = ""; finKeyword = ""; finDateStart = ""; finDateEnd = ""; finPage = 1;
        finEditId = null; finDetailId = null;
        rerender();
      });

      // 导出：当前筛选结果
      on("#finExport", "click", () => exportList(cats, txs));

      // 导入 CSV / xlsx（移动端同样展示入口）
      on("#finImport", "click", () => { const f = $("#finImportFile"); if (f) f.click(); });
      on("#finImportFile", "change", async (e) => {
        const file = e.target.files[0];
        e.target.value = ""; // 允许重选同一文件
        if (!file) return;
        try {
          const name = (file.name || "").toLowerCase();
          let res;
          if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
            res = await importXlsxFile(file, cats);
          } else if (name.endsWith(".xls")) {
            window.WB.showToast("暂不支持 .xls 旧格式，请在 Excel 中另存为 .xlsx 或 CSV 后再导入", "error");
            return;
          } else {
            res = await importCsvText(await decodeCsvFile(file), cats);
          }
          if (res.err) { window.WB.showToast("导入失败：" + res.err, "error"); return; }
          if (res.cancelled) return;
          window.WB.showToast(`导入完成：新增 ${res.added} 条${res.skipped ? `，跳过无效 ${res.skipped} 行` : ""}${res.newCats.length ? `，自动新建分类：${res.newCats.join("、")}` : ""}`, "success");
          // 跳转到最新一条导入记录所在月份并清空筛选，确保导入结果可见
          // （模板/历史文件里的日期常不在当前月，原逻辑导入后列表无变化，易误以为没导进去）
          const dates = res.addedDates || [];
          if (dates.length) {
            const max = dates.sort().pop();
            finYear = Number(max.slice(0, 4));
            finAllYears = false;
            finMonth = Number(max.slice(5, 7)) - 1;
            finDateStart = ""; finDateEnd = ""; finFilterCat = ""; finKeyword = ""; finPage = 1;
            finEditId = null; finDetailId = null;
          }
          await rerender();
          const card = el.querySelector("#finListCard");
          if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (err) {
          // bulkPut / 设置写入抛错时给出明确提示（原实现无 try/catch，出错即静默无反馈）
          window.WB.showToast("导入出错：" + ((err && err.message) || err), "error");
        }
      });

      // 分类管理开关
      on("#finCatMgrBtn", "click", () => { finShowCatMgr = !finShowCatMgr; rerender(); });

      // 分类管理：新增 / 删除
      on("#finAddCat", "click", async () => {
        const nameInput = $("#finNewCatName");
        const name = nameInput.value.trim();
        if (!name) return flashInvalid(nameInput);
        const custom = await getSetting("finCategories", { income: [], expense: [] });
        custom[finTab] = custom[finTab] || [];
        custom[finTab].push({ id: "c" + uid(), name, color: $("#finNewCatColor").value });
        await setSetting("finCategories", custom);
        rerender();
      });
      on("#finCatMgr", "click", async (e) => {
        const del = e.target.closest("[data-del-cat]");
        if (!del) return;
        if (!confirm(`删除分类「${del.dataset.delCat}」？已有该分类的流水不会被删，只是不再归类。`)) return;
        const custom = await getSetting("finCategories", { income: [], expense: [] });
        custom[finTab] = (custom[finTab] || []).filter((c) => c.id !== del.dataset.delCat);
        await setSetting("finCategories", custom);
        rerender();
      });

      // 日历：点日期
      on("#txCal", "click", (e) => {
        const cell = e.target.closest("[data-day]");
        if (!cell) return;
        finSelDay = finSelDay === cell.dataset.day ? null : cell.dataset.day;
        finEditId = null; finDetailId = null;
        rerender();
      });

      /** 跳明细：设类型 + 日期范围 → 明细卡预填筛选并滚动到位 */
      const jumpToList = async (type, start, end) => {
        if (type === "income" || type === "expense") finTab = type;
        finDateStart = start; finDateEnd = end;
        finFilterCat = ""; finKeyword = ""; finPage = 1; finEditId = null; finDetailId = null;
        finYear = Number(start.slice(0, 4));
        finAllYears = false;
        finMonth = Number(start.slice(5, 7)) - 1;
        await rerender();
        const card = el.querySelector("#finListCard");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      };

      // 周账：金额跳明细 / 按行导出
      on("#finWeekWrap", "click", (e) => {
        const row = e.target.closest("[data-ws]");
        if (!row) return;
        const ws = row.dataset.ws, we = row.dataset.we;
        if (e.target.closest('[data-act="exp-range"]')) return exportRange(cats, txs, ws, we, `${ws}周`);
        const lnk = e.target.closest(".tx-lnk[data-jt]");
        if (lnk) jumpToList(lnk.dataset.jt, ws, we);
      });

      // 月账：金额跳明细（带类型+范围）/ 点行跳当月列表 / 按行导出
      on("#finMonthWrap", "click", (e) => {
        const row = e.target.closest("[data-month]");
        if (!row) return;
        const m = Number(row.dataset.month);
        const start = monthKey(finYear, m) + "-01";
        const end = monthKey(finYear, m) + "-" + String(new Date(finYear, m + 1, 0).getDate()).padStart(2, "0");
        if (e.target.closest('[data-act="exp-range"]')) return exportRange(cats, txs, start, end, monthKey(finYear, m));
        const lnk = e.target.closest(".tx-lnk[data-jt]");
        if (lnk) return jumpToList(lnk.dataset.jt, start, end);
        // 点行：明细卡跳到当月（不设范围，走月导航口径）
        finMonth = m;
        finDateStart = ""; finDateEnd = ""; finFilterCat = ""; finKeyword = ""; finPage = 1;
        rerender().then(() => {
          const card = el.querySelector("#finListCard");
          if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });

      // 年账：金额跳明细 / 点行看该年月账 / 按行导出
      on("#finYearWrap", "click", (e) => {
        const row = e.target.closest("[data-year]");
        if (!row) return;
        const y = row.dataset.year;
        const start = y + "-01-01", end = y + "-12-31";
        if (e.target.closest('[data-act="exp-range"]')) return exportRange(cats, txs, start, end, y + "年");
        const lnk = e.target.closest(".tx-lnk[data-jt]");
        if (lnk) return jumpToList(lnk.dataset.jt, start, end);
        finYear = Number(y);
        finStatView = "month";
        rerender();
      });

      // 流水条目操作：详细 / 复制 / 编辑 / 保存 / 取消 / 删除（委托到明细列表与日历当日明细）
      const txItemHandler = async (e) => {
        const item = e.target.closest("[data-id]");
        if (!item) return;
        const id = item.dataset.id;

        if (e.target.closest('[data-act="del-fin"]')) {
          const rec = txs.find((t) => t.id === id);
          const lab = rec ? `${rec.type === "income" ? "收入" : "支出"} ${esc(rec.amount ?? "")} ${esc(rec.category || "")} ${rec.date || ""}`.trim() : "";
          if (!confirm(`删除这条流水${lab ? `（${lab}）` : ""}？`)) return;
          await financeRepo.delete(id);
          rerender();
          return;
        }
        if (e.target.closest('[data-act="copy-fin"]')) {
          // 复制：预填新增表单，日期改今天（需求 §1.4）
          const src = txs.find((t) => t.id === id);
          if (!src) return;
          const catSel = $("#finCategory");
          if (catSel && src.type === finTab) catSel.value = src.category;
          const amt = $("#finAmount"), note = $("#finNote"), date = $("#finDate");
          if (amt) { amt.value = src.amount; amt.focus(); }
          if (note) note.value = src.note;
          if (date) date.value = todayStr();
          return;
        }
        if (e.target.closest('[data-act="edit-fin"]')) {
          finEditId = id; finDetailId = null;
          rerender();
          return;
        }
        if (e.target.closest('[data-act="cancel-fin"]')) {
          finEditId = null;
          rerender();
          return;
        }
        if (e.target.closest('[data-act="save-fin"]')) {
          const amtInput = item.querySelector('[data-ed="amount"]');
          const amount = parseFloat(amtInput.value);
          if (!(amount > 0)) return flashInvalid(amtInput);
          const orig = txs.find((t) => t.id === id) || {};
          await financeRepo.put({
            id,
            type: item.dataset.type,
            category: item.querySelector('[data-ed="cat"]').value,
            amount,
            note: item.querySelector('[data-ed="note"]').value.trim(),
            date: item.querySelector('[data-ed="date"]').value || todayStr(),
            createdAt: orig.createdAt || "",
            updatedAt: nowStamp(),
          });
          finEditId = null;
          rerender();
          return;
        }
        // 点行身：展开/收起详细（编辑态不响应）
        if (item.classList.contains("tx-editing")) return;
        finDetailId = finDetailId === id ? null : id;
        if (item.closest("#finList")) { const listEl = $("#finList"); listEl.innerHTML = buildListHtml(cats, txs); }
        else rerender();
      };
      on("#finList", "click", txItemHandler);
      on("#finCalList", "click", txItemHandler);

      // 列表分页器（委托，局部刷新列表不丢事件）
      on("#finList", "click", (e) => {
        const btn = e.target.closest("#finPagePrev") || e.target.closest("#finPageNext");
        if (!btn) return;
        const delta = btn.id === "finPagePrev" ? -1 : 1;
        const tabTx = filteredTabTx(cats, txs);
        const totalPages = Math.max(1, Math.ceil(tabTx.length / FIN_PAGE_SIZE));
        const next = finPage + delta;
        if (next < 1 || next > totalPages) return;
        finPage = next;
        const listEl = $("#finList");
        if (listEl) listEl.innerHTML = buildListHtml(cats, txs);
      });
    },
  };

  // 暴露给仪表盘：打开首页时也跑一次到期检查（auto 自动记入 / remind 弹框提醒）
  window.WB.financeSchedCheck = (records) => checkSchedules(records);
})();
