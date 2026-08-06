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
    return '<div class="cal-ctrl" style="display:flex;align-items:center;gap:10px;margin-bottom:16px">' +
      '<button class="icon-btn plain" id="calPrev" title="\u4E0A\u4E2A\u6708">' + WB.icon("prev") + '</button>' +
      '<span class="cal-ctrl-title" style="flex:1;text-align:center;font-weight:800;font-size:20px;color:var(--ink)">' + title + '</span>' +
      '<button class="icon-btn plain" id="calNext" title="\u4E0B\u4E2A\u6708">' + WB.icon("next") + '</button>' +
      (showToday ? '<button class="btn sm ghost" id="calToday" style="font-size:12px">\u56DE\u5230\u4ECA\u5929</button>' : '') +
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
          content += '<span class="cal-task-badge" style="display:inline-flex;font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;margin-top:2px;background:var(--danger);color:#fff">' + overdueTasks + '</span>';
        } else if (pendingTasks > 0) {
          content += '<span class="cal-task-badge" style="display:inline-flex;font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;margin-top:2px;background:var(--accent);color:#fff">' + pendingTasks + '</span>';
        }
        if (doneTasks > 0 && overdueTasks === 0 && pendingTasks === 0) {
          content += '<span class="cal-task-badge" style="display:inline-flex;font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px;margin-top:2px;background:var(--ok);color:#fff">\u2713</span>';
        }
      }

      if (entry && entry.txs.length) {
        var expenseTotal = 0, incomeTotal = 0;
        entry.txs.forEach(function (tx) {
          if (tx.type === "expense") expenseTotal += Number(tx.amount || 0);
          else if (tx.type === "income") incomeTotal += Number(tx.amount || 0);
        });
        if (expenseTotal > 0) {
          content += '<div class="cal-tx-sum" style="font-size:10px;color:var(--danger);font-weight:700;font-variant-numeric:tabular-nums">-' + fmtYuan(expenseTotal) + '</div>';
        } else if (incomeTotal > 0) {
          content += '<div class="cal-tx-sum" style="font-size:10px;color:var(--ok);font-weight:700;font-variant-numeric:tabular-nums">+' + fmtYuan(incomeTotal) + '</div>';
        }
      }

      if (entry && entry.checkins.length) {
        content += '<div class="cal-habit-dots" style="display:flex;gap:2px;margin-top:2px;flex-wrap:wrap">';
        var maxDots = Math.min(entry.checkins.length, 5);
        for (var hi = 0; hi < maxDots; hi++) {
          content += '<span class="d-dot" style="background:' + esc(entry.checkins[hi].color || "#FF5A36") + '"></span>';
        }
        if (entry.checkins.length > 5) {
          content += '<span class="d-more" style="font-size:10px;color:var(--muted);font-family:var(--mono)">+' + (entry.checkins.length - 5) + '</span>';
        }
        content += '</div>';
      }

      cells += '<div class="' + cls.join(" ") + '" data-day="' + key + '">' + content + '</div>';
    }

    return '<div class="cal-grid">' + cells + '</div>';
  }
  function detailHtml(dailyIdx) {
    if (!calSelDay) return '<div class="empty" style="margin-top:16px">\u70B9\u51FB\u65E5\u671F\u67E5\u770B\u5F53\u65E5\u8BE6\u60C5</div>';

    var entry = dailyIdx.get(calSelDay);
    if (!entry || (!entry.tasks.length && !entry.txs.length && !entry.checkins.length)) {
      return '<div class="card" style="margin-top:16px"><div class="empty">\u5F53\u65E5\u65E0\u8BB0\u5F55</div></div>';
    }

    var html = '<div class="card" style="margin-top:16px">';
    html += '<div style="font-size:14px;font-weight:800;margin-bottom:8px;color:var(--ink)">' + esc(calSelDay) + ' \u8BE6\u60C5</div>';

    if (entry.tasks.length) {
      html += '<div style="font-size:13px;font-weight:800;margin:12px 0 6px;color:var(--ink)">\u4EFB\u52A1</div>';
      entry.tasks.forEach(function (t) {
        var pLabel = PRIORITY_LABEL[t.priority] || "";
        var doneStyle = t.done ? ' style="text-decoration:line-through;color:var(--muted)"' : "";
        html += '<div style="display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0"' + doneStyle + '>' +
          (t.done ? '<span style="color:var(--ok);font-weight:700">\u2713</span>' : '<span class="pri-dot" style="background:' + (PRIORITY_COLOR[t.priority] || "var(--muted)") + '"></span>') +
          '<span style="flex:1">' + esc(t.title) + '</span>' +
          (pLabel ? '<span class="badge ' + priorityBadge(t.priority) + '">' + pLabel + '</span>' : "") +
          (isOverdue(t) ? '<span class="badge b-danger" style="margin-left:4px">\u903E\u671F</span>' : "") +
          '</div>';
      });
    }

    if (entry.txs.length) {
      html += '<div style="font-size:13px;font-weight:800;margin:12px 0 6px;color:var(--ink)">\u8BB0\u8D26</div>';
      var dayExpense = 0, dayIncome = 0;
      entry.txs.forEach(function (tx) {
        var amt = Number(tx.amount || 0);
        if (tx.type === "expense") {
          dayExpense += amt;
          html += '<div style="display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0">' +
            '<span style="flex:1">' + esc(tx.category || "") + (tx.note ? " \u00B7 " + esc(tx.note) : "") + '</span>' +
            '<span style="color:var(--danger)">-' + fmtYuan(amt) + '</span>' +
            '</div>';
        } else if (tx.type === "income") {
          dayIncome += amt;
          html += '<div style="display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0">' +
            '<span style="flex:1">' + esc(tx.category || "") + (tx.note ? " \u00B7 " + esc(tx.note) : "") + '</span>' +
            '<span style="color:var(--ok)">+' + fmtYuan(amt) + '</span>' +
            '</div>';
        } else {
          html += '<div style="display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0">' +
            '<span style="flex:1">' + esc(tx.category || "") + (tx.note ? " \u00B7 " + esc(tx.note) : "") + '</span>' +
            '<span>' + fmtYuan(amt) + '</span>' +
            '</div>';
        }
      });
      var net = dayIncome - dayExpense;
      html += '<div style="font-size:13px;font-weight:700;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">\u5F53\u65E5\u5408\u8BA1\uFF1A' +
        '<span style="color:var(--ok)">\u6536\u5165 +' + fmtYuan(dayIncome) + '</span> \u00B7 ' +
        '<span style="color:var(--danger)">\u652F\u51FA -' + fmtYuan(dayExpense) + '</span> \u00B7 ' +
        '<span style="color:' + (net >= 0 ? "var(--ok)" : "var(--danger)") + '">\u7ED3\u4F59 ' + (net >= 0 ? "+" : "") + fmtYuan(net) + '</span>' +
        '</div>';
    }

    if (entry.checkins.length) {
      html += '<div style="font-size:13px;font-weight:800;margin:12px 0 6px;color:var(--ink)">\u6253\u5361</div>';
      entry.checkins.forEach(function (h) {
        html += '<div style="display:flex;align-items:center;gap:6px;font-size:13px;padding:4px 0">' +
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

      var all = await Promise.all([tasksPromise, financesPromise, habitsPromise]);
      var tasks = all[0], finances = all[1], habits = all[2];

      if (!el.isConnected) return;

      var dailyIdx = buildDayIndex(tasks, finances, habits);

      el.innerHTML = ctrlHtml() + gridHtml(dailyIdx) + detailHtml(dailyIdx);

      var rerender = function () { routes.calendar.render(el); };

      // \u4E0A\u4E2A\u6708
      el.addEventListener("click", function (e) {
        var btn = e.target.closest("#calPrev");
        if (!btn) return;
        calMonth--;
        if (calMonth < 0) { calMonth = 11; calYear--; }
        calSelDay = null;
        rerender();
      });

      // \u4E0B\u4E2A\u6708
      el.addEventListener("click", function (e) {
        var btn = e.target.closest("#calNext");
        if (!btn) return;
        calMonth++;
        if (calMonth > 11) { calMonth = 0; calYear++; }
        calSelDay = null;
        rerender();
      });

      // \u56DE\u5230\u4ECA\u5929
      el.addEventListener("click", function (e) {
        var btn = e.target.closest("#calToday");
        if (!btn) return;
        calYear = now.getFullYear();
        calMonth = now.getMonth();
        calSelDay = null;
        rerender();
      });

      // \u70B9\u51FB\u65E5\u671F\u683C\u5B50
      el.addEventListener("click", function (e) {
        var cell = e.target.closest("[data-day]");
        if (!cell) return;
        var day = cell.dataset.day;
        calSelDay = calSelDay === day ? null : day;
        rerender();
      });
    },
  };
})();
