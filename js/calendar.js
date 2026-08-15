/**
 * calendar.js — 整合日历视图：月历网格聚合任务/记账/习惯打卡
 *
 * 需要新增的 CSS 类清单（请在 css/app.css 中添加）：
 * 1. .cal-ctrl          — 顶部控制栏，display:flex;align-items:center;gap:10px;margin-bottom:16px
 * 2. .cal-ctrl-title    — 当前年月标题，flex:1;text-align:center;font-weight:800;font-size:20px;color:var(--ink)
 * 3. .cal-task-badge    — 格子内任务徽标，display:inline-flex;font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;margin-top:2px
 * 4. .cal-task-badge.overdue  — 逾期任务徽标，background:var(--danger);color:#fff
 * 5. .cal-task-badge.done     — 已完成任务徽标，background:var(--ok);color:#fff
 * 6. .cal-task-badge.pending  — 进行中任务徽标，background:var(--accent);color:#fff
 * 7. .cal-tx-sum      — 格子内支出合计，font-size:10px;color:var(--danger);font-weight:700;font-variant-numeric:tabular-nums
 * 8. .cal-tx-sum.positive — 格子内收入合计，color:var(--ok)
 * 9. .cal-habit-dots  — 格子内习惯打卡色点容器，display:flex;gap:2px;margin-top:2px;flex-wrap:wrap
 * 10. .cal-detail-section — 详情卡内分区标题，font-size:13px;font-weight:800;margin:12px 0 6px;color:var(--ink)
 * 11. .cal-detail-task — 详情任务行，display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0
 * 12. .cal-detail-tx   — 详情记账行，display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0
 * 13. .cal-detail-habit — 详情习惯行，display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0
 * 14. .cal-detail-total — 当日合计行，font-size:13px;font-weight:700;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)
 *
 * 复用的现有 CSS 类：
 * .cal-grid / .cal-cell / .cal-cell.dim / .cal-cell.today / .cal-cell.sel / .cal-wd / .d-num / .d-dot / .d-more
 * .card / .btn / .badge / .pri-dot / .empty / .icon-btn / .b-danger / .b-warn / .b-primary
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, todayStr, fmtMoney, getSetting, setSetting, flashInvalid, cssVar } = window.WB;
  const tasksRepo = repo("tasks");
  const financeRepo = repo("finance");
  const habitsRepo = repo("habits");

  const WEEKDAYS = ["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"];
  const PRIORITY_LABEL = { high: "\u9AD8", mid: "\u4E2D", low: "\u4F4E" };
  const PRIORITY_COLOR = { high: "var(--danger)", mid: "var(--warn)", low: "var(--primary)" };

  const now = new Date();
  let calYear = now.getFullYear();
  let calMonth = now.getMonth();
  let calSelDay = null;

  function daysInMonth(y, m) {
    return new Date(y, m + 1, 0).getDate();
  }

  function firstWeekday(y, m) {
    return new Date(y, m, 1).getDay();
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function ymd(y, m, d) {
    return y + "-" + pad2(m + 1) + "-" + pad2(d);
  }

  function fmtYuan(n) {
    return Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function isOverdue(t) {
    return !t.done && t.dueDate && t.dueDate.slice(0, 10) < todayStr();
  }

  function priorityBadge(p) {
    if (p === "high") return "b-danger";
    if (p === "mid") return "b-warn";
    return "b-primary";
  }

  function buildDayIndex(tasks, finances, habits) {
    var idx = new Map();
    tasks.forEach(function (t) {
      var due = (t.dueDate || "").slice(0, 10);
      if (!due) return;
      var entry = idx.get(due);
      if (!entry) { entry = { tasks: [], txs: [], checkins: [] }; idx.set(due, entry); }
      entry.tasks.push(t);
    });
    finances.forEach(function (tx) {
      var d = (tx.date || "").slice(0, 10);
      if (!d) return;
      var entry = idx.get(d);
      if (!entry) { entry = { tasks: [], txs: [], checkins: [] }; idx.set(d, entry); }
      entry.txs.push(tx);
    });
    habits.forEach(function (h) {
      var ck = h.checkins || {};
      Object.keys(ck).forEach(function (d) {
        if (!ck[d]) return;
        var entry = idx.get(d);
        if (!entry) { entry = { tasks: [], txs: [], checkins: [] }; idx.set(d, entry); }
        entry.checkins.push(h);
      });
    });
    return idx;
  }

  function ctrlHtml() {
    var title = calYear + "\u5E74" + (calMonth + 1) + "\u6708";
    var showToday = calYear !== now.getFullYear() || calMonth !== now.getMonth();
    return '<div class="cal-ctrl">' +
      '<button class="icon-btn plain" id="calPrev" title="\u4E0A\u4E2A\u6708">' + WB.icon("prev") + '</button>' +
      '<span class="cal-ctrl-title">' + title + '</span>' +
      '<button class="icon-btn plain" id="calNext" title="\u4E0B\u4E2A\u6708">' + WB.icon("next") + '</button>' +
      (showToday ? '<button class="btn sm ghost" id="calToday">\u56DE\u5230\u4ECA\u5929</button>' : '') +
      '</div>';
  }
  /** 本月概览条：本月支出 vs 预算、打卡次数、完成任务数 */
  function overviewHtml(dailyIdx, finances, budget) {
    var monthKey = ymd(calYear, calMonth, 1).slice(0, 7);
    // 支出合计（本月全部记账）
    var exp = 0, inc = 0;
    finances.forEach(function (f) {
      if ((f.date || "").slice(0, 7) !== monthKey) return;
      if (f.type === "expense") exp += Number(f.amount || 0);
      else if (f.type === "income") inc += Number(f.amount || 0);
    });
    // 打卡次数 + 完成任务数（从 dailyIdx 聚合本月的）
    var checkins = 0, doneTasks = 0;
    dailyIdx.forEach(function (entry, key) {
      if (key.slice(0, 7) !== monthKey) return;
      checkins += entry.checkins ? entry.checkins.length : 0;
      if (entry.tasks) doneTasks += entry.tasks.filter(function (t) { return t.done; }).length;
    });
    var budgetHtml = "";
    if (budget > 0) {
      var pct = Math.min(100, Math.round((exp / budget) * 100));
      var over = exp > budget;
      var cls = over ? "over" : (pct >= 80 ? "warn" : "ok");
      budgetHtml = '<div class="cal-ov cal-ov-budget ' + cls + '">' +
        '<span class="cal-ov-lab">\u672C\u6708\u652F\u51FA</span>' +
        '<span class="cal-ov-val">' + fmtMoney(exp) + ' / ' + fmtMoney(budget) + '</span>' +
        '<span class="cal-ov-bar"><i style="width:' + pct + '%;' + (over ? 'background:var(--danger)' : (pct >= 80 ? 'background:var(--warn)' : '')) + '"></i></span>' +
        (over ? '<span class="cal-ov-tag over">\u8D85\u652F ' + fmtMoney(exp - budget) + '</span>' : '<span class="cal-ov-tag">' + pct + '%</span>') +
        '</div>';
    }
    return '<div class="cal-overview">' +
      '<div class="cal-ov"><span class="cal-ov-lab">\u672C\u6708\u6253\u5361</span><span class="cal-ov-val">' + checkins + ' \u6B21</span></div>' +
      '<div class="cal-ov"><span class="cal-ov-lab">\u5B8C\u6210\u4EFB\u52A1</span><span class="cal-ov-val">' + doneTasks + ' \u4E2A</span></div>' +
      '<div class="cal-ov"><span class="cal-ov-lab">\u672C\u6708\u7ED3\u4F59</span><span class="cal-ov-val" style="color:' + (inc - exp >= 0 ? 'var(--ok)' : 'var(--danger)') + '">' + fmtMoney(inc - exp) + '</span></div>' +
      budgetHtml +
      '</div>';
  }
  function gridHtml(dailyIdx) {
    var days = daysInMonth(calYear, calMonth);
    var lead = firstWeekday(calYear, calMonth);
    var today = todayStr();
    var cells = WEEKDAYS.map(function (w) {
      return '<div class="cal-wd">' + w + '</div>';
    }).join("");

    for (var i = 0; i < lead; i++) {
      cells += '<div class="cal-cell dim"></div>';
    }

    for (var d = 1; d <= days; d++) {
      var key = ymd(calYear, calMonth, d);
      var entry = dailyIdx.get(key);
      var cls = ["cal-cell"];
      if (key === today) cls.push("today");
      if (key === calSelDay) cls.push("sel");

      var content = '<span class="d-num">' + d + '</span>';

      if (entry && entry.tasks.length) {
        var totalTasks = entry.tasks.length;
        var doneTasks = entry.tasks.filter(function (t) { return t.done; }).length;
        var overdueTasks = entry.tasks.filter(function (t) { return isOverdue(t); }).length;
        var pendingTasks = totalTasks - doneTasks;

        if (overdueTasks > 0) {
          content += '<span class="cal-task-badge overdue">' + overdueTasks + '</span>';
        } else if (pendingTasks > 0) {
          content += '<span class="cal-task-badge pending">' + pendingTasks + '</span>';
        }
        if (doneTasks > 0 && overdueTasks === 0 && pendingTasks === 0) {
          content += '<span class="cal-task-badge done">\u2713</span>';
        }
      }

      if (entry && entry.txs.length) {
        var expenseTotal = 0, incomeTotal = 0;
        entry.txs.forEach(function (tx) {
          if (tx.type === "expense") expenseTotal += Number(tx.amount || 0);
          else if (tx.type === "income") incomeTotal += Number(tx.amount || 0);
        });
        if (expenseTotal > 0) {
          content += '<div class="cal-tx-sum">-' + fmtYuan(expenseTotal) + '</div>';
        } else if (incomeTotal > 0) {
          content += '<div class="cal-tx-sum positive">+' + fmtYuan(incomeTotal) + '</div>';
        }
      }

      if (entry && entry.checkins.length) {
        content += '<div class="cal-habit-dots">';
        var maxDots = Math.min(entry.checkins.length, 5);
        for (var hi = 0; hi < maxDots; hi++) {
          content += '<span class="d-dot" style="background:' + esc(entry.checkins[hi].color || "#FF5A36") + '"></span>';
        }
        if (entry.checkins.length > 5) {
          content += '<span class="d-more">+' + (entry.checkins.length - 5) + '</span>';
        }
        content += '</div>';
      }

      cells += '<div class="' + cls.join(" ") + '" data-day="' + key + '">' + content + '</div>';
    }

    return '<div class="cal-grid">' + cells + '</div>';
  }
  function detailHtml(dailyIdx) {
    if (!calSelDay) return '<div class="empty sp-t-2x">\u70B9\u51FB\u65E5\u671F\u67E5\u770B\u5F53\u65E5\u8BE6\u60C5</div>';

    var entry = dailyIdx.get(calSelDay);
    if (!entry || (!entry.tasks.length && !entry.txs.length && !entry.checkins.length)) {
      return '<div class="card sp-t-2x"><div class="empty">\u5F53\u65E5\u65E0\u8BB0\u5F55</div></div>';
    }

    var html = '<div class="card sp-t-2x">';
    html += '<div class="cal-detail-head">' + esc(calSelDay) + ' \u8BE6\u60C5</div>';

    if (entry.tasks.length) {
      html += '<div class="cal-detail-section">\u4EFB\u52A1</div>';
      entry.tasks.forEach(function (t) {
        var pLabel = PRIORITY_LABEL[t.priority] || "";
        var doneCls = t.done ? ' class="cal-detail-task done"' : ' class="cal-detail-task"';
        html += '<div' + doneCls + '>' +
          (t.done ? '<span class="cal-detail-ok">\u2713</span>' : '<span class="pri-dot" style="background:' + (PRIORITY_COLOR[t.priority] || "var(--muted)") + '"></span>') +
          '<span class="cal-detail-txt">' + esc(t.title) + '</span>' +
          (pLabel ? '<span class="badge ' + priorityBadge(t.priority) + '">' + pLabel + '</span>' : "") +
          (isOverdue(t) ? '<span class="badge b-danger mla">\u903E\u671F</span>' : "") +
          '</div>';
      });
    }

    if (entry.txs.length) {
      html += '<div class="cal-detail-section">\u8BB0\u8D26</div>';
      var dayExpense = 0, dayIncome = 0;
      entry.txs.forEach(function (tx) {
        var amt = Number(tx.amount || 0);
        if (tx.type === "expense") {
          dayExpense += amt;
          html += '<div class="cal-detail-tx">' +
            '<span class="cal-detail-txt">' + esc(tx.category || "") + (tx.note ? " \u00B7 " + esc(tx.note) : "") + '</span>' +
            '<span class="c-danger">-' + fmtYuan(amt) + '</span>' +
            '</div>';
        } else if (tx.type === "income") {
          dayIncome += amt;
          html += '<div class="cal-detail-tx">' +
            '<span class="cal-detail-txt">' + esc(tx.category || "") + (tx.note ? " \u00B7 " + esc(tx.note) : "") + '</span>' +
            '<span class="c-ok">+' + fmtYuan(amt) + '</span>' +
            '</div>';
        } else {
          html += '<div class="cal-detail-tx">' +
            '<span class="cal-detail-txt">' + esc(tx.category || "") + (tx.note ? " \u00B7 " + esc(tx.note) : "") + '</span>' +
            '<span>' + fmtYuan(amt) + '</span>' +
            '</div>';
        }
      });
      var net = dayIncome - dayExpense;
      html += '<div class="cal-detail-total">\u5F53\u65E5\u5408\u8BA1\uFF1A' +
        '<span class="c-ok">\u6536\u5165 +' + fmtYuan(dayIncome) + '</span> \u00B7 ' +
        '<span class="c-danger">\u652F\u51FA -' + fmtYuan(dayExpense) + '</span> \u00B7 ' +
        '<span style="color:' + (net >= 0 ? "var(--ok)" : "var(--danger)") + '">\u7ED3\u4F59 ' + (net >= 0 ? "+" : "") + fmtYuan(net) + '</span>' +
        '</div>';
    }

    if (entry.checkins.length) {
      html += '<div class="cal-detail-section">\u6253\u5361</div>';
      entry.checkins.forEach(function (h) {
        html += '<div class="cal-detail-habit">' +
          '<span class="d-dot" style="background:' + esc(h.color || "#FF5A36") + '"></span>' +
          esc(h.name) +
          '</div>';
      });
    }

    html += '</div>';
    return html;
  }
  routes.calendar = {
    title: "\u65E5\u5386",
    async render(el) {
      var tasksPromise = tasksRepo.list();
      var financesPromise = financeRepo.list();
      var habitsPromise = habitsRepo.list();
      var budgetPromise = getSetting("monthBudget", 0);

      var all = await Promise.all([tasksPromise, financesPromise, habitsPromise, budgetPromise]);
      var tasks = all[0], finances = all[1], habits = all[2], monthBudget = all[3];

      if (!el.isConnected) return;

      var dailyIdx = buildDayIndex(tasks, finances, habits);

      el.innerHTML = ctrlHtml() + overviewHtml(dailyIdx, finances, monthBudget) + gridHtml(dailyIdx) + detailHtml(dailyIdx);

      var rerender = function () { routes.calendar.render(el); };

      // el 是跨路由复用的 #view：事件用单个委托处理器 + 绑定一次守卫，
      // 否则每次 render 重绑 4 个监听器会累积（点一次翻 N 个月），且切路由后残留
      if (!el._calClickBound) {
        el._calClickBound = true;
        el.addEventListener("click", function (e) {
          var prev = e.target.closest("#calPrev");
          var next = e.target.closest("#calNext");
          var today = e.target.closest("#calToday");
          var cell = e.target.closest("[data-day]");
          if (!prev && !next && !today && !cell) return;
          if (cell) {
            var day = cell.dataset.day;
            calSelDay = calSelDay === day ? null : day;
          } else if (prev) {
            calMonth--;
            if (calMonth < 0) { calMonth = 11; calYear--; }
            calSelDay = null;
          } else if (next) {
            calMonth++;
            if (calMonth > 11) { calMonth = 0; calYear++; }
            calSelDay = null;
          } else {
            calYear = now.getFullYear();
            calMonth = now.getMonth();
            calSelDay = null;
          }
          rerender();
        });
      }
    },
  };
})();
