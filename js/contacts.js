/* contacts.js — 联系人 / 家庭关系（P1 极简版）
 * - contacts：{id,name,nick,relation,phone,email,birthday,address,tags,note,createdAt,updatedAt}
 *   birthday 存 "MM-DD" 或 "YYYY-MM-DD"；relation: family/relative/friend/colleague/other
 * - contactlogs：{id,cid,date,type,note,createdAt} —— 互动记录（微信/电话/见面…）
 * - 生日临近：未来 30 天有生日的联系人置顶提示；可一键「同步到倒数日」（confirm 后写 anniv，复用提醒体系）
 * - 刻意不做企业 CRM：无公司/商机/阶段，只有"这是谁、怎么联系、最近聊了什么"
 */
(function () {
  if (!window.WB) return;
  const { routes, repo, uid, esc, todayStr, flashInvalid, showToast, parseTags } = window.WB;

  const cRepo = () => repo("contacts");
  const lRepo = () => repo("contactlogs");

  const RELATIONS = { family: { name: "家人", emoji: "🏠" }, relative: { name: "亲戚", emoji: "🧧" }, friend: { name: "朋友", emoji: "🤝" }, colleague: { name: "同事", emoji: "💼" }, other: { name: "其他", emoji: "👤" } };
  const INTYPES = { chat: "微信/聊天", call: "电话", meet: "见面", meal: "一起吃饭", gift: "送礼/收礼", other: "其它" };

  const pad2 = (n) => String(n).padStart(2, "0");
  /** 生日（MM-DD）距今天数：今年已过则算明年；无生日返回 null */
  function birthdayIn(birthday, today) {
    const md = (birthday || "").slice(-5); // 兼容 YYYY-MM-DD / MM-DD
    if (!/^\d{2}-\d{2}$/.test(md)) return null;
    const y = today.slice(0, 4);
    let d = y + "-" + md;
    if (d < today) d = (Number(y) + 1) + "-" + md;
    return Math.round((new Date(d + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
  }

  let editingId = null;
  let logOpenId = null;
  let filterRel = "";

  function formHtml(c) {
    const it = c || {};
    return `
      <div class="row">
        <input class="grow" id="ctName" placeholder="姓名（必填）" maxlength="20" value="${esc(it.name || "")}" />
        <input id="ctNick" placeholder="昵称（可选）" maxlength="20" style="max-width:140px" value="${esc(it.nick || "")}" />
        <select id="ctRel">
          ${Object.keys(RELATIONS).map((k) => `<option value="${k}" ${it.relation === k ? "selected" : ""}>${RELATIONS[k].emoji} ${RELATIONS[k].name}</option>`).join("")}
        </select>
      </div>
      <div class="row sp-t-sm">
        <input id="ctPhone" placeholder="手机（可选）" maxlength="20" style="max-width:150px" value="${esc(it.phone || "")}" />
        <input type="date" id="ctBirth" title="生日（可只选月日）" style="max-width:160px" value="${esc(it.birthday || "")}" />
        <input class="grow" id="ctAddr" placeholder="城市/地址（可选）" maxlength="40" value="${esc(it.addr || it.address || "")}" />
      </div>
      <div class="row sp-t-sm">
        <input class="grow" id="ctNote" placeholder="备注（TA 是谁、有什么要注意的…）" maxlength="80" value="${esc(it.note || "")}" />
        <input id="ctTags" placeholder="标签（逗号分隔）" maxlength="40" style="max-width:170px" value="${esc((it.tags || []).join(","))}" />
        <button class="btn in-card-btn" id="ctSave">${it.id ? "保存" : "添加联系人"}</button>
        ${it.id ? '<button class="btn ghost" id="ctCancel">取消</button>' : ""}
      </div>`;
  }

  function rowHtml(c, logs, today) {
    const rel = RELATIONS[c.relation] || RELATIONS.other;
    const bdIn = birthdayIn(c.birthday, today);
    const myLogs = logs.filter((l) => l.cid === c.id).sort((a, b) => b.date.localeCompare(a.date));
    const lastLog = myLogs[0];
    const open = logOpenId === c.id;
    return `
      <div class="ct-row">
        <div class="ct-main-row">
          <span class="ct-rel" title="${rel.name}">${rel.emoji}</span>
          <span class="ct-name">${esc(c.name)}${c.nick ? `<small>${esc(c.nick)}</small>` : ""}</span>
          <span class="ct-info">${esc(c.phone || "")}${c.birthday ? ` · 🎂 ${esc(c.birthday.slice(-5))}` : ""}${c.address ? " · " + esc(c.address) : ""}</span>
          ${bdIn !== null && bdIn <= 30 ? `<span class="badge ${bdIn <= 7 ? "b-danger" : "b-warn"}">生日${bdIn === 0 ? "就是今天" : "还有 " + bdIn + " 天"}</span>` : ""}
          <span class="s-desc">${lastLog ? "上次：" + esc(lastLog.date.slice(5)) + " " + esc(INTYPES[lastLog.type] || "互动") : "还没记录过互动"}</span>
          <div class="ct-ops">
            <button class="btn ghost sm" data-ctlog="${c.id}">${open ? "收起" : "互动"}</button>
            <button class="btn ghost sm" data-ctedit="${c.id}">编辑</button>
            ${c.birthday ? `<button class="btn ghost sm" data-ctanniv="${c.id}" title="把生日同步到倒数日（每年提醒）">🎂</button>` : ""}
            <button class="btn danger sm" data-ctdel="${c.id}">删</button>
          </div>
        </div>
        ${open ? `
        <div class="ct-log-box">
          <div class="row sp-b-sm">
            <input type="date" id="clDate_${c.id}" value="${today}" style="max-width:150px" />
            <select id="clType_${c.id}">${Object.keys(INTYPES).map((k) => `<option value="${k}">${INTYPES[k]}</option>`).join("")}</select>
            <input class="grow" id="clNote_${c.id}" placeholder="聊了/做了什么（可选）" maxlength="60" />
            <button class="btn sm" data-ctlogadd="${c.id}">记一笔</button>
          </div>
          ${myLogs.length ? myLogs.slice(0, 10).map((l) => `
            <div class="set-row">
              <span class="s-name" style="min-width:86px">${esc(l.date)}</span>
              <span class="s-desc grow">${esc(INTYPES[l.type] || "互动")}${l.note ? " · " + esc(l.note) : ""}</span>
              <button class="btn danger sm" data-ctlogdel="${l.id}">删</button>
            </div>`).join("") : '<div class="empty">还没有互动记录</div>'}
        </div>` : ""}
      </div>`;
  }

  routes.contacts = {
    title: "联系人",
    async render(el) {
      const today = todayStr();
      const [contacts, logs] = await Promise.all([cRepo().list().catch(() => []), lRepo().list().catch(() => [])]);
      if (location.hash !== "#/contacts") return;
      const list = (contacts || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-CN"));
      const shown = filterRel ? list.filter((c) => (c.relation || "other") === filterRel) : list;
      const editing = editingId ? list.find((c) => c.id === editingId) : null;

      // 生日临近（未来 30 天）
      const upcoming = list
        .map((c) => ({ c, in: birthdayIn(c.birthday, today) }))
        .filter((x) => x.in !== null && x.in <= 30)
        .sort((a, b) => a.in - b.in);

      el.innerHTML = `
        <div class="card">
          <h2>${editing ? "编辑联系人" : "添加联系人"}<span class="count">极简关系册</span></h2>
          ${formHtml(editing)}
        </div>
        ${upcoming.length ? `
        <div class="card">
          <h2>🎂 生日临近<span class="count">未来 30 天</span></h2>
          ${upcoming.map((x) => `
            <div class="set-row">
              <span class="s-name">${esc(x.c.name)}</span>
              <span class="s-desc">${esc(x.c.birthday.slice(-5))} · ${x.in === 0 ? "就是今天！" : "还有 " + x.in + " 天"}</span>
              ${x.c.phone ? `<a class="c-accent" href="tel:${esc(x.c.phone)}" style="font-size:13px">📞 拨打电话</a>` : ""}
            </div>`).join("")}
        </div>` : ""}
        <div class="card">
          <h2>联系人<span class="count">${list.length} 位</span></h2>
          <div class="row sp-b-md">
            <select id="ctFilter">
              <option value="">全部分类</option>
              ${Object.keys(RELATIONS).map((k) => `<option value="${k}" ${filterRel === k ? "selected" : ""}>${RELATIONS[k].emoji} ${RELATIONS[k].name}</option>`).join("")}
            </select>
          </div>
          ${shown.length ? shown.map((c) => rowHtml(c, logs || [], today)).join("") : `<div class="empty">${filterRel ? "该分类下还没有联系人" : "还没有联系人。家人朋友的生日、电话、最近一次聊天……记在这里就够了"}</div>`}
        </div>
        <div class="footnote">点「互动」展开记录：微信聊天、打电话、一起吃饭……数据随导出/云备份走；点 🎂 可把生日同步到倒数日每年提醒。</div>`;

      const $$ = (s) => el.querySelector(s);
      $$("#ctSave").addEventListener("click", async () => {
        const nameInput = $$("#ctName");
        const name = nameInput.value.trim();
        if (!name) return flashInvalid(nameInput);
        const base = editingId ? list.find((x) => x.id === editingId) : null;
        await cRepo().put({
          id: base ? base.id : uid(),
          name,
          nick: $$("#ctNick").value.trim(),
          relation: $$("#ctRel").value,
          phone: $$("#ctPhone").value.trim(),
          birthday: $$("#ctBirth").value || "",
          address: $$("#ctAddr").value.trim(),
          note: $$("#ctNote").value.trim(),
          tags: parseTags($$("#ctTags").value),
          createdAt: (base && base.createdAt) || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        showToast(editingId ? "已保存" : "已添加", "ok");
        editingId = null;
        routes.contacts.render(el);
      });
      const cancelBtn = $$("#ctCancel");
      if (cancelBtn) cancelBtn.addEventListener("click", () => { editingId = null; routes.contacts.render(el); });

      $$("#ctFilter").addEventListener("change", (e) => { filterRel = e.target.value; routes.contacts.render(el); });

      el.querySelectorAll("[data-ctedit]").forEach((b) =>
        b.addEventListener("click", () => { editingId = b.dataset.ctedit; routes.contacts.render(el); window.scrollTo({ top: 0, behavior: "smooth" }); })
      );
      el.querySelectorAll("[data-ctdel]").forEach((b) =>
        b.addEventListener("click", async () => {
          const c = list.find((x) => x.id === b.dataset.ctdel);
          if (!confirm(`删除联系人「${c ? c.name : ""}」及其互动记录？`)) return;
          await cRepo().delete(b.dataset.ctdel);
          for (const l of (logs || []).filter((x) => x.cid === b.dataset.ctdel)) await lRepo().delete(l.id);
          showToast("已删除", "info");
          routes.contacts.render(el);
        })
      );
      el.querySelectorAll("[data-ctlog]").forEach((b) =>
        b.addEventListener("click", () => { logOpenId = logOpenId === b.dataset.ctlog ? null : b.dataset.ctlog; routes.contacts.render(el); })
      );
      el.querySelectorAll("[data-ctlogadd]").forEach((b) =>
        b.addEventListener("click", async () => {
          const cid = b.dataset.ctlogadd;
          const date = $$("#clDate_" + cid).value;
          if (!date) return flashInvalid($$("#clDate_" + cid));
          await lRepo().put({ id: uid(), cid, date, type: $$("#clType_" + cid).value, note: $$("#clNote_" + cid).value.trim(), createdAt: new Date().toISOString() });
          showToast("已记录互动", "ok");
          routes.contacts.render(el);
        })
      );
      el.querySelectorAll("[data-ctlogdel]").forEach((b) =>
        b.addEventListener("click", async () => {
          await lRepo().delete(b.dataset.ctlogdel);
          routes.contacts.render(el);
        })
      );
      // 生日 → 倒数日（用户确认后写入）
      el.querySelectorAll("[data-ctanniv]").forEach((b) =>
        b.addEventListener("click", async () => {
          const c = list.find((x) => x.id === b.dataset.ctanniv);
          if (!c || !c.birthday) return;
          if (!confirm(`把「${c.name}」的生日（${c.birthday.slice(-5)}）加入倒数日，每年提醒？`)) return;
          await repo("anniv").put({
            id: "ctb_" + c.id,
            title: "🎂 " + c.name + " 生日",
            date: c.birthday.length === 10 ? c.birthday : "2000-" + c.birthday,
            category: "birthday",
            yearly: true,
            createdAt: new Date().toISOString(),
          });
          showToast("已加入倒数日", "ok");
        })
      );
    },
  };

  window.WB.contacts = { birthdayIn };
})();
