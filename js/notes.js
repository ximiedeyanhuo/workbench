/**
 * notes.js — 信息沉淀：Markdown 笔记（编辑/预览/搜索/标签）+ 链接收藏
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, safeUrl, parseTags, debounce, flashInvalid } = window.WB;
  const notesRepo = repo("notes");
  const marksRepo = repo("bookmarks");

  // 模块内状态
  let subtab = "notes"; // notes | marks
  let noteQ = "";
  let markQ = "";
  let currentId = null;
  let previewing = false;
  let curFolder = ""; // "" = 全部，"__unfiled__" = 未分类，其余为文件夹名

  // 脏检查：记录编辑器最后保存内容，切换路由/关闭页面前提示未保存修改
  let savedContent = "";
  let dirtyLock = false;
  let lastHash = location.hash;

  const fmtTime = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") : "");

  // ---------- 笔记 ----------
  /** 从全部笔记中汇总文件夹名（数据驱动，无独立 store） */
  function folderNames(notes) {
    const set = new Set();
    notes.forEach((n) => { if (n.folder) set.add(n.folder); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  function filterNotes(notes) {
    const q = noteQ.trim().toLowerCase();
    let list = notes.slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    if (curFolder === "__unfiled__") list = list.filter((n) => !n.folder);
    else if (curFolder) list = list.filter((n) => n.folder === curFolder);
    if (q) {
      list = list.filter(
        (n) =>
          (n.title || "").toLowerCase().includes(q) ||
          (n.content || "").toLowerCase().includes(q) ||
          (n.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return list;
  }

  function notesHtml(notes) {
    const list = filterNotes(notes);
    const cur = notes.find((n) => n.id === currentId);
    const folders = folderNames(notes);
    const unfiledCnt = notes.filter((n) => !n.folder).length;
    const folderHtml = `<div class="folder-list">
      <span class="folder-li ${curFolder === "" ? "on" : ""}" data-fd="">全部 · ${notes.length}</span>
      ${folders
        .map((f) => `<span class="folder-li ${curFolder === f ? "on" : ""}" data-fd="${esc(f)}">📁 ${esc(f)} (${notes.filter((n) => n.folder === f).length})</span>`)
        .join("")}
      ${folders.length && unfiledCnt ? `<span class="folder-li ${curFolder === "__unfiled__" ? "on" : ""}" data-fd="__unfiled__">📂 未分类 (${unfiledCnt})</span>` : ""}
    </div>`;
    const listHtml = list.length
      ? list
          .map(
            (n) => `<div class="note-li ${n.id === currentId ? "on" : ""}" data-nid="${n.id}">
              <div class="n-title">${esc(n.title || "未命名笔记")}</div>
              <div class="n-sub">${fmtTime(n.updatedAt)}${(n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
            </div>`
          )
          .join("")
      : '<div class="empty">没有笔记' + (noteQ ? "匹配搜索" : "") + "</div>";

    const editorHtml = !cur
      ? '<div class="card"><div class="empty">← 选择一篇笔记，或点「新建笔记」开始记录</div></div>'
      : `<div class="card">
          <div class="row sp-b-md">
            <input class="grow" id="nTitle" placeholder="笔记标题" maxlength="80" value="${esc(cur.title)}" />
            <input id="nFolder" list="folderDl" placeholder="文件夹（可新建）" class="w-130" maxlength="20" value="${esc(cur.folder || "")}" />
            <datalist id="folderDl">${folderNames(notes).map((f) => `<option value="${esc(f)}"></option>`).join("")}</datalist>
            <input id="nTags" placeholder="标签（逗号分隔）" class="w-160" maxlength="60" value="${esc((cur.tags || []).join(", "))}" />
          </div>
          ${
            previewing
              ? `<div class="md-preview n-preview">${MD.render(cur.content || "")}</div>`
              : `<textarea id="nContent" rows="16" placeholder="支持 Markdown：# 标题、**粗体**、- 列表、\`代码\`、> 引用、[链接](https://…)">${esc(cur.content)}</textarea>`
          }
          <div class="n-editor-status"><span id="nWordCount">${(cur.content || "").length} 字</span><span id="nDirty" hidden>· 有未保存修改</span></div>
          <div class="row sp-t-lg">
            <button class="btn sm" id="nSave">${WB.icon("save")} 保存</button>
            <button class="btn ghost sm" id="nPreview">${previewing ? WB.icon("edit") + " 编辑" : WB.icon("eye") + " 预览"}</button>
            <button class="btn ghost sm" id="nAi" title="AI 生成摘要与建议标签">${WB.icon("sparkle")} AI 摘要</button>
            <span class="mla"></span>
            <button class="btn danger sm" id="nDel">删除笔记</button>
          </div>
          <div id="nAiPanel"></div>
        </div>`;

    return `<div class="notes-layout">
      <div class="card">
        <div class="row sp-b-md">
          <input class="grow" id="noteSearch" placeholder="🔍 搜标题 / 全文 / 标签" value="${esc(noteQ)}" />
          <button class="btn sm" id="noteNew">新建笔记</button>
        </div>
        ${folderHtml}
        <div class="note-scroll">${listHtml}</div>
      </div>
      <div>${editorHtml}</div>
    </div>`;
  }

  function bindNotes(el, rerender) {
    // 编辑器加载完成即视为已保存状态（脏检查基线）
    const ta0 = el.querySelector("#nContent");
    if (ta0) savedContent = ta0.value;
    // 字数 + 未保存状态栏
    function updateStatus() {
      const ta = el.querySelector("#nContent");
      if (!ta) return;
      const wc = el.querySelector("#nWordCount");
      if (wc) wc.textContent = ta.value.length + " 字";
      const dirty = el.querySelector("#nDirty");
      if (dirty) dirty.hidden = ta.value === savedContent;
    }
    if (ta0) { updateStatus(); ta0.addEventListener("input", updateStatus); }
    const search = el.querySelector("#noteSearch");
    // 防抖：连续输入时只在停顿后过滤一次
    search.addEventListener("input", debounce(() => { noteQ = search.value; refreshListOnly(el); }, 200));

    // 文件夹切换
    el.querySelectorAll("[data-fd]").forEach((f) =>
      f.addEventListener("click", () => { curFolder = f.dataset.fd; rerender(); })
    );

    el.querySelector("#noteNew").addEventListener("click", async () => {
      // 在当前文件夹下新建（「全部/未分类」视图则不归档）
      const folder = curFolder && curFolder !== "__unfiled__" ? curFolder : "";
      const n = { id: uid(), title: "未命名笔记", content: "", tags: [], folder, updatedAt: new Date().toISOString() };
      await notesRepo.put(n);
      currentId = n.id;
      previewing = false;
      rerender();
    });

    el.querySelectorAll("[data-nid]").forEach((li) =>
      li.addEventListener("click", () => { currentId = li.dataset.nid; previewing = false; rerender(); })
    );

    const saveBtn = el.querySelector("#nSave");
    if (saveBtn) {
      const saveNote = async () => {
        const cur = await notesRepo.get(currentId);
        if (!cur) return;
        cur.title = el.querySelector("#nTitle").value.trim() || "未命名笔记";
        cur.folder = el.querySelector("#nFolder").value.trim();
        cur.tags = parseTags(el.querySelector("#nTags").value);
        const ta = el.querySelector("#nContent");
        if (ta) cur.content = ta.value;
        cur.updatedAt = new Date().toISOString();
        await notesRepo.put(cur);
        savedContent = cur.content;
        rerender();
      };
      saveBtn.addEventListener("click", saveNote);
      el.querySelector("#nPreview").addEventListener("click", async () => {
        // 切预览前先落盘当前编辑内容，防止丢字
        const ta = el.querySelector("#nContent");
        if (ta) {
          const cur = await notesRepo.get(currentId);
          if (cur) { cur.content = ta.value; cur.updatedAt = new Date().toISOString(); await notesRepo.put(cur); savedContent = ta.value; }
        }
        previewing = !previewing;
        rerender();
      });
      el.querySelector("#nDel").addEventListener("click", async () => {
        if (!confirm("确定删除这篇笔记？")) return;
        await notesRepo.delete(currentId);
        currentId = null;
        rerender();
      });

      // AI 摘要/打标签：取当前编辑内容送模型，结果展示在面板里由用户决定是否采纳
      const aiBtn = el.querySelector("#nAi");
      // 离线时禁用（AI 依赖服务端代理，本地模式请求会 404）
      if (!window.WB.USE_API) {
        aiBtn.disabled = true;
        aiBtn.classList.add("offline-disabled");
        aiBtn.title = "离线中，AI 不可用";
      }
      aiBtn.addEventListener("click", async () => {
        if (!window.WB.USE_API) { WB.showToast("离线中，AI 摘要不可用", "info"); return; }
        const st = await WB.ai.status();
        if (!st.configured) { WB.showToast("未配置智谱 API Key：设环境变量 ZHIPU_API_KEY 或在项目根创建 zhipu.key 文件后重启服务", "error"); return; }
        const ta = el.querySelector("#nContent");
        const cur = await notesRepo.get(currentId);
        const content = (ta ? ta.value : (cur && cur.content) || "").trim();
        if (content.length < 20) { WB.showToast("正文太短（不足 20 字），不需要 AI 摘要", "info"); return; }
        const panel = el.querySelector("#nAiPanel");
        aiBtn.disabled = true;
        aiBtn.textContent = "生成中…";
        panel.innerHTML = '<div class="ai-panel">正在请智谱阅读这篇笔记…</div>';
        try {
          const text = await WB.ai.chat(
            "你是笔记整理助手。只输出 JSON，不要任何解释。",
            "阅读以下笔记，输出 JSON：{\"summary\": \"不超过 80 字的中文摘要\", \"tags\": [\"3-5个中文短标签\"]}\n\n笔记标题：" + ((cur && cur.title) || "无") + "\n笔记正文：\n" + content.slice(0, 4000)
          );
          const r = WB.ai.parseJson(text);
          if (!r || !r.summary) throw new Error("模型返回格式异常，请重试");
          const tags = Array.isArray(r.tags) ? r.tags.map(String).slice(0, 5) : [];
          panel.innerHTML = `<div class="ai-panel">
            <div class="ai-panel-tt">✨ AI 摘要</div>
            <div class="ai-panel-body">${esc(r.summary)}</div>
            ${tags.length ? `<div class="sp-t-sm">建议标签：${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
            <div class="row sp-t-sm">
              <button class="btn sm" id="aiApply">采纳（摘要插入开头，标签合并）</button>
              <button class="btn ghost sm" id="aiClose">关闭</button>
            </div>
          </div>`;
          panel.querySelector("#aiClose").addEventListener("click", () => { panel.innerHTML = ""; });
          panel.querySelector("#aiApply").addEventListener("click", async () => {
            const n = await notesRepo.get(currentId);
            if (!n) return;
            if (ta) n.content = ta.value; // 先落盘当前编辑，再插摘要，防丢字
            if (n.content.indexOf("> 💡") !== 0) n.content = "> 💡 " + r.summary + "\n\n" + n.content;
            n.tags = Array.from(new Set((n.tags || []).concat(tags))).slice(0, 8);
            n.updatedAt = new Date().toISOString();
            await notesRepo.put(n);
            savedContent = n.content;
            rerender();
          });
        } catch (err) {
          panel.innerHTML = `<div class="ai-panel err">AI 调用失败：${esc(err.message)}</div>`;
        } finally {
          aiBtn.disabled = false;
          aiBtn.innerHTML = WB.icon("sparkle") + " AI 摘要";
        }
      });
    }
  }

  /** 搜索时只重刷列表区，避免编辑器丢焦点 */
  async function refreshListOnly(el) {
    const notes = await notesRepo.list();
    const list = filterNotes(notes);
    const box = el.querySelector("#noteSearch").closest(".card").children[2];
    box.innerHTML = list.length
      ? list
          .map(
            (n) => `<div class="note-li ${n.id === currentId ? "on" : ""}" data-nid="${n.id}">
              <div class="n-title">${esc(n.title || "未命名笔记")}</div>
              <div class="n-sub">${fmtTime(n.updatedAt)}${(n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
            </div>`
          )
          .join("")
      : '<div class="empty">没有笔记匹配搜索</div>';
    box.querySelectorAll("[data-nid]").forEach((li) =>
      li.addEventListener("click", () => { currentId = li.dataset.nid; previewing = false; routes.notes.render(el.closest("#view") || el); })
    );
  }

  // ---------- 链接收藏 ----------
  function marksHtml(marks) {
    const q = markQ.trim().toLowerCase();
    let list = marks.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    if (q) {
      list = list.filter(
        (m) =>
          (m.title || "").toLowerCase().includes(q) ||
          (m.url || "").toLowerCase().includes(q) ||
          (m.note || "").toLowerCase().includes(q) ||
          (m.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    const itemsHtml = list.length
      ? list
          .map(
            (m) => `<li class="item" data-id="${m.id}">
              <span class="txt">
                <a href="${safeUrl(m.url)}" target="_blank" rel="noopener noreferrer" class="dl-title">${esc(m.title || m.url)}</a>
                ${m.note ? `<div class="sub">${esc(m.note)}</div>` : ""}
              </span>
              ${(m.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
              <span class="meta">${(m.createdAt || "").slice(0, 10)}</span>
              <button class="icon-btn" data-act="del-mark" title="删除">${WB.icon("del")}</button>
            </li>`
          )
          .join("")
      : '<div class="empty">还没有收藏' + (markQ ? "匹配搜索" : "，把常看的文章链接存进来") + "</div>";

    return `
      <div class="card">
        <h2>收藏一个链接</h2>
        <div class="row">
          <input class="grow" id="mUrl" placeholder="https://…" maxlength="500" />
          <input id="mTitle" placeholder="标题" class="w-170" maxlength="80" />
          <input id="mNote" placeholder="备注" class="w-150" maxlength="100" />
          <input id="mTags" placeholder="标签" class="w-110" maxlength="60" />
          <button class="btn in-card-btn" id="mAdd">收藏</button>
        </div>
      </div>
      <div class="card">
        <h2>我的收藏<span class="count">${marks.length} 条</span></h2>
        <div class="row sp-b-md">
          <input class="grow" id="markSearch" placeholder="🔍 搜标题 / 网址 / 备注 / 标签" value="${esc(markQ)}" />
        </div>
        <ul class="list" id="markList">${itemsHtml}</ul>
      </div>`;
  }

  function bindMarks(el, rerender) {
    const addMark = async () => {
      const urlInput = el.querySelector("#mUrl");
      const url = urlInput.value.trim();
      if (!url || !/^https?:\/\//i.test(url)) return flashInvalid(urlInput); // 需 http(s):// 开头
      await marksRepo.put({
        id: uid(),
        url,
        title: el.querySelector("#mTitle").value.trim(),
        note: el.querySelector("#mNote").value.trim(),
        tags: parseTags(el.querySelector("#mTags").value),
        createdAt: new Date().toISOString(),
      });
      rerender();
    };
    el.querySelector("#mAdd").addEventListener("click", addMark);
    el.querySelector("#mUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") addMark(); });

    // 自动抓标题：粘贴/输入 URL 后若标题为空，后台取网页 <title> 自动填入（离线模式跳过）
    const urlInput = el.querySelector("#mUrl");
    const titleInput = el.querySelector("#mTitle");
    urlInput.addEventListener("change", async () => {
      const url = urlInput.value.trim();
      if (!window.WB.USE_API || !/^https?:\/\//i.test(url) || titleInput.value.trim()) return;
      const old = titleInput.placeholder;
      titleInput.placeholder = "抓取标题中…";
      try {
        const res = await fetch("/api/fetch-title?url=" + encodeURIComponent(url));
        if (res.ok) {
          const data = await res.json();
          // 只在用户还没手动填过标题时回填，避免覆盖输入
          if (data.ok && data.title && !titleInput.value.trim()) titleInput.value = data.title.slice(0, 80);
        }
      } catch (err) { /* 抓不到就算了，不打扰 */ }
      titleInput.placeholder = old;
    });

    const search = el.querySelector("#markSearch");
    search.addEventListener("input", debounce(() => { markQ = search.value; rerender(true); }, 200));

    el.querySelector("#markList").addEventListener("click", async (e) => {
      const d = e.target.closest('[data-act="del-mark"]');
      if (!d) return;
      const id = d.closest("[data-id]").dataset.id;
      const m = await marksRepo.get(id);
      if (!confirm(`删除书签「${(m && m.title) || ""}」？`)) return;
      await marksRepo.delete(id);
      rerender();
    });
  }

  // ---------- 主渲染 ----------
  routes.notes = {
    title: "沉淀",
    async render(el, keepFocus) {
      const [notes, marks] = await Promise.all([notesRepo.list(), marksRepo.list()]);

      // 全局搜索跳转：直接打开目标笔记的预览
      if (WB.jump.noteId) {
        const target = notes.find((n) => n.id === WB.jump.noteId);
        WB.jump.noteId = null;
        if (target) { subtab = "notes"; currentId = target.id; previewing = true; curFolder = ""; noteQ = ""; }
      }
      // 灵感速记「转为笔记」：直接新建一篇以速记为标题的笔记并选中
      if (WB.jump.noteTitle) {
        const t = WB.jump.noteTitle;
        WB.jump.noteTitle = null;
        const folder = curFolder && curFolder !== "__unfiled__" ? curFolder : "";
        const n = { id: uid(), title: t, content: "", tags: [], folder, updatedAt: new Date().toISOString() };
        await notesRepo.put(n);
        subtab = "notes";
        currentId = n.id;
        previewing = false;
        curFolder = "";
        noteQ = "";
        // 重新拉列表，保证左侧目录里能立即看到新笔记
        const fresh = await notesRepo.list();
        notes.length = 0;
        fresh.forEach((x) => notes.push(x));
      }

      el.innerHTML = `
        <div class="tabs sp-b-xl">
          <button class="tab ${subtab === "notes" ? "on" : ""}" data-st="notes">${WB.icon("notes")} 笔记（${notes.length}）</button>
          <button class="tab ${subtab === "marks" ? "on" : ""}" data-st="marks">${WB.icon("link")} 链接收藏（${marks.length}）</button>
        </div>
        <div id="notesBody">${subtab === "notes" ? notesHtml(notes) : marksHtml(marks)}</div>`;

      el.querySelectorAll("[data-st]").forEach((t) =>
        t.addEventListener("click", () => { subtab = t.dataset.st; routes.notes.render(el); })
      );

      const rerender = (keep) => routes.notes.render(el, keep);
      if (subtab === "notes") bindNotes(el, rerender);
      else {
        bindMarks(el, rerender);
        if (keepFocus) {
          const s = el.querySelector("#markSearch");
          s.focus();
          s.setSelectionRange(s.value.length, s.value.length);
        }
      }
    },
  };

  // ---------- 脏检查：离开页面前提示未保存修改 ----------
  function notesDirty() {
    if (subtab !== "notes" || !currentId) return false;
    const ta = document.getElementById("nContent");
    return !!(ta && ta.value !== savedContent);
  }
  // 路由切换：未保存时确认；取消则回退 hash（用 lock 防循环）
  window.addEventListener("hashchange", () => {
    if (dirtyLock || !notesDirty()) { lastHash = location.hash; return; }
    if (!confirm("笔记有未保存的修改，确定离开吗？")) {
      dirtyLock = true;
      location.hash = lastHash;
      setTimeout(() => { dirtyLock = false; }, 50);
    } else {
      lastHash = location.hash;
    }
  });
  // 关闭/刷新页面：浏览器原生确认
  window.addEventListener("beforeunload", (e) => {
    if (notesDirty()) { e.preventDefault(); e.returnValue = ""; }
  });
})();
