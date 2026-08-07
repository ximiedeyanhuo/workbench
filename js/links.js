/**
 * links.js — 快捷入口：常用链接卡片面板（增删 + 上下移排序 + 可选账号密码）
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, safeUrl, flashInvalid } = window.WB;
  const qlRepo = repo("quicklinks");

  const COLORS = ["#FF5A36", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#06B6D4"];

  /** 复制到剪贴板：优先异步 API，http 环境降级隐藏 textarea + execCommand */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      /* ignore */
    }
    ta.remove();
  }

  /** 凭据浮层：明文显示 + 一键复制账号/密码 */
  function showCred(l) {
    const hasAcct = !!(l.account && l.account.trim());
    const hasPass = !!(l.password);
    const row = (label, value, btnId) => `
      <div class="cred-row">
        <span class="cred-label">${label}</span>
        <input class="cred-value" id="${btnId}val" value="${esc(value)}" readonly />
        <button class="btn cred-copy" id="${btnId}" type="button">复制</button>
      </div>`;
    const modal = document.createElement("div");
    modal.className = "cred-modal";
    modal.innerHTML = `
      <div class="cred-box">
        <button class="cred-close" title="关闭" aria-label="关闭">&times;</button>
        <div class="cred-title">${esc(l.name || "入口")}</div>
        <div class="cred-url">${safeUrl(l.url)}</div>
        ${hasAcct ? row("账号", l.account, "credAcct") : ""}
        ${hasPass ? row("密码", l.password, "credPass") : ""}
        <div class="cred-tip">浏览器无法自动填登录框，请复制后粘贴到对应网站</div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (t.classList.contains("cred-close") || t.classList.contains("cred-modal")) return close();
      const btn = t.closest(".cred-copy");
      if (btn) {
        const val = btn.parentElement.querySelector(".cred-value").value;
        copyText(val).then(() => window.WB.showToast(btn.id === "credAcct" ? "账号已复制" : "密码已复制"));
      }
    });
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onEsc);
      }
    });
  }

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
                ${l.account || l.password ? `<span class="ql-cred" title="含账号密码，点击查看">🔑</span>` : ""}
              </div>`
            )
            .join("")
        : '<div class="empty ql-empty">把常用的系统、工具、文档链接加进来，一键直达</div>';

      el.innerHTML = `
        <div class="card">
          <h2>添加入口</h2>
          <div class="row">
            <input id="qlName" placeholder="名称，如：Gitee / 云效 / 掘金" class="w-200" maxlength="20" />
            <input class="grow" id="qlUrl" placeholder="https://…" maxlength="500" />
            <select id="qlColor">
              ${COLORS.map((c, i) => `<option value="${c}" ${i === 0 ? "selected" : ""}>颜色 ${i + 1}</option>`).join("")}
            </select>
            <button class="btn in-card-btn" id="qlAdd">添加</button>
          </div>
          <div class="row cred-add">
            <input id="qlAccount" placeholder="账号（可选）" />
            <input id="qlPass" type="password" placeholder="密码（可选）" autocomplete="off" />
            <span class="cred-hint">填了账号密码，点卡片即弹层查看/复制，方便登录</span>
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
        const account = el.querySelector("#qlAccount").value.trim();
        const password = el.querySelector("#qlPass").value;
        const maxSort = links.reduce((m, l) => Math.max(m, l.sort || 0), 0);
        const rec = { id: uid(), name, url, color: el.querySelector("#qlColor").value, sort: maxSort + 1 };
        if (account) rec.account = account;
        if (password) rec.password = password;
        await qlRepo.put(rec);
        rerender();
      };
      el.querySelector("#qlAdd").addEventListener("click", addLink);
      el.querySelector("#qlUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") addLink(); });

      el.querySelector("#qlGrid").addEventListener("click", async (e) => {
        const actEl = e.target.closest("[data-act]");
        if (actEl) {
          const id = actEl.closest("[data-id]").dataset.id;
          const idx = links.findIndex((l) => l.id === id);
          if (actEl.dataset.act === "del") {
            const l = links[idx];
            if (!confirm(`删除快捷入口「${(l && l.name) || ""}」？`)) return;
            await qlRepo.delete(id);
          } else if (actEl.dataset.act === "up" && idx > 0) {
            // 与上一个交换 sort 值（undefined 视为 0 避免污染）
            const a = links[idx], b = links[idx - 1];
            [a.sort, b.sort] = [b.sort || 0, a.sort || 0];
            await qlRepo.put(a); await qlRepo.put(b);
          } else if (actEl.dataset.act === "down" && idx < links.length - 1) {
            const a = links[idx], b = links[idx + 1];
            [a.sort, b.sort] = [b.sort || 0, a.sort || 0];
            await qlRepo.put(a); await qlRepo.put(b);
          } else return;
          rerender();
          return;
        }
        // 无操作按钮：点击卡片主体 → 有凭据则弹层，同时新标签打开
        const card = e.target.closest(".ql-card");
        if (!card) return;
        const l = links.find((x) => x.id === card.dataset.id);
        if (!l) return;
        if (l.url && /^https?:\/\//i.test(l.url)) window.open(l.url, "_blank", "noopener");
        if (l.account || l.password) showCred(l);
      });
    },
  };
})();
