/* achievements.js — 个人成就系统
 * - 规则基于现有数据动态计算（记账/任务/笔记/习惯/健康/理财/书影音/时间轴），不新增业务表
 * - 解锁时间持久化在 settings.achUnlocked：{规则id: "YYYY-MM-DD HH:mm"}，只记一次
 * - 规则可自定义：settings.achRules：{规则id: {target: N, off: true}}
 * - 启动后每日静默检查一次（app.js 调 checkNew），新解锁弹 toast；不打扰其它时刻
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, esc, showToast, getSetting, setSetting, getSettings } = window.WB;

  /** 最长连续天数：dates 为 "YYYY-MM-DD" 去重排序数组 */
  function bestStreak(dates) {
    if (!dates.length) return 0;
    let best = 1, run = 1;
    for (let i = 1; i < dates.length; i++) {
      const gap = Math.round((new Date(dates[i] + "T00:00:00") - new Date(dates[i - 1] + "T00:00:00")) / 86400000);
      run = gap === 1 ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  }

  /** 从数据快照算每条规则的当前值 */
  function valuesOf(d) {
    const finance = d.finance || [], tasks = d.tasks || [], notes = d.notes || [], habits = d.habits || [];
    const health = d.health || [], stocks = d.stocks || [], media = d.media || [], timeline = d.timeline || [];

    const finDates = Array.from(new Set(finance.map((r) => (r.date || "").slice(0, 10)).filter(Boolean))).sort();
    const finStreak = bestStreak(finDates);
    const saved = finance.filter((t) => t.type === "saving").reduce((s, t) => s + Number(t.amount || 0), 0);
    // 理财净投入 = Σ买入金额 - Σ卖出金额（可能为负；不拉行情，成就判定够用）
    let netInvest = 0;
    stocks.forEach((t) => {
      const shares = Number(t.shares || 0);
      const price = Number(t.action ? t.price : t.cost || 0);
      netInvest += (t.action === "sell" ? -1 : 1) * shares * price;
    });

    const habitDates = new Set();
    let checkinTotal = 0;
    let habitBest = 0;
    habits.forEach((h) => {
      const ds = Object.keys(h.checkins || {}).filter((k) => h.checkins[k]).sort();
      checkinTotal += ds.length;
      ds.forEach((x) => habitDates.add(x));
      habitBest = Math.max(habitBest, bestStreak(ds));
    });

    return {
      fin_count: finance.length,
      fin_streak: finStreak,
      task_done: tasks.filter((t) => t.done).length,
      note_count: notes.length,
      habit_streak: habitBest,
      habit_total: checkinTotal,
      health_count: health.length,
      trade_count: stocks.length,
      media_done: media.filter((m) => m.status === "done").length,
      tl_count: timeline.length,
      save_total: saved,
      networth: saved + Math.max(0, netInvest),
      bookmark_count: (d.bookmarks || []).length,
    };
  }

  /** 规则定义：value 取 valuesOf 的 key；target 默认目标（可被 settings.achRules 覆盖） */
  const RULES = [
    { id: "fin_first", g: "记账", icon: "💰", name: "第一笔账", desc: "记下第一笔收支", v: "fin_count", target: 1 },
    { id: "fin_100", g: "记账", icon: "💵", name: "百笔流水", desc: "累计记账 100 笔", v: "fin_count", target: 100 },
    { id: "fin_500", g: "记账", icon: "💳", name: "五百笔流水", desc: "累计记账 500 笔", v: "fin_count", target: 500 },
    { id: "fin_1000", g: "记账", icon: "🏆", name: "千笔流水", desc: "累计记账 1000 笔", v: "fin_count", target: 1000 },
    { id: "fin_s7", g: "记账", icon: "🔥", name: "七日不断", desc: "连续记账 7 天（历史最长）", v: "fin_streak", target: 7 },
    { id: "fin_s30", g: "记账", icon: "🔥", name: "月度坚持", desc: "连续记账 30 天", v: "fin_streak", target: 30 },
    { id: "fin_s100", g: "记账", icon: "🌋", name: "百日不辍", desc: "连续记账 100 天", v: "fin_streak", target: 100 },
    { id: "task_10", g: "任务", icon: "✅", name: "初露锋芒", desc: "完成任务 10 个", v: "task_done", target: 10 },
    { id: "task_50", g: "任务", icon: "🎯", name: "稳步推进", desc: "完成任务 50 个", v: "task_done", target: 50 },
    { id: "task_100", g: "任务", icon: "🏅", name: "百事可乐", desc: "完成任务 100 个", v: "task_done", target: 100 },
    { id: "task_500", g: "任务", icon: "👑", name: "五百单将军", desc: "完成任务 500 个", v: "task_done", target: 500 },
    { id: "note_first", g: "笔记", icon: "📖", name: "第一篇笔记", desc: "写下第一篇笔记", v: "note_count", target: 1 },
    { id: "note_10", g: "笔记", icon: "📚", name: "小有积累", desc: "累计 10 篇笔记", v: "note_count", target: 10 },
    { id: "note_100", g: "笔记", icon: "🏛️", name: "百篇沉淀", desc: "累计 100 篇笔记", v: "note_count", target: 100 },
    { id: "habit_s7", g: "习惯", icon: "🌱", name: "一周萌芽", desc: "任一习惯连续打卡 7 天", v: "habit_streak", target: 7 },
    { id: "habit_s30", g: "习惯", icon: "🌿", name: "习惯成自然", desc: "连续打卡 30 天", v: "habit_streak", target: 30 },
    { id: "habit_s100", g: "习惯", icon: "🌳", name: "百日树人", desc: "连续打卡 100 天", v: "habit_streak", target: 100 },
    { id: "habit_t100", g: "习惯", icon: "🔁", name: "百次打卡", desc: "累计打卡 100 次", v: "habit_total", target: 100 },
    { id: "health_30", g: "健康", icon: "🩺", name: "健康记录员", desc: "记录 30 条健康数据", v: "health_count", target: 30 },
    { id: "health_100", g: "健康", icon: "💪", name: "身体自知", desc: "记录 100 条健康数据", v: "health_count", target: 100 },
    { id: "trade_first", g: "理财", icon: "📈", name: "第一笔交易", desc: "记录第一笔股票/基金交易", v: "trade_count", target: 1 },
    { id: "trade_50", g: "理财", icon: "📊", name: "交易老手", desc: "累计 50 笔交易", v: "trade_count", target: 50 },
    { id: "nw_10w", g: "理财", icon: "💎", name: "十万俱乐部", desc: "净资产（储蓄+净投入）≥ 10 万", v: "networth", target: 100000 },
    { id: "nw_50w", g: "理财", icon: "🏦", name: "五十万里程碑", desc: "净资产 ≥ 50 万", v: "networth", target: 500000 },
    { id: "media_10", g: "书影音", icon: "🎬", name: "观阅十部", desc: "看完/读完 10 部作品", v: "media_done", target: 10 },
    { id: "media_50", g: "书影音", icon: "🎟️", name: "半百观阅", desc: "看完/读完 50 部作品", v: "media_done", target: 50 },
    { id: "tl_first", g: "时间轴", icon: "⭐", name: "人生第一页", desc: "记录第 1 个人生事件", v: "tl_count", target: 1 },
    { id: "tl_10", g: "时间轴", icon: "📜", name: "十年一刻", desc: "累计记录 10 个人生事件", v: "tl_count", target: 10 },
  ];

  /** 拉全量数据快照（成就计算用；各 store 数据量个人级，开销可忽略） */
  async function fetchData() {
    const [finance, tasks, notes, habits, health, stocks, media, timeline, bookmarks] = await Promise.all(
      ["finance", "tasks", "notes", "habits", "health", "stocks", "media", "timeline", "bookmarks"].map((s) =>
        repo(s).list().catch(() => [])
      )
    );
    return { finance, tasks, notes, habits, health, stocks, media, timeline, bookmarks };
  }

  /**
   * 计算全部成就状态。
   * @param data fetchData 的快照  @param unlocked settings.achUnlocked  @param rulesCfg settings.achRules
   * @returns [{id,g,icon,name,desc,value,target,done,off,unlockedAt,progress}]
   */
  function computeAll(data, unlocked, rulesCfg) {
    const vals = valuesOf(data);
    unlocked = unlocked || {};
    rulesCfg = rulesCfg || {};
    return RULES.map((r) => {
      const cfg = rulesCfg[r.id] || {};
      const target = Math.max(1, Number(cfg.target) || r.target);
      const off = !!cfg.off;
      const value = Math.min(vals[r.v] || 0, target);
      const done = !off && (vals[r.v] || 0) >= target;
      return {
        ...r,
        target,
        off,
        value,
        done,
        unlockedAt: unlocked[r.id] || "",
        progress: Math.min(1, value / target),
      };
    });
  }

  /** 检查新解锁并持久化（返回新解锁列表）。silent=true 不弹 toast（页面刷新时用） */
  async function checkNew(silent) {
    try {
      const st = await getSettings({ achUnlocked: {}, achRules: {} });
      if (st.achRules && st.achRules._off_all) return [];
      const data = await fetchData();
      const all = computeAll(data, st.achUnlocked, st.achRules);
      const fresh = all.filter((a) => a.done && !a.unlockedAt);
      if (!fresh.length) return [];
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      fresh.forEach((a) => { st.achUnlocked[a.id] = ts; });
      await setSetting("achUnlocked", st.achUnlocked);
      if (!silent) fresh.slice(0, 3).forEach((a, i) => {
        setTimeout(() => showToast(`🎉 解锁成就「${a.name}」`, "ok"), 600 * (i + 1));
      });
      return fresh;
    } catch (e) {
      return [];
    }
  }

  // ---------- 页面 ----------
  routes.achievements = {
    title: "成就",
    async render(el) {
      const st = await getSettings({ achUnlocked: {}, achRules: {} });
      if (location.hash !== "#/achievements") return;
      const data = await fetchData();
      if (location.hash !== "#/achievements") return;
      const all = computeAll(data, st.achUnlocked, st.achRules);
      const active = all.filter((a) => !a.off);
      const doneList = active.filter((a) => a.done).sort((a, b) => (b.unlockedAt || "").localeCompare(a.unlockedAt || ""));
      const recent = doneList.slice(0, 3);

      const rowHtml = (a) => `
        <div class="ach-row ${a.off ? "off" : ""} ${a.done ? "done" : ""}">
          <span class="ach-ic">${a.icon}</span>
          <div class="ach-main">
            <div class="ach-name">${esc(a.name)}<span class="ach-unlock">${a.unlockedAt ? "🎉 " + esc(a.unlockedAt) : a.off ? "已停用" : ""}</span></div>
            <div class="ach-desc">${esc(a.desc)} · 当前 ${Number(a.value).toLocaleString("zh-CN")} / ${Number(a.target).toLocaleString("zh-CN")}</div>
            <div class="ach-bar"><i style="width:${Math.round(a.progress * 100)}%"></i></div>
          </div>
          <div class="ach-ops">
            <button class="btn ghost sm" data-achtgt="${a.id}">改目标</button>
            <button class="btn ghost sm" data-achoff="${a.id}">${a.off ? "启用" : "停用"}</button>
          </div>
        </div>`;

      // 分组渲染全部规则（含已停用的——灰显并给「启用」入口）；统计口径只算启用中的
      const groups = {};
      all.forEach((a) => { (groups[a.g] = groups[a.g] || []).push(a); });

      el.innerHTML = `
        <div class="card">
          <h2>成就殿堂<span class="count">已解锁 ${doneList.length} / ${active.length}</span></h2>
          ${recent.length ? `<div class="ach-recent">${recent.map((a) => `<span class="ach-chip">${a.icon} ${esc(a.name)}</span>`).join("")}</div>` : ""}
          <div class="s-desc" style="margin-top:6px">成就由现有数据自动计算：记账、任务、笔记、习惯、健康、理财、书影音、时间轴。解锁时间在每天首次打开时记录。</div>
        </div>
        ${Object.keys(groups).map((g) => `
          <div class="card">
            <h2>${esc(g)}<span class="count">${groups[g].filter((a) => a.done).length} / ${groups[g].length}</span></h2>
            ${groups[g].map(rowHtml).join("")}
          </div>`).join("")}
        <div class="footnote">「改目标」可自定义达成条件（比如把"千笔流水"改成 2000 笔）；停用的规则不再参与计算与展示。</div>`;

      el.querySelectorAll("[data-achtgt]").forEach((b) =>
        b.addEventListener("click", async () => {
          const id = b.dataset.achtgt;
          const rule = all.find((x) => x.id === id);
          const input = prompt(`「${rule.name}」目标值（当前 ${rule.target}，实际 ${rule.value}）：`, rule.target);
          if (input === null) return;
          const n = Number(input);
          if (!n || n < 1) return showToast("请输入正整数", "error");
          const cfg = { ...((await getSetting("achRules", {})) || {}) };
          cfg[id] = { ...(cfg[id] || {}), target: Math.round(n) };
          await setSetting("achRules", cfg);
          showToast("目标已更新", "ok");
          routes.achievements.render(el);
        })
      );
      el.querySelectorAll("[data-achoff]").forEach((b) =>
        b.addEventListener("click", async () => {
          const id = b.dataset.achoff;
          const cfg = { ...((await getSetting("achRules", {})) || {}) };
          cfg[id] = { ...(cfg[id] || {}) };
          cfg[id].off = !cfg[id].off;
          await setSetting("achRules", cfg);
          routes.achievements.render(el);
        })
      );

      // 打开页面时静默补记新解锁（不弹 toast，页面本身会展示）
      checkNew(true);
    },
  };

  window.WB.achievements = { computeAll, checkNew, RULES };
})();
