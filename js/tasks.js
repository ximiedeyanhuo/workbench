/**
 * tasks.js — 事务追踪：任务列表（筛选/逾期高亮）+ 月历视图
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, todayStr, dateStr, parseTags, flashInvalid, weekRange, sortTasks, repeatNext } = window.WB;
  const tasksRepo = repo("tasks");

  const PRI = [
    { key: "high", label: "高", color: "var(--danger)", badge: "b-danger" },
    { key: "mid", label: "中", color: "var(--warn)", badge: "b-warn" },
    { key: "low", label: "低", color: "var(--primary)", badge: "b-primary" },
  ];
  const priOf = (k) => PRI.find((p) => p.key === k) || PRI[2];

  const REPEAT = [
    { key: "", label: "不重复" },
    { key: "daily", label: "每天" },
    { key: "weekly", label: "每周" },
  ];
  const repeatLab = (k) => (REPEAT.find((r) => r.key === k) || REPEAT[0]).label;

  // 模块内状态（跨渲染保留）
  let view = "list"; // list | calendar | kanban
  let filter = "all"; // all | today | week | done
  let editingId = null; // 正在行内编辑的任务 id
  let pendingTaskTitle = null; // 灵感速记「转为任务」待填入新建输入框的文本
  let aiSortOrder = null; // AI 排序结果：{ ids: [...], reason: "...", at: ts, signature: "ids 拼接" }；signature 失效就重排
  let aiSortExpires = 0; // 缓存过期时间戳（30 分钟）
  const now = new Date();
  let calYear = now.getFullYear();
  let calMonth = now.getMonth(); // 0-based
  let selectedDay = todayStr();

  function taskItemHtml(t, today) {
    // 行内编辑态：整行替换为编辑表单
    if (t.id === editingId) {
      return `<li class="item editing" data-id="${t.id}">
        <div class="edit-form">
          <div class="row">
            <input class="grow" data-ef="title" value="${esc(t.title)}" maxlength="100" placeholder="任务标题" />
            <input type="date" data-ef="due" value="${esc(t.dueDate || "")}" title="截止日期" />
            <select data-ef="pri">
              ${PRI.map((p) => `<option value="${p.key}" ${t.priority === p.key ? "selected" : ""}>${p.label}优先</option>`).join("")}
            </select>
            <select data-ef="repeat" title="重复周期（需设截止日）">
              ${REPEAT.map((r) => `<option value="${r.key}" ${(t.repeat || "") === r.key ? "selected" : ""}>${r.label}</option>`).join("")}
            </select>
          </div>
          <div class="row sp-t-sm">
            <input data-ef="tags" placeholder="标签（逗号分隔）" class="w-160" maxlength="60" value="${esc((t.tags || []).join(", "))}" />
            <input class="grow" data-ef="note" placeholder="备注" maxlength="200" value="${esc(t.note || "")}" />
            <button class="btn sm" data-act="save-edit">保存</button>
            <button class="btn ghost sm" data-act="cancel-edit">取消</button>
          </div>
        </div>
      </li>`;
    }
    const p = priOf(t.priority);
    const overdue = !t.done && t.dueDate && t.dueDate < today;
    let dueBadge = "";
    if (t.dueDate) {
      const cls = overdue ? "b-danger" : t.dueDate === today ? "b-warn" : "b-ok";
      const lab = overdue ? "逾期 " + t.dueDate.slice(5) : t.dueDate === today ? "今天" : t.dueDate.slice(5);
      dueBadge = `<span class="badge ${cls}">${lab}</span>`;
    }
    return `<li class="item ${t.done ? "done" : ""}" data-id="${t.id}">
      <span class="chk" data-act="toggle">${t.done ? "✓" : ""}</span>
      <span class="pri-dot" style="background:${p.color}" title="${p.label}优先级"></span>
      <span class="txt">${esc(t.title)}${t.note ? `<div class="sub">${esc(t.note)}</div>` : ""}</span>
      ${(t.tags || []).map((tg) => `<span class="tag">${esc(tg)}</span>`).join("")}
      ${t.repeat ? `<span class="tag" title="完成后自动生成下一期">🔁 ${repeatLab(t.repeat)}</span>` : ""}
      ${dueBadge}
      <button class="icon-btn plain" data-act="edit" title="编辑">${WB.icon("edit")}</button>
      <button class="icon-btn" data-act="del" title="删除">${WB.icon("del")}</button>
    </li>`;
  }

  // ---------- 列表视图 ----------
  function renderList(tasks, today) {
    const [monStr, sunStr] = weekRange();
    let list = tasks;
    if (filter === "today") list = tasks.filter((t) => !t.done && (t.dueDate === today || (t.dueDate && t.dueDate < today)));
    else if (filter === "week") list = tasks.filter((t) => !t.done && t.dueDate && t.dueDate >= monStr && t.dueDate <= sunStr);
    else if (filter === "done") list = tasks.filter((t) => t.done);
    list = sortTasks(list);
    // AI 排序覆盖：只对未完成 + 有 _aiOrd 的项生效，已完成保持 sortTasks 结果
    if (aiSortOrder) {
      const ord = new Map(aiSortOrder.ids.map((id, i) => [id, i]));
      list = list.slice().sort((a, b) => {
        const ao = a.done ? Infinity : (ord.has(a.id) ? ord.get(a.id) : 99999);
        const bo = b.done ? Infinity : (ord.has(b.id) ? ord.get(b.id) : 99999);
        if (ao !== bo) return ao - bo;
        return 0;
      });
    }
    if (!list.length) return '<div class="empty">这里空空如也～</div>';
    return list.map((t) => taskItemHtml(t, today)).join("");
  }

  // ---------- 日历视图 ----------
  function renderCalendar(tasks, today) {
    const first = new Date(calYear, calMonth, 1);
    const offset = (first.getDay() + 6) % 7; // 周一起始
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const cells = [];
    // 上月补位
    const prevDays = new Date(calYear, calMonth, 0).getDate();
    for (let i = offset - 1; i >= 0; i--) {
      const d = new Date(calYear, calMonth - 1, prevDays - i);
      cells.push({ date: dateStr(d), num: prevDays - i, dim: true });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      cells.push({ date: dateStr(new Date(calYear, calMonth, i)), num: i, dim: false });
    }
    while (cells.length % 7 !== 0) {
      const idx = cells.length - (offset + daysInMonth);
      const d = new Date(calYear, calMonth + 1, idx + 1);
      cells.push({ date: dateStr(d), num: idx + 1, dim: true });
    }

    const byDay = {};
    tasks.forEach((t) => {
      if (!t.dueDate) return;
      (byDay[t.dueDate] = byDay[t.dueDate] || []).push(t);
    });

    const wdHtml = ["一", "二", "三", "四", "五", "六", "日"].map((w) => `<div class="cal-wd">${w}</div>`).join("");
    const cellHtml = cells
      .map((c) => {
        const dayTasks = byDay[c.date] || [];
        const dots = dayTasks
          .slice(0, 4)
          .map((t) => `<span class="d-dot" style="background:${t.done ? "var(--ok)" : priOf(t.priority).color}"></span>`)
          .join("");
        const more = dayTasks.length > 4 ? `<span class="d-more">+${dayTasks.length - 4}</span>` : "";
        return `<div class="cal-cell ${c.dim ? "dim" : ""} ${c.date === today ? "today" : ""} ${c.date === selectedDay ? "sel" : ""}" data-day="${c.date}">
          <span class="d-num">${c.num}</span><div class="d-dots">${dots}${more}</div>
        </div>`;
      })
      .join("");

    const dayTasks = sortTasks((byDay[selectedDay] || []));
    const dayPanel = `
      <div class="sp-t-2x">
        <h2 style="font-size:14px;margin-bottom:10px">📌 ${selectedDay}（${dayTasks.length} 项）</h2>
        <div class="row sp-b-md">
          <input class="grow" id="dayTaskInput" placeholder="给这一天添加任务…" maxlength="100" />
          <button class="btn sm" id="dayTaskAdd">添加</button>
        </div>
        <ul class="list" id="dayTaskList">
          ${dayTasks.length ? dayTasks.map((t) => taskItemHtml(t, today)).join("") : '<div class="empty">这天暂无任务</div>'}
        </ul>
      </div>`;

    return `
      <div class="cal-head">
        <button class="btn ghost sm" id="calPrev">${WB.icon("prev")}</button>
        <span class="cal-title">${calYear} 年 ${calMonth + 1} 月</span>
        <button class="btn ghost sm" id="calNext">${WB.icon("next")}</button>
      </div>
      <div class="cal-grid">${wdHtml}${cellHtml}</div>
      ${dayPanel}`;
  }

  // ---------- 看板视图：按优先级分列，方便一眼看"该先做哪件" ----------
  // 每列最多 8 条 + "更多"展开剩余（避免列过长）；已完成任务不进看板
  // expandPri: 传入"high/mid/low" 时取消该列上限，列出全部
  function renderKanban(tasks, today, expandPri) {
    const active = tasks.filter((t) => !t.done);
    if (!active.length) return '<div class="empty">没有进行中的任务，去上面新建一个吧</div>';
    const cols = [
      { key: "high", title: "高优先", icon: "🔥", color: "var(--danger)" },
      { key: "mid", title: "中优先", icon: "🌿", color: "var(--warn)" },
      { key: "low", title: "低优先", icon: "🪨", color: "var(--primary)" },
    ];
    const sorted = (arr) => arr.slice().sort((a, b) => {
      // 逾期 > 今天 > 之后 > 无日期；同档内按创建时间
      const ad = a.dueDate || "9999-99-99";
      const bd = b.dueDate || "9999-99-99";
      if (ad !== bd) return ad.localeCompare(bd);
      return (a.createdAt || "").localeCompare(b.createdAt || "");
    });
    const colHtml = cols.map((c) => {
      const list = sorted(active.filter((t) => (t.priority || "mid") === c.key));
      const head = `<div class="kb-col-head"><span class="kb-ico">${c.icon}</span><span class="kb-tt" style="color:${c.color}">${c.title}</span><span class="kb-cnt">${list.length}</span></div>`;
      if (!list.length) return `<div class="kb-col"><div class="kb-col-head"><span class="kb-ico">${c.icon}</span><span class="kb-tt" style="color:${c.color}">${c.title}</span><span class="kb-cnt">0</span></div><div class="kb-empty">这列空了</div></div>`;
      const limit = expandPri === c.key ? 999 : 8;
      const visible = list.slice(0, limit);
      const more = list.length - visible.length;
      const cards = visible.map((t) => {
        const p = priOf(t.priority);
        const overdue = t.dueDate && t.dueDate < today;
        const todayDue = t.dueDate === today;
        const due = t.dueDate ? (overdue ? "逾期 " + t.dueDate.slice(5) : todayDue ? "今天" : t.dueDate.slice(5)) : "无截止";
        const dueCls = overdue ? "b-danger" : todayDue ? "b-warn" : "b-muted";
        const tags = (t.tags || []).slice(0, 2).map((tg) => `<span class="tag">${esc(tg)}</span>`).join("");
        return `<li class="kb-card ${overdue ? "over" : ""}" data-id="${t.id}">
          <div class="kb-card-row"><span class="chk" data-act="toggle">${t.done ? "✓" : ""}</span><span class="pri-dot" style="background:${p.color}"></span><span class="kb-title">${esc(t.title)}</span></div>
          <div class="kb-card-meta">${tags}<span class="badge ${dueCls}">${due}</span>${t.repeat ? `<span class="tag" title="完成后自动生成下一期">🔁</span>` : ""}</div>
        </li>`;
      }).join("");
      const moreBtn = more > 0 ? `<button class="kb-more" data-act="kb-show" data-pri="${c.key}">展开剩余 ${more} 条</button>` : "";
      return `<div class="kb-col"><div class="kb-col-head"><span class="kb-ico">${c.icon}</span><span class="kb-tt" style="color:${c.color}">${c.title}</span><span class="kb-cnt">${list.length}</span></div><ul class="kb-list">${cards}</ul>${moreBtn}</div>`;
    }).join("");
    const foot = expandPri
      ? `<div class="kb-foot">已展开全部 · <button class="btn ghost sm" id="kbCollapse">收起</button></div>`
      : `<div class="kb-foot">看板仅展示未完成任务；切换到「已完成」可看历史</div>`;
    return `<div class="kb-board" id="kbBoard">${colHtml}</div>
      ${foot}`;
  }

  // ---------- 主渲染 ----------
  routes.tasks = {
    title: "事务",
    async render(el) {
      const tasks = await tasksRepo.list();
      // 慢请求返回时用户可能已切走路由：不校验会把任务页覆写到当前页面上
      if (location.hash !== "#/tasks") return;
      const today = todayStr();
      const activeCnt = tasks.filter((t) => !t.done).length;
      const overdueTasks = tasks.filter((t) => !t.done && t.dueDate && t.dueDate < today);

      // 全局搜索跳转：定位到目标任务并直接进入编辑态
      if (WB.jump.taskId) {
        const target = tasks.find((t) => t.id === WB.jump.taskId);
        WB.jump.taskId = null;
        if (target) { view = "list"; filter = target.done ? "done" : "all"; editingId = target.id; }
      }
      // 灵感速记「转为任务」：把速记文本填入新建任务输入框（一次性消费）
      if (WB.jump.taskTitle) {
        pendingTaskTitle = WB.jump.taskTitle;
        WB.jump.taskTitle = null;
      }
      const taskTitleDraft = pendingTaskTitle || "";
      pendingTaskTitle = null;

      el.innerHTML = `
        <div class="card">
          <h2>新建任务</h2>
          <div class="row">
            <input class="grow" id="tTitle" placeholder="要做什么事…" maxlength="100" value="${esc(taskTitleDraft)}" />
            <input type="date" id="tDue" title="截止日期" />
            <span class="due-quick">
              <button class="btn ghost sm" data-due="today">今天</button>
              <button class="btn ghost sm" data-due="tomorrow">明天</button>
              <button class="btn ghost sm" data-due="weekend">周末</button>
            </span>
            <select id="tPri">
              <option value="mid">中优先</option>
              <option value="high">高优先</option>
              <option value="low">低优先</option>
            </select>
            <select id="tRepeat" title="重复周期：完成后自动生成下一期（需设截止日）">
              <option value="">不重复</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
            <input id="tTags" placeholder="标签（逗号分隔）" class="w-150" maxlength="60" />
            <button class="btn in-card-btn" id="tAdd">添加</button>
            <button class="btn ghost in-card-btn" id="tAiSplit" title="AI 把大任务拆成可执行小任务">${WB.icon("sparkle")} AI 拆解</button>
            <button class="btn ghost in-card-btn" id="tAiSort" title="AI 按紧急+重要给未完成任务排序">${WB.icon("sparkle")} AI 排序</button>
          </div>
          <div id="tAiPanel"></div>
        </div>
        <div class="card">
          <h2>任务
            <span class="count">${activeCnt} 项进行中</span>
          </h2>
          <div class="row" style="justify-content:space-between;margin-bottom:12px">
            <div class="tabs" id="taskTabs">
              <button class="tab ${filter === "all" ? "on" : ""}" data-f="all">全部</button>
              <button class="tab ${filter === "today" ? "on" : ""}" data-f="today">今天</button>
              <button class="tab ${filter === "week" ? "on" : ""}" data-f="week">本周</button>
              <button class="tab ${filter === "done" ? "on" : ""}" data-f="done">已完成</button>
            </div>
            <div class="tabs align-c">
              ${view === "list" && overdueTasks.length ? `<button class="btn ghost sm" id="tPostpone" title="把所有逾期未完成任务的截止日改为今天">${WB.icon("forward")} 逾期顺延到今天（${overdueTasks.length}）</button>` : ""}
              <button class="tab ${view === "list" ? "on" : ""}" data-v="list">${WB.icon("list")} 列表</button>
              <button class="tab ${view === "calendar" ? "on" : ""}" data-v="calendar">${WB.icon("calendar")} 日历</button>
              <button class="tab ${view === "kanban" ? "on" : ""}" data-v="kanban" title="按优先级分列的看板视图">看板</button>
            </div>
          </div>
          <div id="taskBody">
            ${view === "list" ? `${aiSortOrder ? `<div class="ai-panel" style="margin-bottom:10px;font-size:12.5px"><b>✨ AI 排序建议：</b>${esc(aiSortOrder.reason || "已按 AI 评分重排")} · <button class="btn ghost sm" id="aiSortClear">恢复默认</button></div>` : ""}<ul class="list">${renderList(tasks, today)}</ul>` : view === "calendar" ? renderCalendar(tasks, today) : renderKanban(tasks, today)}
          </div>
        </div>`;

      // rerender 统一守卫：AI 排序/拆解等秒级回调期间用户切走路由后，不再把任务视图写回 #view
      const rerender = () => { if (location.hash !== "#/tasks") return; routes.tasks.render(el); };

      // 新建任务
      const addTask = async () => {
        const titleInput = el.querySelector("#tTitle");
        const title = titleInput.value.trim();
        if (!title) return flashInvalid(titleInput);
        await tasksRepo.put({
          id: uid(),
          title,
          note: "",
          dueDate: el.querySelector("#tDue").value || "",
          priority: el.querySelector("#tPri").value,
          tags: parseTags(el.querySelector("#tTags").value),
          repeat: el.querySelector("#tRepeat").value,
          done: false,
          createdAt: new Date().toISOString(),
        });
        rerender();
      };
      el.querySelector("#tAdd").addEventListener("click", addTask);

      // 逾期一键顺延：所有逾期未完成任务的截止日改为今天，避免逐条手改
      const pp = el.querySelector("#tPostpone");
      if (pp)
        pp.addEventListener("click", async () => {
          if (!confirm(`把 ${overdueTasks.length} 项逾期任务的截止日统一顺延到今天？`)) return;
          const needUpdate = overdueTasks.filter((t) => t.dueDate !== today);
          if (needUpdate.length) await tasksRepo.bulkPut(needUpdate.map((t) => ({ ...t, dueDate: today })));
          rerender();
        });

      // 日期快捷按钮：今天 / 明天 / 最近的周六（周六当天即今天，周日则取下周六）
      el.querySelectorAll("[data-due]").forEach((b) =>
        b.addEventListener("click", () => {
          const d = new Date();
          if (b.dataset.due === "tomorrow") d.setDate(d.getDate() + 1);
          else if (b.dataset.due === "weekend") d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
          el.querySelector("#tDue").value = dateStr(d);
        })
      );
      el.querySelector("#tTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") addTask(); });

      // 全局快捷键 N：跳转并聚焦新建任务输入框
      if (WB.jump.taskFocus) {
        WB.jump.taskFocus = null;
        setTimeout(() => { const ti = el.querySelector("#tTitle"); if (ti) ti.focus(); }, 0);
      }

      // AI 拆解：把标题框里的大任务拆成 3-6 个子任务，勾选确认后批量入库
      const aiBtn = el.querySelector("#tAiSplit");
      if (!window.WB.USE_API) {
        aiBtn.disabled = true;
        aiBtn.classList.add("offline-disabled");
        aiBtn.title = "离线中，AI 不可用";
      }
      aiBtn.addEventListener("click", async () => {
        if (!window.WB.USE_API) return window.WB.showToast("离线中，AI 拆解不可用", "error");
        const st = await WB.ai.status();
        if (!st.configured) return window.WB.showToast("未配置智谱 API Key：设环境变量 ZHIPU_API_KEY 或在项目根创建 zhipu.key 文件后重启服务", "error");
        const titleInput = el.querySelector("#tTitle");
        const title = titleInput.value.trim();
        if (!title) return flashInvalid(titleInput);
        const panel = el.querySelector("#tAiPanel");
        aiBtn.disabled = true;
        aiBtn.textContent = "拆解中…";
        panel.innerHTML = '<div class="ai-panel">正在请智谱拆解「' + esc(title) + '」…</div>';
        try {
          const text = await WB.ai.chat(
            "你是任务规划助手。只输出 JSON 数组，不要任何解释。",
            '把下面这个任务拆解为 3-6 个具体可执行的子任务，按先后顺序排列，每个不超过 25 字。输出 JSON：["子任务1", "子任务2", ...]\n\n任务：' + title
          );
          const arr = WB.ai.parseJson(text);
          if (!Array.isArray(arr) || !arr.length) throw new Error("模型返回格式异常，请重试");
          const subs = arr.map(String).slice(0, 8);
          panel.innerHTML = `<div class="ai-panel">
            <div class="ai-panel-tt">✨ 「${esc(title)}」拆解结果（取消勾选不需要的）</div>
            ${subs.map((s, i) => `<label class="ai-sub"><input type="checkbox" checked data-sub="${i}" /> ${esc(s)}</label>`).join("")}
            <div class="row sp-t-sm">
              <button class="btn sm" id="aiSubAdd">添加选中项为任务</button>
              <button class="btn ghost sm" id="aiSubClose">关闭</button>
            </div>
          </div>`;
          panel.querySelector("#aiSubClose").addEventListener("click", () => { panel.innerHTML = ""; });
          panel.querySelector("#aiSubAdd").addEventListener("click", async () => {
            const picked = Array.from(panel.querySelectorAll("[data-sub]:checked")).map((c) => subs[Number(c.dataset.sub)]);
            if (!picked.length) return;
            const dueDate = el.querySelector("#tDue").value || "";
            const priority = el.querySelector("#tPri").value;
            const now = Date.now();
            // 序号前缀保留拆解顺序；createdAt 递增保证排序稳定
            await tasksRepo.bulkPut(picked.map((s, i) => ({
              id: uid(), title: (i + 1) + ". " + s, note: "AI 拆解自：" + title,
              dueDate, priority, tags: [], done: false,
              createdAt: new Date(now + i).toISOString(),
            })));
            titleInput.value = "";
            rerender();
          });
        } catch (err) {
          panel.innerHTML = `<div class="ai-panel err">AI 调用失败：${esc(err.message)}</div>`;
        } finally {
          aiBtn.disabled = false;
          aiBtn.innerHTML = WB.icon("sparkle") + " AI 拆解";
        }
      });

      // AI 智能排序：把未完成任务的 id 列表提交给 AI，按"紧急+重要"返回新顺序
      // 缓存 30 分钟；任务数变化（增删/勾选）使 signature 失效，自动重排
      const sortBtn = el.querySelector("#tAiSort");
      if (sortBtn) {
        if (!window.WB.USE_API) {
          sortBtn.disabled = true;
          sortBtn.classList.add("offline-disabled");
          sortBtn.title = "离线中，AI 不可用";
        }
        sortBtn.addEventListener("click", async () => {
          if (!window.WB.USE_API) return window.WB.showToast("离线中，AI 排序不可用", "error");
          const st = await WB.ai.status();
          if (!st.configured) return window.WB.showToast("未配置智谱 API Key", "error");
          const active = tasks.filter((t) => !t.done);
          if (active.length < 2) return window.WB.showToast("未完成任务不足 2 条，无需排序", "info");
          const signature = active.map((t) => t.id).sort().join(",");
          const fresh = aiSortOrder && aiSortOrder.signature === signature && Date.now() < aiSortExpires;
          if (fresh) {
            applyAiSort();
            return window.WB.showToast("已按 AI 排序（缓存）", "info");
          }
          sortBtn.disabled = true;
          const oldHtml = sortBtn.innerHTML;
          sortBtn.innerHTML = "排序中…";
          try {
            const list = active.map((t) => {
              const overdue = t.dueDate && t.dueDate < today ? "⚠逾期" : (t.dueDate === today ? "📅今天" : (t.dueDate ? "截止" + t.dueDate.slice(5) : "无截止"));
              const tags = (t.tags || []).join("/");
              return `${t.id} | ${t.title} | ${t.priority || "mid"} | ${overdue}${tags ? " | 标签:" + tags : ""}`;
            }).join("\n");
            const sys = "你是个人任务排序助手。基于截止日/优先级/标签给出的【重要-紧急】维度，返回新的处理顺序（更靠前 = 更该先做）。只输出 JSON：{\"order\": [\"id1\",\"id2\",...], \"reason\": \"一句话说明排序思路，30 字内\"}。不要解释。";
            const prompt = "请按【应优先完成】顺序重排这些任务，输出 JSON：\n" + list;
            const text = await WB.ai.chat(sys, prompt, 0.3);
            const obj = WB.ai.parseJson(text);
            if (!obj || !Array.isArray(obj.order) || !obj.order.length) throw new Error("模型返回格式异常");
            // 容错：剔除不在当前任务列表的 id；剩下的保持原顺序补齐末尾（防 AI 漏掉）
            const valid = new Set(active.map((t) => t.id));
            const ordered = obj.order.filter((id) => valid.has(id));
            const missed = active.map((t) => t.id).filter((id) => !ordered.includes(id));
            aiSortOrder = { ids: ordered.concat(missed), reason: String(obj.reason || "").slice(0, 60), at: Date.now(), signature };
            aiSortExpires = Date.now() + 30 * 60 * 1000;
            applyAiSort();
            window.WB.showToast("✨ AI 已排序：" + aiSortOrder.reason, "info");
          } catch (err) {
            window.WB.showToast("AI 排序失败：" + err.message, "error");
          } finally {
            sortBtn.disabled = false;
            sortBtn.innerHTML = oldHtml;
          }
        });
      }
      function applyAiSort() {
        if (!aiSortOrder) return;
        view = "list";
        filter = "all";
        rerender();
      }

      // 筛选 / 视图切换
      el.querySelectorAll("[data-f]").forEach((t) =>
        t.addEventListener("click", () => { filter = t.dataset.f; rerender(); })
      );
      el.querySelectorAll("[data-v]").forEach((t) =>
        t.addEventListener("click", () => { view = t.dataset.v; rerender(); })
      );

      // AI 排序"恢复默认"按钮
      const sortClear = el.querySelector("#aiSortClear");
      if (sortClear) sortClear.addEventListener("click", () => { aiSortOrder = null; rerender(); });

      // 任务操作（勾选/编辑/删除）——事件委托
      el.querySelector("#taskBody").addEventListener("click", async (e) => {
        const actEl = e.target.closest("[data-act]");
        if (actEl) {
          // 看板"展开剩余"按钮不在 [data-id] 祖先内，li 可能为 null
          const li = actEl.closest("[data-id]");
          const id = li ? li.dataset.id : null;
          if (actEl.dataset.act === "toggle") {
            const t = await tasksRepo.get(id);
            if (t) {
              t.done = !t.done;
              t.doneAt = t.done ? todayStr() : "";
              await tasksRepo.put(t);
              // 重复任务：勾完后自动生成下一期（取消完成不生成，避免反复勾造出重复条）
              if (t.done) {
                const next = repeatNext(t);
                if (next) await tasksRepo.put(next);
              }
            }
          } else if (actEl.dataset.act === "del") {
            const t = await tasksRepo.get(id);
            if (!confirm(`删除任务「${(t && t.title) || ""}」？`)) return;
            await tasksRepo.delete(id);
          } else if (actEl.dataset.act === "edit") {
            editingId = id;
          } else if (actEl.dataset.act === "cancel-edit") {
            editingId = null;
          } else if (actEl.dataset.act === "save-edit") {
            const titleInput = li.querySelector('[data-ef="title"]');
            const title = titleInput.value.trim();
            if (!title) return flashInvalid(titleInput); // 标题必填，不关闭编辑态
            const t = await tasksRepo.get(id);
            if (t) {
              t.title = title;
              t.dueDate = li.querySelector('[data-ef="due"]').value || "";
              t.priority = li.querySelector('[data-ef="pri"]').value;
              t.tags = parseTags(li.querySelector('[data-ef="tags"]').value);
              t.note = li.querySelector('[data-ef="note"]').value.trim();
              t.repeat = li.querySelector('[data-ef="repeat"]').value;
              await tasksRepo.put(t);
            }
            editingId = null;
          } else if (actEl.dataset.act === "kb-show") {
            // 看板列展开剩余：临时把限制放到 999，重新渲染
            const pri = actEl.dataset.pri;
            const tb = el.querySelector("#taskBody");
            const newHtml = renderKanban(tasks, today, pri);
            tb.innerHTML = newHtml;
            tb.querySelector("#kbCollapse").addEventListener("click", () => rerender());
            return;
          }
          rerender();
          return;
        }
        // 日历格子点选
        const cell = e.target.closest("[data-day]");
        if (cell) { selectedDay = cell.dataset.day; rerender(); }
      });

      // 日历控件
      if (view === "calendar") {
        el.querySelector("#calPrev").addEventListener("click", () => {
          calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } rerender();
        });
        el.querySelector("#calNext").addEventListener("click", () => {
          calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } rerender();
        });
        const dayAdd = async () => {
          const input = el.querySelector("#dayTaskInput");
          const title = input.value.trim();
          if (!title) return flashInvalid(input);
          await tasksRepo.put({
            id: uid(), title, note: "", dueDate: selectedDay, priority: "mid",
            tags: [], done: false, createdAt: new Date().toISOString(),
          });
          rerender();
        };
        el.querySelector("#dayTaskAdd").addEventListener("click", dayAdd);
        el.querySelector("#dayTaskInput").addEventListener("keydown", (e) => { if (e.key === "Enter") dayAdd(); });
      }
    },
  };
})();
