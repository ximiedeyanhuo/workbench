/* quick.js — 灵感速记（随手记）
 * 全局浮窗：右下角悬浮按钮（与番茄钟并排）+ 弹层速记面板。
 * - 一笔灵感：文本 + 可选标签；存 quicknotes store（独立库 workbench_quick）。
 * - 可一键「转为任务」/「转为笔记」落到对应页表单（经 WB.jump 句柄，与全局搜索同一机制）。
 * - 速记列表按时间倒序，支持删除与已存标记。
 * 设计：与 focus.js 同款 openOverlay/closeOverlay 栈式浮层，跨路由保持。
 */
(function () {
  if (!window.WB) return;
  const { repo, uid, esc, icon, dateStr, openOverlay, closeOverlay, showToast } = window.WB;
  const qkRepo = () => repo("quicknotes");

  let visible = false;        // 面板是否打开（路由切换时自动关，由 hashchange 处理）
  let dirty = false;          // 输入框是否有未保存内容

  function el(id) { return document.getElementById(id); }

  function fmtTime(ts) {
    const d = new Date(ts);
    const today = dateStr(new Date());
    const ds = dateStr(d);
    return ds === today
      ? "今天 " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
      : ds.slice(5);
  }

  // ---------- 悬浮按钮 ----------
  function ensureFab() {
    if (el("quickFab")) return;
    const b = document.createElement("button");
    b.id = "quickFab"; b.className = "quick-fab"; b.type = "button";
    b.title = "灵感速记（快捷键 W）";
    b.innerHTML = `${icon("pen")} <span>速记</span>`;
    b.addEventListener("click", openPanel);
    document.body.appendChild(b);
    // 快捷键 W：全局唤起速记（输入框内不拦截）
    document.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() !== "w" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
      e.preventDefault();
      if (visible) closePanel(); else openPanel();
    });
  }

  // ---------- 面板 ----------
  async function openPanel() {
    if (visible) return;
    visible = true;
    const p = document.createElement("div");
    p.id = "quickPanel"; p.className = "quick-panel";
    p.innerHTML = `
      <div class="quick-head">
        <span class="quick-tt">✨ 灵感速记</span>
        <button class="icon-btn plain" id="quickClose" title="关闭（Esc）">${icon("close")}</button>
      </div>
      <div class="quick-body">
        <textarea id="quickInput" rows="3" maxlength="600" placeholder="随手记一笔：想法、待办、金句…（支持 #标签）"></textarea>
        <div class="quick-tags" id="quickTags"></div>
        <div class="quick-acts">
          <button class="btn sm" id="quickSave">${icon("check")} 存入</button>
          <button class="btn sm ghost" id="quickToTask" title="转为任务页草稿">→ 任务</button>
          <button class="btn sm ghost" id="quickToNote" title="转为笔记页草稿">→ 笔记</button>
        </div>
        <ul class="quick-list" id="quickList"></ul>
      </div>
    `;
    document.body.appendChild(p);
    bind(p);
    const inp = el("quickInput");
    inp.focus();
    await renderList();
    openOverlay("quick", closePanel);
    // Esc 关闭
    p.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closePanel(); } });
  }
  function closePanel() {
    if (!visible) return;
    visible = false;
    const p = el("quickPanel");
    if (p) { p.remove(); }
    closeOverlay("quick");
    // 路由切走后输入框也被清掉，dirty 标记重置
    dirty = false;
  }

  function bind(p) {
    p.addEventListener("click", (e) => {
      const del = e.target.closest("[data-qdel]");
      if (del) { removeOne(del.dataset.qdel); return; }
    });
    el("quickClose").addEventListener("click", closePanel);
    el("quickSave").addEventListener("click", saveNote);
    el("quickToTask").addEventListener("click", () => toTarget("task"));
    el("quickToNote").addEventListener("click", () => toTarget("note"));
    el("quickInput").addEventListener("input", () => { dirty = true; renderTags(); });
  }

  // 提取 #标签
  function extractTags(text) {
    const m = text.match(/#([\u4e00-\u9fa5\w-]{1,12})/g);
    return m ? [...new Set(m.map((x) => x.slice(1)))] : [];
  }
  function renderTags() {
    const inp = el("quickInput");
    const box = el("quickTags");
    if (!inp || !box) return;
    const tags = extractTags(inp.value);
    box.innerHTML = tags.map((t) => `<span class="quick-tag">#${esc(t)}</span>`).join("");
  }

  async function saveNote() {
    const inp = el("quickInput");
    const text = (inp.value || "").trim();
    if (!text) return;
    const tags = extractTags(text);
    const body = text.replace(/#[\u4e00-\u9fa5\w-]{1,12}/g, "").trim();
    const n = {
      id: uid(),
      text: body || text,      // 若全被标签吃掉则保留原文
      tags,
      createdAt: new Date().toISOString(),
    };
    await qkRepo().put(n);
    inp.value = "";
    dirty = false;
    renderTags();
    renderList();
    showToast("已存为一笔速记", "ok");
  }

  async function removeOne(id) {
    await qkRepo().delete(id);
    renderList();
    showToast("已删除", "info");
  }

  async function renderList() {
    const ul = el("quickList");
    if (!ul) return;
    let items = await qkRepo().list().catch(() => []);
    items = (items || []).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    if (!items.length) {
      ul.innerHTML = '<li class="quick-empty">还没有速记，随手记下第一个想法吧</li>';
      return;
    }
    ul.innerHTML = items.slice(0, 20).map((n) => `
      <li class="quick-li">
        <div class="quick-li-txt">${esc(n.text)}</div>
        <div class="quick-li-meta">
          ${(n.tags || []).map((t) => `<span class="quick-tag">#${esc(t)}</span>`).join("")}
          <span class="quick-li-time">${fmtTime(n.createdAt)}</span>
          <button class="icon-btn plain" data-qdel="${n.id}" title="删除">${icon("trash")}</button>
        </div>
      </li>`).join("");
  }

  // 转为任务 / 笔记：把当前输入写入 WB.jump 句柄，切到目标页（目标页 render 后消费）
  function toTarget(kind) {
    const inp = el("quickInput");
    const text = (inp.value || "").trim();
    if (!text) return;
    const clean = text.replace(/#[\u4e00-\u9fa5\w-]{1,12}/g, "").trim() || text;
    if (kind === "task") {
      WB.jump.taskTitle = clean;
      closePanel();
      location.hash = "#/tasks";
    } else {
      WB.jump.noteTitle = clean;
      closePanel();
      location.hash = "#/notes";
    }
  }

  // 路由切换时若面板开着，收掉（避免脏状态跨页残留）
  window.addEventListener("hashchange", () => { if (visible) closePanel(); });
  // 首次加载与每次 hash 变化重新挂 FAB（路由 innerHTML 会清掉）
  function bootstrap() { ensureFab(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootstrap);
  else bootstrap();
  window.addEventListener("hashchange", () => setTimeout(ensureFab, 0));

  window.WB.quick = {
    open: openPanel,
    close: closePanel,
    count: async () => (await qkRepo().list().catch(() => [])).length,
    all: async () => (await qkRepo().list().catch(() => [])) || [],
  };
})();
