/**
 * gongkao.js — 考公中心：聚合考公标签的任务、笔记、习惯与模考记录
 *
 * 识别约定：
 * - 任务：tags 含字符串 "考公"
 * - 笔记：folder === "考公" 或 tags 含 "考公"
 * - 习惯：name 以 "考公" 开头
 * - 模考：mockexams store
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, todayStr, dateStr, getSetting, getSettings, setSetting, flashInvalid, cssVar, daysDiff, weekRange, streakOf, sortTasks } = window.WB;
  const tasksRepo = repo("tasks");
  const notesRepo = repo("notes");
  const habitsRepo = repo("habits");
  const examsRepo = repo("mockexams");

  let gkCharts = []; // 重渲染前销毁旧 Chart.js 实例
  let examFilter = "all"; // 模考趋势的科目筛选（模块级状态，rerender 后保持）
  let lastSubject = "行测"; // 上次录入的科目，连续录同科成绩时不用反复改

  const PRI = [
    { key: "high", label: "高", color: "var(--danger)", badge: "b-danger" },
    { key: "mid", label: "中", color: "var(--warn)", badge: "b-warn" },
    { key: "low", label: "低", color: "var(--primary)", badge: "b-primary" },
  ];
  const priOf = (k) => PRI.find((p) => p.key === k) || PRI[2];

  function isGongkaoTask(t) {
    return (t.tags || []).some((tg) => tg === "考公");
  }

  function isGongkaoNote(n) {
    return n.folder === "考公" || (n.tags || []).some((tg) => tg === "考公");
  }

  function isGongkaoHabit(h) {
    return (h.name || "").startsWith("考公");
  }

  function stillHere() {
    return location.hash === "#/gongkao";
  }

  function renderCharts(el, exams, tasks) {
    if (typeof Chart === "undefined") return;
    gkCharts.forEach((c) => c.destroy());
    gkCharts = [];

    const primary = cssVar("--primary"), ok = cssVar("--ok"), accent = cssVar("--accent"),
      muted = cssVar("--muted"), line = cssVar("--line"), purple = cssVar("--purple");
    const baseOpt = {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: muted, font: { size: 10 }, precision: 0 }, grid: { color: line } },
      },
    };

    const mk = (id, cfg) => {
      const cv = el.querySelector("#" + id);
      if (cv) gkCharts.push(new Chart(cv, cfg));
    };

    // 模考成绩趋势：单科目一条线；「全部」时每科目各一条线
    //（各科满分不同，跨科目混在一起求均值没有意义）
    const list = examFilter === "all" ? exams : exams.filter((e) => e.subject === examFilter);
    const subjects = [...new Set(list.map((e) => e.subject))];
    const dates = [...new Set(list.map((e) => e.date).filter(Boolean))].sort();
    const palette = [purple, primary, ok, accent, cssVar("--danger")];
    const datasets = subjects.map((s, i) => {
      const data = dates.map((d) => {
        const arr = list.filter((e) => e.subject === s && e.date === d).map((e) => Number(e.score) || 0);
        return arr.length ? Math.round((arr.reduce((x, y) => x + y, 0) / arr.length) * 10) / 10 : null;
      });
      const color = palette[i % palette.length];
      return { label: s, data, borderColor: color, backgroundColor: color, tension: 0.35, pointRadius: 3, spanGaps: true };
    });

    // 进面线基准线：单科目筛选且该科目有进面线记录时，画一条水平虚线（取该科目最近一次 cutoff）
    let cutoffDataset = null;
    if (subjects.length === 1) {
      const sub = subjects[0];
      const withCut = list.filter((e) => e.subject === sub && Number(e.cutoff) > 0);
      if (withCut.length) {
        const latest = withCut.sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
        const cv0 = Number(latest.cutoff);
        cutoffDataset = {
          label: `进面线 ${cv0}`,
          data: dates.map(() => cv0),
          borderColor: cssVar("--danger"), borderDash: [6, 4],
          borderWidth: 1.5, pointRadius: 0, fill: false,
        };
      }
    }
    const allDatasets = cutoffDataset ? datasets.concat([cutoffDataset]) : datasets;

    mk("chartMock", {
      type: "line",
      data: { labels: dates.map((d) => d.slice(5)), datasets: allDatasets },
      options: {
        ...baseOpt,
        plugins: { legend: { display: allDatasets.length > 1, labels: { color: muted, boxWidth: 8, font: { size: 10 } } } },
      },
    });

    // 近 14 天考公任务完成数
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      days.push(dateStr(d));
    }
    const doneByD = days.map((ds) => tasks.filter((t) => t.done && t.doneAt === ds).length);
    mk("chartGkTask", {
      type: "bar",
      data: {
        labels: days.map((d) => d.slice(5)),
        datasets: [{ data: doneByD, backgroundColor: accent, borderRadius: 8 }],
      },
      options: baseOpt,
    });
  }

  function taskItemHtml(t, today) {
    const p = priOf(t.priority);
    const overdue = !t.done && t.dueDate && t.dueDate < today;
    let dueBadge = "";
    if (t.dueDate) {
      const cls = overdue ? "b-danger" : t.dueDate === today ? "b-warn" : "b-ok";
      const lab = overdue ? "逾期 " + t.dueDate.slice(5) : t.dueDate === today ? "今天" : t.dueDate.slice(5);
      dueBadge = `<span class="badge ${cls}">${lab}</span>`;
    }
    return `<li class="item ${t.done ? "done" : ""}" data-id="${t.id}">
      <span class="chk" data-act="toggle"></span>
      <span class="pri-dot" style="background:${p.color}" title="${p.label}优先级"></span>
      <span class="txt">${esc(t.title)}${t.note ? `<span class="gk-task-note">${esc(t.note)}</span>` : ""}</span>
      ${dueBadge}
    </li>`;
  }

  function habitCardHtml(h, today) {
    const ck = h.checkins || {};
    const done = !!ck[today];
    return `<div class="gk-habit-card">
      <div class="gk-habit-info">
        <span class="dot" style="background:${esc(h.color || "var(--ok)")}"></span>
        <span class="txt">${esc(h.name)}</span>
        <span class="streak">🔥 ${streakOf(h)} 天</span>
      </div>
      <button class="btn sm ${done ? "ghost" : ""}" data-act="check-habit" data-hid="${h.id}">${done ? "✓ 已打卡" : "今日打卡"}</button>
    </div>`;
  }

  /** 进面线对比：过线绿、差线红，直接显示分差，不用自己心算 */
  function cutoffBadge(e) {
    if (!e.cutoff) return "";
    const d = (Number(e.score) || 0) - Number(e.cutoff);
    return d >= 0
      ? `<span class="badge b-ok">过线 +${d.toFixed(1)}</span>`
      : `<span class="badge b-danger">差线 ${(-d).toFixed(1)}</span>`;
  }

  /** 找当前记录下一条同科目记录（exams 已按日期倒序），用于涨跌对比 */
  function prevSameSubject(exams, idx) {
    const cur = exams[idx];
    if (!cur) return null;
    for (let i = idx + 1; i < exams.length; i++) {
      if (exams[i].subject === cur.subject) return exams[i];
    }
    return null;
  }

  /** 分数涨跌：进步绿 ▲、退步红 ▼ */
  function scoreDeltaHtml(cur, prev) {
    if (!prev) return "";
    const d = (Number(cur.score) || 0) - (Number(prev.score) || 0);
    if (Math.abs(d) < 0.05) return '<span class="gk-delta flat">— 0.0</span>';
    const up = d > 0;
    const color = up ? "var(--ok)" : "var(--danger)";
    const arrow = up ? "▲" : "▼";
    return `<span class="gk-delta" style="color:${color}">${arrow} ${up ? "+" : ""}${d.toFixed(1)}</span>`;
  }

  /** 考试目标卡：≤3 天卡片整体标红 + ⚠ 提醒（防漏报名截止/考前节点） */
  function targetHtml(targets) {
    if (!targets.length) {
      return '<div class="empty">还没有考试目标，添加一个开始倒计时</div>';
    }
    const today = todayStr();
    const view = targets
      .map((tg, idx) => ({ tg, idx, ended: daysDiff(today, tg.date) < 0 }))
      .sort((a, b) => (a.ended !== b.ended ? (a.ended ? 1 : -1) : a.tg.date < b.tg.date ? -1 : 1));
    const cards = view
      .map(({ tg, idx, ended }) => {
        const diff = daysDiff(today, tg.date);
        const soon = !ended && diff <= 3;
        return `<div class="gk-target ${ended ? "ended" : ""} ${soon ? "soon" : ""}">
          <div class="gk-target-name">${esc(tg.name)}<span class="gk-target-type">${esc(tg.type || "考试")}</span></div>
          <div class="gk-target-day">${ended ? "已结束" : diff + "<small>天</small>"}</div>
          ${soon ? `<div class="gk-target-warn">⚠ 还有 ${diff} 天</div>` : `<div class="gk-target-date">${esc(tg.date)}${ended ? "" : "后"}</div>`}
          <button class="icon-btn" data-act="del-target" data-idx="${idx}" title="删除目标">${WB.icon("del")}</button>
        </div>`;
      })
      .join("");
    return `<div class="gk-target-list">${cards}</div>`;
  }

  /** 备考清单渲染 */
  function checklistHtml(list) {
    if (!list.length) {
      return '<div class="empty">考前待办：报名材料 / 证件照 / 体检注意事项…</div>';
    }
    const items = list
      .map((it) => `<li class="item ${it.done ? "done" : ""}" data-cid="${it.id}">
        <span class="chk" data-act="toggle-check"></span>
        <span class="txt">${esc(it.text)}</span>
        <button class="icon-btn" data-act="del-check" title="删除">${WB.icon("del")}</button>
      </li>`)
      .join("");
    return `<ul class="list">${items}</ul>`;
  }

  routes.gongkao = {
    title: "考公",
    async render(el) {
      const [tasksAll, notesAll, habitsAll, examsAll, gkSt] = await Promise.all([
        tasksRepo.list(),
        notesRepo.list(),
        habitsRepo.list(),
        examsRepo.list(),
        getSettings({ gongkao_targets: [], gongkao_checklist: [] }),
      ]);
      const targets = gkSt.gongkao_targets, checklist = gkSt.gongkao_checklist;

      const today = todayStr();
      const gkTasks = tasksAll.filter(isGongkaoTask);
      const gkNotes = notesAll.filter(isGongkaoNote);
      const gkHabits = habitsAll.filter(isGongkaoHabit);
      const exams = examsAll.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));

      const activeGk = gkTasks.filter((t) => !t.done);
      const dueToday = activeGk.filter((t) => t.dueDate === today).length;
      const overdue = activeGk.filter((t) => t.dueDate && t.dueDate < today).length;

      const [monStr, sunStr] = weekRange();
      const weekTasks = gkTasks.filter((t) => t.dueDate && t.dueDate >= monStr && t.dueDate <= sunStr);
      const weekDone = weekTasks.filter((t) => t.done).length;
      const weekRate = weekTasks.length ? Math.round((weekDone / weekTasks.length) * 100) + "%" : "-";

      const habitDone = gkHabits.filter((h) => (h.checkins || {})[today]).length;

      const latestExam = exams[0];
      const latestPrev = latestExam ? prevSameSubject(exams, 0) : null;
      const latestDelta = latestExam ? scoreDeltaHtml(latestExam, latestPrev) : "";
      const latestExamTxt = latestExam
        ? `${Number(latestExam.score || 0).toFixed(1)} / ${Number(latestExam.fullScore || 100).toFixed(0)}`
        : "暂无";

      const recentNotes = gkNotes
        .slice()
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
        .slice(0, 5);

      const undoneSorted = sortTasks(activeGk);

      // 科目筛选选项从实际模考数据里收集（科目可自定义，不再硬编码）
      const subjectOpts = [...new Set(exams.map((e) => e.subject))];
      if (examFilter !== "all" && !subjectOpts.includes(examFilter)) examFilter = "all";

      el.innerHTML = `
        <div class="hero-greet">考公作战室</div>
        <div class="hero-date">今天 ${today.slice(0, 7)}-${today.slice(8)} · 共 ${gkTasks.length} 个复习任务 · ${gkHabits.length} 个备考习惯</div>

        <div class="card">
          <h2>考试目标<span class="count">${targets.length} 个</span></h2>
          <div class="row sp-b-lg">
            <input class="grow" id="gkTargetName" placeholder="考试名称，如：2026 国考" maxlength="50" />
            <input type="date" id="gkTargetDate" value="${today}" />
            <select id="gkTargetType">
              <option value="报名">报名</option>
              <option value="笔试">笔试</option>
              <option value="面试">面试</option>
              <option value="体检">体检</option>
              <option value="政审">政审</option>
              <option value="其它">其它</option>
            </select>
            <button class="btn sm" id="gkTargetAdd">添加目标</button>
          </div>
          <div id="gkTargetList">${targetHtml(targets)}</div>
        </div>

        <div class="stat-grid">
          <div class="stat" data-go="#/tasks"><div class="s-lab">今日到期 / 逾期</div><div class="s-val">${dueToday} / ${overdue}</div><div class="s-sub">共 ${activeGk.length} 项进行中</div></div>
          <div class="stat" data-go="#/tasks"><div class="s-lab">本周复习完成率</div><div class="s-val">${weekRate}</div><div class="s-sub">${monStr.slice(5)} ~ ${sunStr.slice(5)}</div>${weekTasks.length ? `<div class="mini-bar" style="margin-top:6px"><i style="width:${weekRate === "-" ? 0 : weekRate}"></i></div>` : ""}</div>
          <div class="stat" data-go="#/life"><div class="s-lab">考公习惯今日打卡</div><div class="s-val">${habitDone} / ${gkHabits.length}</div><div class="s-sub">${gkHabits.length === 0 ? "还没有备考习惯" : habitDone >= gkHabits.length ? "全部完成" : "继续加油"}</div></div>
          <div class="stat" data-act="go-exams"><div class="s-lab">最近模考</div><div class="s-val">${latestExamTxt}${latestDelta}</div><div class="s-sub">${latestExam ? esc(latestExam.subject) + " · " + esc(latestExam.date) + (latestPrev ? " · 较上次" : "") : "去下方录入第一次模考"}</div></div>
        </div>

        <div class="card">
          <h2>数据趋势</h2>
          <div class="chart-grid chart-grid-2">
            <div class="chart-box">
              <div class="chart-tt chart-tt-flex">
                <span>模考成绩趋势</span>
                <select id="examSubjectFilter" class="input-xs w-90">
                  <option value="all">全部</option>
                  ${subjectOpts.map((s) => `<option value="${esc(s)}" ${examFilter === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
                </select>
              </div>
              <canvas id="chartMock" height="160"></canvas>
            </div>
            <div class="chart-box">
              <div class="chart-tt">近 14 天考公任务完成数</div>
              <canvas id="chartGkTask" height="160"></canvas>
            </div>
          </div>
        </div>

        <div class="dash-actions">
          <div class="card">
            <h2>复习进度<span class="count">${undoneSorted.length} 项待完成</span></h2>
            <div class="row sp-b-md">
              <input class="grow" id="gkTaskTitle" placeholder="快速添加复习任务，自动打上「考公」标签" maxlength="100" />
              <input type="date" id="gkTaskDue" value="${today}" />
              <select id="gkTaskPri">
                <option value="high">高</option>
                <option value="mid" selected>中</option>
                <option value="low">低</option>
              </select>
              <button class="btn sm" id="gkTaskAdd">添加</button>
            </div>
            <ul class="list" id="gkTaskList">
              ${undoneSorted.length
                ? undoneSorted.map((t) => taskItemHtml(t, today)).join("")
                : '<div class="empty">没有待办的考公任务，用上方输入框添加第一项</div>'}
            </ul>
          </div>
          <div class="dash-col">
            <div class="card">
              <h2>习惯打卡<span class="count">${habitDone} / ${gkHabits.length}</span></h2>
              <div id="gkHabitList">
                ${gkHabits.length
                  ? gkHabits.map((h) => habitCardHtml(h, today)).join("")
                  : '<div class="empty">还没有考公习惯，去 <a href="#/life">生活</a> 页添加以「考公」开头的习惯</div>'}
              </div>
            </div>
            <div class="card">
              <h2>笔记速览<span class="count">${recentNotes.length}</span></h2>
              <ul class="list" id="gkNoteList">
                ${recentNotes.length
                  ? recentNotes.map((n) => `<li class="item gk-note-li" data-nid="${n.id}">
                      <span class="txt">${esc(n.title || "未命名笔记")}</span>
                      <span class="meta">${(n.updatedAt || "").slice(5, 16).replace("T", " ")}</span>
                    </li>`).join("")
                  : '<div class="empty">还没有考公笔记，去 <a href="#/notes">沉淀</a> 页建「考公」文件夹或打标签</div>'}
              </ul>
            </div>
          </div>
        </div>

        <div class="card" id="gkChecklistCard">
          <h2>备考清单<span class="count">${checklist.filter((it) => it.done).length} / ${checklist.length}</span></h2>
          <div class="row sp-b-md">
            <input class="grow" id="gkCheckText" placeholder="添加考前待办，如：准备证件照" maxlength="80" />
            <button class="btn sm" id="gkCheckAdd">添加</button>
          </div>
          <div id="gkChecklist">${checklistHtml(checklist)}</div>
        </div>

        <div class="card" id="gkExamCard">
          <h2>模考记录<span class="count">${exams.length} 条</span></h2>
          <div class="row gk-exam-form sp-b-lg">
            <input type="date" id="examDate" value="${today}" />
            <input id="examSubject" list="examSubjDl" value="${esc(lastSubject)}" placeholder="科目" maxlength="20" class="w-90" />
            <datalist id="examSubjDl">
              <option value="行测"></option><option value="申论"></option><option value="总分"></option>
              <option value="职测"></option><option value="综应"></option><option value="面试"></option>
            </datalist>
            <input type="number" id="examScore" placeholder="分数" min="0" step="0.1" class="w-90" />
            <input type="number" id="examFull" placeholder="满分" min="1" step="1" value="100" class="w-80" />
            <input type="number" id="examRank" placeholder="排名（可选）" min="1" step="1" class="w-110" />
            <input type="number" id="examCutoff" placeholder="进面线（可选）" min="0" step="0.1" class="w-110" />
            <input class="grow" id="examNote" placeholder="备注（可选）" maxlength="100" />
            <button class="btn sm" id="examAdd">添加</button>
          </div>
          <div id="gkExamList">
            ${exams.length
              ? `<ul class="list">${exams.map((e, i) => `<li class="item" data-id="${e.id}">
                  <span class="badge b-primary">${esc(e.subject)}</span>
                  <span class="txt"><b>${Number(e.score || 0).toFixed(1)}</b> / ${Number(e.fullScore || 100).toFixed(0)}
                    ${scoreDeltaHtml(e, prevSameSubject(exams, i))}
                    ${e.rank ? `<span class="exam-rank"> · 排名 ${Number(e.rank)}</span>` : ""}
                    ${cutoffBadge(e)}
                    ${e.note ? `<div class="sub">${esc(e.note)}</div>` : ""}
                  </span>
                  <span class="meta">${esc(e.date || "")}</span>
                  <button class="icon-btn" data-act="del-exam" title="删除">${WB.icon("del")}</button>
                </li>`).join("")}</ul>`
              : '<div class="empty">还没有模考记录，录入第一次成绩吧</div>'}
          </div>
        </div>

        <div class="footnote">考公中心自动聚合任务、笔记、习惯中含「考公」的数据 · 数据随各模块同步</div>`;

      renderCharts(el, exams, gkTasks);

      const rerender = () => routes.gongkao.render(el);

      // 考试目标
      const addTarget = async () => {
        const nameInput = el.querySelector("#gkTargetName");
        const dateInput = el.querySelector("#gkTargetDate");
        const typeInput = el.querySelector("#gkTargetType");
        const name = nameInput.value.trim();
        const date = dateInput.value;
        if (!name) return flashInvalid(nameInput);
        if (!date) return flashInvalid(dateInput);
        const arr = await getSetting("gongkao_targets", []);
        arr.push({ name, date, type: typeInput.value });
        await setSetting("gongkao_targets", arr);
        if (!stillHere()) return;
        rerender();
      };
      el.querySelector("#gkTargetAdd").addEventListener("click", addTarget);
      el.querySelector("#gkTargetName").addEventListener("keydown", (e) => { if (e.key === "Enter") addTarget(); });
      el.querySelector("#gkTargetList").addEventListener("click", async (e) => {
        const btn = e.target.closest('[data-act="del-target"]');
        if (!btn) return;
        const idx = Number(btn.dataset.idx);
        const arr = await getSetting("gongkao_targets", []);
        if (!(idx >= 0 && idx < arr.length)) return;
        if (!confirm(`删除考试目标「${arr[idx].name}」？`)) return;
        arr.splice(idx, 1);
        await setSetting("gongkao_targets", arr);
        if (!stillHere()) return;
        rerender();
      });

      // stat 跳转；「最近模考」就在本页，滚动到模考卡片即可
      el.querySelectorAll("[data-go]").forEach((s) => s.addEventListener("click", () => (location.hash = s.dataset.go)));
      el.querySelector('[data-act="go-exams"]').addEventListener("click", () =>
        el.querySelector("#gkExamCard").scrollIntoView({ behavior: "smooth" }));

      // 任务勾选
      el.querySelector("#gkTaskList").addEventListener("click", async (e) => {
        const chk = e.target.closest('[data-act="toggle"]');
        if (!chk) return;
        const id = chk.closest("[data-id]").dataset.id;
        const t = await tasksRepo.get(id);
        if (!t) return;
        t.done = true; t.doneAt = todayStr(); await tasksRepo.put(t);
        if (!stillHere()) return;
        rerender();
      });

      // 快速添加复习任务：自动带「考公」标签，与事务页字段完全一致
      const addGkTask = async () => {
        const titleInput = el.querySelector("#gkTaskTitle");
        const title = titleInput.value.trim();
        if (!title) return flashInvalid(titleInput);
        await tasksRepo.put({
          id: uid(),
          title,
          note: "",
          dueDate: el.querySelector("#gkTaskDue").value || "",
          priority: el.querySelector("#gkTaskPri").value,
          tags: ["考公"],
          done: false,
          createdAt: new Date().toISOString(),
        });
        if (!stillHere()) return;
        rerender();
      };
      el.querySelector("#gkTaskAdd").addEventListener("click", addGkTask);
      el.querySelector("#gkTaskTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") addGkTask(); });

      // 科目切换重绘图表（选择存模块级变量，rerender 后不丢）
      el.querySelector("#examSubjectFilter").addEventListener("change", (e) => {
        examFilter = e.target.value;
        renderCharts(el, exams, gkTasks);
      });

      // 习惯打卡
      el.querySelector("#gkHabitList").addEventListener("click", async (e) => {
        const btn = e.target.closest('[data-act="check-habit"]');
        if (!btn) return;
        const h = await habitsRepo.get(btn.dataset.hid);
        if (!h) return;
        h.checkins = h.checkins || {};
        if (h.checkins[today]) delete h.checkins[today]; else h.checkins[today] = true;
        await habitsRepo.put(h);
        if (!stillHere()) return;
        rerender();
      });

      // 笔记跳转
      el.querySelector("#gkNoteList").addEventListener("click", (e) => {
        const li = e.target.closest("[data-nid]");
        if (!li) return;
        WB.jump.noteId = li.dataset.nid;
        location.hash = "#/notes";
      });

      // 模考录入
      const addExam = async () => {
        const dateInput = el.querySelector("#examDate");
        const subjInput = el.querySelector("#examSubject");
        const scoreInput = el.querySelector("#examScore");
        const fullInput = el.querySelector("#examFull");
        const rankInput = el.querySelector("#examRank");
        const cutoffInput = el.querySelector("#examCutoff");
        const noteInput = el.querySelector("#examNote");
        const date = dateInput.value;
        const subject = subjInput.value.trim();
        const score = parseFloat(scoreInput.value);
        if (!date) return flashInvalid(dateInput);
        if (!subject) return flashInvalid(subjInput);
        if (!(score >= 0)) return flashInvalid(scoreInput);
        lastSubject = subject; // 记住科目，连续录入不用反复改
        await examsRepo.put({
          id: uid(),
          date,
          subject,
          score,
          fullScore: Number(fullInput.value) || 100,
          rank: rankInput.value ? Number(rankInput.value) : null,
          cutoff: cutoffInput.value ? parseFloat(cutoffInput.value) : null,
          note: noteInput.value.trim(),
          createdAt: new Date().toISOString(),
        });
        if (!stillHere()) return;
        rerender();
      };
      el.querySelector("#examAdd").addEventListener("click", addExam);
      el.querySelector("#examScore").addEventListener("keydown", (e) => { if (e.key === "Enter") addExam(); });

      // 备考清单：添加 / 勾选 / 删除
      const addCheck = async () => {
        const input = el.querySelector("#gkCheckText");
        const text = input.value.trim();
        if (!text) return flashInvalid(input);
        const list = await getSetting("gongkao_checklist", []);
        list.push({ id: uid(), text, done: false });
        await setSetting("gongkao_checklist", list);
        if (!stillHere()) return;
        rerender();
      };
      el.querySelector("#gkCheckAdd").addEventListener("click", addCheck);
      el.querySelector("#gkCheckText").addEventListener("keydown", (e) => { if (e.key === "Enter") addCheck(); });
      el.querySelector("#gkChecklist").addEventListener("click", async (e) => {
        const act = e.target.closest("[data-act]");
        if (!act) return;
        const li = act.closest("[data-cid]");
        if (!li) return;
        const cid = li.dataset.cid;
        const list = await getSetting("gongkao_checklist", []);
        const it = list.find((x) => x.id === cid);
        if (!it) return;
        if (act.dataset.act === "toggle-check") {
          it.done = !it.done;
        } else if (act.dataset.act === "del-check") {
          if (!confirm(`删除打卡「${it.text || ""}」？`)) return;
          list.splice(list.indexOf(it), 1);
        } else {
          return;
        }
        await setSetting("gongkao_checklist", list);
        if (!stillHere()) return;
        rerender();
      });

      // 模考删除
      el.querySelector("#gkExamList").addEventListener("click", async (e) => {
        const btn = e.target.closest('[data-act="del-exam"]');
        if (!btn) return;
        const id = btn.closest("[data-id]").dataset.id;
        const rec = exams.find((x) => x.id === id);
        if (!confirm(`删除这条模考记录（${(rec && rec.subject) || ""} ${rec ? Number(rec.score || 0).toFixed(1) : ""} 分）？`)) return;
        await examsRepo.delete(id);
        if (!stillHere()) return;
        rerender();
      });
    },
  };
})();
