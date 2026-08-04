/**
 * links.js — 快捷入口：常用链接卡片面板（增删 + 上下移排序）
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, safeUrl, flashInvalid } = window.WB;
  const qlRepo = repo("quicklinks");

  const COLORS = ["#FF5A36", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#06B6D4"];

  routes.links = {
    title: "入口",
    async render(el) {
      const links = (await qlRepo.list()).sort((a, b) => (a.sort || 0) - (b.sort || 0));

      const cards = links.length
        ? links
            .map(
              (l, i) => `<div class="ql-card" data-id="${l.id}">
                <div class="ql-ops">
                  ${i > 0 ? `<button class="icon-btn plain" data-act="up" title="上移">${WB.icon("up")}</button>` : ""}
                  ${i < links.length - 1 ? `<button class="icon-btn plain" data-act="down" title="下移">${WB.icon("down")}</button>` : ""}
                  <button class="icon-btn" data-act="del" title="删除">${WB.icon("del")}</button>
                </div>
                <span class="ql-ic" style="background:${esc(l.color || COLORS[0])}">${esc((l.name || "?").slice(0, 1).toUpperCase())}</span>
                <a class="ql-name" href="${safeUrl(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)}</a>
              </div>`
            )
            .join("")
        : '<div class="empty" style="grid-column:1/-1">把常用的系统、工具、文档链接加进来，一键直达</div>';

      el.innerHTML = `
        <div class="card">
          <h2>添加入口</h2>
          <div class="row">
            <input id="qlName" placeholder="名称，如：Gitee / 云效 / 掘金" style="width:200px" maxlength="20" />
            <input class="grow" id="qlUrl" placeholder="https://…" maxlength="500" />
            <select id="qlColor">
              ${COLORS.map((c, i) => `<option value="${c}" ${i === 0 ? "selected" : ""}>颜色 ${i + 1}</option>`).join("")}
            </select>
            <button class="btn" id="qlAdd">添加</button>
          </div>
        </div>
        <div class="card">
          <h2>快捷入口<span class="count">${links.length} 个</span></h2>
          <div class="ql-grid" id="qlGrid">${cards}</div>
        </div>`;

      const rerender = () => routes.links.render(el);

      const addLink = async () => {
        const nameInput = el.querySelector("#qlName");
        const urlInput = el.querySelector("#qlUrl");
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        if (!name) return flashInvalid(nameInput);
        if (!url || !/^https?:\/\//i.test(url)) return flashInvalid(urlInput); // 需 http(s):// 开头
        const maxSort = links.reduce((m, l) => Math.max(m, l.sort || 0), 0);
        await qlRepo.put({ id: uid(), name, url, color: el.querySelector("#qlColor").value, sort: maxSort + 1 });
        rerender();
      };
      el.querySelector("#qlAdd").addEventListener("click", addLink);
      el.querySelector("#qlUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") addLink(); });

      el.querySelector("#qlGrid").addEventListener("click", async (e) => {
        const actEl = e.target.closest("[data-act]");
        if (!actEl) return;
        const id = actEl.closest("[data-id]").dataset.id;
        const idx = links.findIndex((l) => l.id === id);
        if (actEl.dataset.act === "del") {
          const l = links[idx];
          if (!confirm(`删除快捷入口「${(l && l.name) || ""}」？`)) return;
          await qlRepo.delete(id);
        } else if (actEl.dataset.act === "up" && idx > 0) {
          // 与上一个交换 sort 值
          const a = links[idx], b = links[idx - 1];
          [a.sort, b.sort] = [b.sort, a.sort];
          await qlRepo.put(a); await qlRepo.put(b);
        } else if (actEl.dataset.act === "down" && idx < links.length - 1) {
          const a = links[idx], b = links[idx + 1];
          [a.sort, b.sort] = [b.sort, a.sort];
          await qlRepo.put(a); await qlRepo.put(b);
        } else return;
        rerender();
      });
    },
  };
})();
