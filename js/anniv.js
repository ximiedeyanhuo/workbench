/* anniv.js — 倒数日 · 纪念日
 * 生日 / 纪念日 / 考试日 / 发薪日 等倒计时。
 * - 存 anniv store（独立库 workbench_anniv）
 * - yearly=true（每年循环，默认）：计算"距离今天最近的下一次"；
 *   yearly=false（单次）：计算到目标日期的绝对差值（可负=已过）
 * - 仪表盘展示最近一个未结束的倒计时横幅 + 纪念日清单
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, uid, esc, icon, todayStr, dateStr, flashInvalid, showToast } = window.WB;

  const aRepo = () => repo("anniv");

  const CAT_EMOJI = { birthday: "🎂", wedding: "💍", exam: "🎯", payday: "💰", trip: "✈️", other: "📌" };
  const CAT_NAMES = { birthday: "生日", wedding: "纪念日", exam: "考试", payday: "发薪日", trip: "出行", other: "其它" };

  /** 计算"下一次"该日期（距今天的天数） */
  function daysUntil(a, today) {
    const [y, m, d] = (a.date || "2000-01-01").split("-").map(Number);
    const todayD = new Date(today + "T00:00:00");
    if (a.yearly === false) {
      // 单次事件：到目标日的天数，可为负
      return Math.round((new Date(a.date + "T00:00:00") - todayD) / 86400000);
    }
    // 每年循环：取最近一个"未过去的今天起点"（今天也算 0）
    for (let off = 0; off < 370; off++) {
      const dt = new Date(todayD.getTime() + off * 86400000);
      if (dt.getMonth() + 1 === m && dt.getDate() === d) return off;
    }
    return 999;
  }

  /** 目标日期是哪一年（用于展示年份） */
  function targetYearLabel(a, today) {
    const diff = daysUntil(a, today);
    const base = new Date(today + "T00:00:00");
    const dt = new Date(base.getTime() + Math.max(0, diff) * 86400000);
    return dt.getFullYear();
  }

  function fmtDiff(diff) {
    if (diff === 0) return "就是今天";
    if (diff > 0) return `还有 <b>${diff}</b> 天`;
    return `已过 <b>${-diff}</b> 天`;
  }

  function renderCard(a, today) {
    const diff = daysUntil(a, today);
    const emoji = CAT_EMOJI[a.category] || "📌";
    const urgent = diff >= 0 && diff <= 7;
    const done = a.yearly === false && diff < 0;
    return `
      <div class="anniv-card ${urgent ? "urgent" : ""} ${done ? "done" : ""}">
        <div class="anniv-emoji">${emoji}</div>
        <div class="anniv-body">
          <div class="anniv-name">${esc(a.title)}<small>${esc(CAT_NAMES[a.category] || a.category)} · ${esc(a.yearly === false ? "单次" : "每年")}</small></div>
          <div class="anniv-date">${esc(a.date)}${a.yearly === false ? "" : " · " + targetYearLabel(a, today) + " 年"}</div>
          <div class="anniv-diff ${urgent ? "urgent" : done ? "muted" : ""}">${fmtDiff(diff)}</div>
        </div>
        <button class="icon-btn plain" data-adel="${a.id}" title="删除">${icon("trash")}</button>
      </div>`;
  }

  routes.anniv = {
    title: "倒数日",
    async render(el) {
      const today = todayStr();
      const items = (await aRepo().list().catch(() => [])) || [];

      el.innerHTML = `
        <div class="card">
          <h2>添加倒数日 / 纪念日</h2>
          <div class="row">
            <input class="grow" id="anTitle" placeholder="名称（如：妈妈生日 / 发薪日 / 考试）" maxlength="30" />
            <input type="date" id="anDate" title="日期" />
            <select id="anCat">
              ${Object.keys(CAT_NAMES).map((k) => `<option value="${k}">${CAT_EMOJI[k]} ${CAT_NAMES[k]}</option>`).join("")}
            </select>
            <label class="an-yearly"><input type="checkbox" id="anYearly" checked /> 每年循环</label>
            <button class="btn in-card-btn" id="anAdd">添加</button>
          </div>
        </div>
        <div class="card">
          <h2>倒数日<span class="count">${items.length} 项</span></h2>
          ${items.length
            ? `<div class="anniv-grid">${items.map((a) => renderCard(a, today)).join("")}</div>`
            : '<div class="empty">还没有倒数日。生日 / 纪念日 / 考试 / 发薪日，添加一个开始倒计时吧</div>'}
        </div>
        <div class="footnote">勾选「每年循环」则按农历/每年同月同日自动滚动到下一年（如生日、纪念日）；取消勾选为单次事件（如一场考试）。</div>`;

      const addBtn = el.querySelector("#anAdd");
      addBtn.addEventListener("click", async () => {
        const titleInput = el.querySelector("#anTitle");
        const title = titleInput.value.trim();
        const date = el.querySelector("#anDate").value;
        if (!title) return flashInvalid(titleInput);
        if (!date) return flashInvalid(el.querySelector("#anDate"));
        await aRepo().put({
          id: uid(),
          title,
          date,
          category: el.querySelector("#anCat").value,
          yearly: el.querySelector("#anYearly").checked,
          createdAt: new Date().toISOString(),
        });
        showToast("已添加", "ok");
        routes.anniv.render(el);
      });
      // 回车提交
      el.querySelector("#anTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

      el.querySelectorAll("[data-adel]").forEach((b) =>
        b.addEventListener("click", async () => {
          const id = b.dataset.adel;
          const a = items.find((x) => x.id === id);
          if (!confirm(`删除「${a ? a.title : ""}」？`)) return;
          await aRepo().delete(id);
          showToast("已删除", "info");
          routes.anniv.render(el);
        })
      );
    },
  };
})();
