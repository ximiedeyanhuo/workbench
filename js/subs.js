/* subs.js — 订阅中心（P1）：ChatGPT/网盘/会员……长期订阅的集中管理
 * - subscriptions：{id,name,icon,amount,currency,cycle,day,autoRenew,active,note,startedAt,createdAt,updatedAt}
 *   cycle: weekly|monthly|quarterly|yearly；day: 每周期扣费日（月度=几号）
 * - 测算：本月扣费 / 未来30天 / 未来12个月（周期归一到月）
 * - 联动：仪表盘 7 天内到期横幅（app.js 渲染）；数据随全量导出/云备份
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, uid, esc, todayStr, flashInvalid, showToast } = window.WB;

  const sRepo = () => repo("subscriptions");
  const CYCLES = { weekly: "每周", monthly: "每月", quarterly: "每季", yearly: "每年" };
  const CYCLE_MONTHS = { weekly: 1 / 4.345, monthly: 1, quarterly: 3, yearly: 12 };
  const pad2 = (n) => String(n).padStart(2, "0");

  /** 下次扣费日期（从今天往后找最近一次扣费日；月/季/年按 day 号对齐，已过则顺延下一周期） */
  function nextCharge(s, today) {
    const t = new Date(today + "T00:00:00");
    if (s.cycle === "weekly") {
      const start = s.startedAt ? new Date(s.startedAt + "T00:00:00") : t;
      const dow = start.getDate(); // 简化：用 startedAt 的星期几
      for (let i = 0; i < 8; i++) {
        const d = new Date(t.getTime() + i * 86400000);
        if (d.getDay() === start.getDay()) return window.WB.dateStr(d);
      }
      return today;
    }
    const day = Math.min(28, Math.max(1, Number(s.day) || 1));
    const step = s.cycle === "monthly" ? 1 : s.cycle === "quarterly" ? 3 : 12;
    // 找今年/去年的锚点月（startedAt 所在月），从锚点按 step 推进到 ≥ 今天
    const anchor = s.startedAt ? new Date(s.startedAt + "T00:00:00") : new Date(t.getFullYear(), 0, 1);
    let y = anchor.getFullYear(), m = anchor.getMonth();
    for (let i = 0; i < 600; i++) {
      const dim = new Date(y, m + 1, 0).getDate();
      const dd = Math.min(day, dim);
      const cand = window.WB.dateStr(new Date(y, m, dd));
      if (cand >= today) return cand;
      m += step;
      if (m > 11) { m -= 12; y++; }
    }
    return today;
  }
  function daysUntil(ds, today) {
    return Math.round((new Date(ds + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
  }
  function money(s) {
    return (s.currency === "USD" ? "$" : "¥") + Number(s.amount || 0).toFixed(2).replace(/\.00$/, "");
  }

  let editingId = null;

  function formHtml(s) {
    const it = s || {};
    return `
      <div class="row">
        <input id="subIcon" value="${esc(it.icon || "🔁")}" maxlength="4" style="max-width:64px" title="图标" />
        <input class="grow" id="subName" placeholder="名称（如：ChatGPT Plus / 网盘会员）" maxlength="24" value="${esc(it.name || "")}" />
        <select id="subCur">
          <option value="CNY" ${(it.currency || "CNY") === "CNY" ? "selected" : ""}>¥ 人民币</option>
          <option value="USD" ${it.currency === "USD" ? "selected" : ""}>$ 美元</option>
        </select>
        <input id="subAmount" type="number" min="0" step="0.01" placeholder="金额" style="max-width:110px" value="${it.amount !== undefined ? esc(it.amount) : ""}" />
        <select id="subCycle">${Object.keys(CYCLES).map((k) => `<option value="${k}" ${it.cycle === k ? "selected" : ""}>${CYCLES[k]}</option>`).join("")}</select>
        <input id="subDay" type="number" min="1" max="28" placeholder="几号" style="max-width:80px" title="扣费日（周订阅忽略）" value="${it.day !== undefined ? esc(it.day) : ""}" />
      </div>
      <div class="row sp-t-sm">
        <input type="date" id="subStart" title="订阅起始日（推算扣费周期用）" style="max-width:160px" value="${esc(it.startedAt || "")}" />
        <input class="grow" id="subNote" placeholder="备注（可选）" maxlength="60" value="${esc(it.note || "")}" />
        <label class="an-yearly"><input type="checkbox" id="subAuto" ${it.autoRenew !== false ? "checked" : ""} /> 自动续费</label>
        <button class="btn in-card-btn" id="subSave">${it.id ? "保存" : "添加订阅"}</button>
        ${it.id ? '<button class="btn ghost" id="subCancel">取消</button>' : ""}
      </div>`;
  }

  routes.subs = {
    title: "订阅",
    async render(el) {
      const today = todayStr();
      const items = (await sRepo().list().catch(() => [])) || [];
      if (location.hash !== "#/subs") return;
      const list = items.slice().sort((a, b) => nextCharge(a, today).localeCompare(nextCharge(b, today)));
      const editing = editingId ? list.find((s) => s.id === editingId) : null;
      const actives = list.filter((s) => s.active !== false);

      // 测算
      const monthNorm = (s) => Number(s.amount || 0) / (CYCLE_MONTHS[s.cycle] || 1);
      const monthTotal = actives.reduce((sum, s) => sum + monthNorm(s), 0);
      const in30 = actives.filter((s) => daysUntil(nextCharge(s, today), today) <= 30);
      const in30Total = in30.reduce((sum, s) => sum + Number(s.amount || 0), 0);
      const yearTotal = monthTotal * 12;
      const thisMonth = actives.filter((s) => nextCharge(s, today).slice(0, 7) === today.slice(0, 7));

      el.innerHTML = `
        <div class="card">
          <h2>${editing ? "编辑订阅" : "添加订阅"}<span class="count">长期支出心里有数</span></h2>
          ${formHtml(editing)}
        </div>
        <div class="card">
          <h2>订阅总览<span class="count">${actives.length} 个生效</span></h2>
          <div class="stat-grid">
            <div class="stat"><div class="s-lab">折合每月</div><div class="s-val">¥${monthTotal.toFixed(0)}</div><div class="s-sub">${thisMonth.length} 个本月扣费</div></div>
            <div class="stat"><div class="s-lab">未来 30 天</div><div class="s-val">¥${in30Total.toFixed(0)}</div><div class="s-sub">${in30.length} 笔待扣</div></div>
            <div class="stat"><div class="s-lab">未来 12 个月</div><div class="s-val">¥${yearTotal.toFixed(0)}</div><div class="s-sub">按周期折算</div></div>
          </div>
        </div>
        <div class="card">
          <h2>我的订阅<span class="count">按下次扣费排序</span></h2>
          ${list.length ? list.map((s) => {
            const nc = nextCharge(s, today);
            const dd = daysUntil(nc, today);
            const inactive = s.active === false;
            return `<div class="set-row ${inactive ? "off" : ""}">
              <span style="font-size:18px">${esc(s.icon || "🔁")}</span>
              <span class="s-name">${esc(s.name)}<small style="display:block;color:var(--muted)">${CYCLES[s.cycle] || ""} · ${money(s)}${s.autoRenew !== false ? " · 自动续费" : ""}${s.note ? " · " + esc(s.note) : ""}</small></span>
              <span class="s-desc">${inactive ? "已停用" : `下次扣费 <b>${esc(nc)}</b>（${dd === 0 ? "今天" : dd + " 天后"}）`}</span>
              <button class="btn ghost sm" data-subedit="${s.id}">改</button>
              <button class="btn ghost sm" data-subtoggle="${s.id}">${inactive ? "启用" : "停用"}</button>
              <button class="btn danger sm" data-subdel="${s.id}">删</button>
            </div>`;
          }).join("") : '<div class="empty">还没有订阅记录。ChatGPT、网盘会员、视频会员……加进来算算一年花多少</div>'}
        </div>
        <div class="footnote">扣费日按周期从「订阅起始日」推算；金额折算：每周 ×4.35、每季 ÷3、每年 ÷12。7 天内将扣费的订阅会在首页出横幅提醒。</div>`;

      const $$ = (s2) => el.querySelector(s2);
      $$("#subSave").addEventListener("click", async () => {
        const nameInput = $$("#subName");
        const name = nameInput.value.trim();
        const amount = Number($$("#subAmount").value);
        if (!name) return flashInvalid(nameInput);
        if (!(amount > 0)) return flashInvalid($$("#subAmount"));
        const base = editingId ? list.find((x) => x.id === editingId) : null;
        await sRepo().put({
          id: base ? base.id : uid(),
          name,
          icon: $$("#subIcon").value.trim() || "🔁",
          amount,
          currency: $$("#subCur").value,
          cycle: $$("#subCycle").value,
          day: Number($$("#subDay").value) || 1,
          autoRenew: $$("#subAuto").checked,
          note: $$("#subNote").value.trim(),
          startedAt: $$("#subStart").value || todayStr(),
          active: base ? base.active !== false : true,
          createdAt: (base && base.createdAt) || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        showToast(editingId ? "已保存" : "已添加", "ok");
        editingId = null;
        routes.subs.render(el);
      });
      const subCancel = $$("#subCancel");
      if (subCancel) subCancel.addEventListener("click", () => { editingId = null; routes.subs.render(el); });

      el.querySelectorAll("[data-subedit]").forEach((b) =>
        b.addEventListener("click", () => { editingId = b.dataset.subedit; routes.subs.render(el); window.scrollTo({ top: 0, behavior: "smooth" }); })
      );
      el.querySelectorAll("[data-subtoggle]").forEach((b) =>
        b.addEventListener("click", async () => {
          const s = list.find((x) => x.id === b.dataset.subtoggle);
          if (!s) return;
          await sRepo().put({ ...s, active: s.active === false, updatedAt: new Date().toISOString() });
          routes.subs.render(el);
        })
      );
      el.querySelectorAll("[data-subdel]").forEach((b) =>
        b.addEventListener("click", async () => {
          const s = list.find((x) => x.id === b.dataset.subdel);
          if (!confirm(`删除订阅「${s ? s.name : ""}」？`)) return;
          await sRepo().delete(b.dataset.subdel);
          showToast("已删除", "info");
          routes.subs.render(el);
        })
      );
    },
  };

  /** 仪表盘横幅数据：未来 7 天内将扣费的生效订阅 */
  function upcoming(list, today) {
    return (list || [])
      .filter((s) => s.active !== false)
      .map((s) => ({ s, date: nextCharge(s, today), days: daysUntil(nextCharge(s, today), today) }))
      .filter((x) => x.days >= 0 && x.days <= 7)
      .sort((a, b) => a.days - b.days);
  }

  window.WB.subs = { upcoming, nextCharge };
})();
