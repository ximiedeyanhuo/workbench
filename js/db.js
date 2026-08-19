/**
 * db.js — 数据层：ApiRepository（默认，走 server.py + SQLite）+ IndexedDB 回退
 * 所有业务模块只通过 WB.repo(store) 访问数据，两套实现接口完全一致。
 * USE_API = false 可整体回退为纯浏览器 IndexedDB 模式（无后端也能用）。
 */
(function () {
  "use strict";

  // ---------- 轻提示（全局 UI 基础设施，必须在最先加载的本文件里定义）----------
  // 注意：业务模块在 IIFE 顶层解构 window.WB（早于 app.js 加载），toast 若定义在
  // app.js 里，这些模块拿到的会是 undefined（曾导致 anniv/quick/reminders 添加后抛错不重渲）
  function showToast(text, type = "info") {
    const el = document.createElement("div");
    el.className = "wb-toast " + (type === "success" || type === "ok" ? "success" : type === "error" ? "error" : type === "warning" ? "warning" : "");
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(function () {
      el.classList.add("hide");
      setTimeout(function () { return el.parentNode && el.parentNode.removeChild(el); }, 300);
    }, 3000);
  }

  // ---------- 数据后端开关 ----------
  // 启动时探测后端：ping /api/ping，超时 1.5s，成功走 ApiRepository（SQLite），
  // 失败降级 IndexedDB（纯本地模式）。手机端 PWA 离线时会自动落到本地。
  // 手动强制模式：URL 加 ?mode=local 或 ?mode=api 可覆盖。
  const API_BASE = "/api/db/";
  const PROBE_TIMEOUT = 1500;

  let USE_API = null; // null=未探测；true/false=已决定
  const modeReadyCbs = [];
  function onModeReady(cb) {
    if (USE_API !== null) return cb(USE_API);
    modeReadyCbs.push(cb);
  }
  function fireModeReady(val) {
    USE_API = val;
    // WB.USE_API 是 getter，直接返回内部 USE_API 变量即可，无需赋值
    modeReadyCbs.splice(0).forEach((cb) => { try { cb(val); } catch (e) {} });
  }

  async function probeBackend() {
    // URL 强制覆盖：便于调试和手机端主动锁本地
    try {
      const m = (location.search.match(/[?&]mode=(local|api)/) || [])[1];
      if (m === "local") return false;
      if (m === "api") return true;
    } catch (e) { /* ignore */ }
    // file:// 协议无后端可谈
    if (location.protocol === "file:") return false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
      const res = await fetch("/api/ping", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  // ---------- 登录鉴权（仅在线模式） ----------
  // 会话 token 存 HttpOnly Cookie，浏览器自动携带，JS 接触不到。
  // 未登录/会话过期时后端回 401，前端弹出全屏登录遮罩；登录成功整页 reload。
  const auth = {
    user: null,
    isAdmin: false,
    async logout() {
      try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
      location.reload();
    },
  };

  function showLogin(msg) {
    const mask = document.getElementById("loginMask");
    if (!mask || !mask.hidden) return;
    mask.hidden = false;
    if (msg) {
      const sub = document.getElementById("loginSub");
      if (sub) sub.textContent = msg;
    }
    setTimeout(() => {
      const u = document.getElementById("loginUser");
      if (u) u.focus();
    }, 50);
  }

  function bindLoginForm() {
    const form = document.getElementById("loginForm");
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("loginErr");
      const btn = document.getElementById("loginBtn");
      const username = document.getElementById("loginUser").value.trim();
      const password = document.getElementById("loginPwd").value;
      if (!username || !password) {
        errEl.hidden = false;
        errEl.textContent = "请输入用户名和密码";
        return;
      }
      btn.disabled = true;
      btn.textContent = "登录中…";
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || "登录失败 HTTP " + res.status);
        location.reload(); // 以已登录身份重新完整启动
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = (err && err.message) || "登录失败";
        btn.disabled = false;
        btn.textContent = "登 录";
      }
    });
  }
  bindLoginForm();

  /** 检查登录态：已登录 true；401 false；其它异常视为已登录（避免网络抖动误锁） */
  async function checkAuth() {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (res.status === 401) return false;
      if (res.ok) {
        const me = await res.json();
        auth.user = me.username;
        auth.isAdmin = !!me.isAdmin;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  /** 请求中途会话过期：弹登录遮罩（登录后 reload 恢复） */
  function on401() {
    showLogin("登录已过期，请重新登录");
  }

  const DB_NAME = "workbench";
  const DB_VERSION = 1;
  const STORES = ["tasks", "notes", "bookmarks", "habits", "finance", "quicklinks", "settings"];
  // feeds 用独立库：给已上线的主库加 store 需版本升级，而多标签同时打开时升级会互相
  // 阻塞、导致页面卡在「加载中」。独立库首次创建即为 v1，永不触发主库升级。
  const FEEDS_DB = "workbench_feeds";
  const FEEDS_VERSION = 1;
  const FEEDS_STORES = ["feeds"];
  // health 同理独立建库（2026-07 新增），首次创建即 v1，不碰主库版本
  const HEALTH_DB = "workbench_health";
  const HEALTH_VERSION = 1;
  const HEALTH_STORES = ["health"];
  // stocks 同理独立建库（2026-07 股票持仓新增）
  const STOCKS_DB = "workbench_stocks";
  const STOCKS_VERSION = 1;
  const STOCKS_STORES = ["stocks"];
  // mockexams 同理独立建库（考公模考记录），首次创建即 v1，不碰主库版本
  const MOCKEXAMS_DB = "workbench_mockexams";
  const MOCKEXAMS_VERSION = 1;
  const MOCKEXAMS_STORES = ["mockexams"];
  // quicknotes（灵感速记）/ anniv（倒数日） / reminders（自定义提醒）同理独立建库，避免主库升级阻塞
  const QUICK_DB = "workbench_quick";
  const QUICK_VERSION = 1;
  const QUICK_STORES = ["quicknotes"];
  const ANNIV_DB = "workbench_anniv";
  const ANNIV_VERSION = 1;
  const ANNIV_STORES = ["anniv"];
  const REMIND_DB = "workbench_remind";
  const REMIND_VERSION = 1;
  const REMIND_STORES = ["reminders"];
  // media（书影音清单）同理独立建库，避免主库升级阻塞
  const MEDIA_DB = "workbench_media";
  const MEDIA_VERSION = 1;
  const MEDIA_STORES = ["media"];
  // timeline（人生时间轴/重大事件）同理独立建库
  const TIMELINE_DB = "workbench_timeline";
  const TIMELINE_VERSION = 1;
  const TIMELINE_STORES = ["timeline"];
  // tracker（自定义追踪器定义+记录）同理独立建库
  const TRACKER_DB = "workbench_tracker";
  const TRACKER_VERSION = 1;
  const TRACKER_STORES = ["trackers", "trackerlogs"];
  // timeentries（时间账本）同理独立建库
  const TIME_DB = "workbench_time";
  const TIME_VERSION = 1;
  const TIME_STORES = ["timeentries"];
  // subscriptions（订阅中心）同理独立建库
  const SUBS_DB = "workbench_subs";
  const SUBS_VERSION = 1;
  const SUBS_STORES = ["subscriptions"];
  // contacts（联系人+互动记录）同理独立建库
  const CONTACTS_DB = "workbench_contacts";
  const CONTACTS_VERSION = 1;
  const CONTACTS_STORES = ["contacts", "contactlogs"];
  const ALL_STORES = STORES.concat(FEEDS_STORES, HEALTH_STORES, STOCKS_STORES, MOCKEXAMS_STORES, QUICK_STORES, ANNIV_STORES, REMIND_STORES, MEDIA_STORES, TIMELINE_STORES, TRACKER_STORES, TIME_STORES, SUBS_STORES, CONTACTS_STORES); // 导入导出覆盖全部业务数据
  const EXPORT_VERSION = 1;

  const dbCache = {};

  function open(name, version, stores) {
    if (dbCache[name]) return dbCache[name];
    dbCache[name] = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        stores.forEach((s) => {
          if (!db.objectStoreNames.contains(s)) {
            db.createObjectStore(s, { keyPath: s === "settings" ? "key" : "id" });
          }
        });
      };
      req.onsuccess = () => {
        const db = req.result;
        // 其它标签页触发升级时主动让出连接，避免把对方永久阻塞在「加载中」
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      // 升级被其它旧连接阻塞：给出可操作提示，不再无限等待
      req.onblocked = () =>
        reject(new Error("数据库升级被占用，请关闭本应用的其它标签页后刷新"));
    });
    return dbCache[name];
  }

  /** 按 store 名解析所属数据库 */
  function dbForStore(store) {
    if (FEEDS_STORES.indexOf(store) !== -1) return open(FEEDS_DB, FEEDS_VERSION, FEEDS_STORES);
    if (HEALTH_STORES.indexOf(store) !== -1) return open(HEALTH_DB, HEALTH_VERSION, HEALTH_STORES);
    if (STOCKS_STORES.indexOf(store) !== -1) return open(STOCKS_DB, STOCKS_VERSION, STOCKS_STORES);
    if (MOCKEXAMS_STORES.indexOf(store) !== -1) return open(MOCKEXAMS_DB, MOCKEXAMS_VERSION, MOCKEXAMS_STORES);
    if (QUICK_STORES.indexOf(store) !== -1) return open(QUICK_DB, QUICK_VERSION, QUICK_STORES);
    if (ANNIV_STORES.indexOf(store) !== -1) return open(ANNIV_DB, ANNIV_VERSION, ANNIV_STORES);
    if (REMIND_STORES.indexOf(store) !== -1) return open(REMIND_DB, REMIND_VERSION, REMIND_STORES);
    if (MEDIA_STORES.indexOf(store) !== -1) return open(MEDIA_DB, MEDIA_VERSION, MEDIA_STORES);
    if (TIMELINE_STORES.indexOf(store) !== -1) return open(TIMELINE_DB, TIMELINE_VERSION, TIMELINE_STORES);
    if (TRACKER_STORES.indexOf(store) !== -1) return open(TRACKER_DB, TRACKER_VERSION, TRACKER_STORES);
    if (TIME_STORES.indexOf(store) !== -1) return open(TIME_DB, TIME_VERSION, TIME_STORES);
    if (SUBS_STORES.indexOf(store) !== -1) return open(SUBS_DB, SUBS_VERSION, SUBS_STORES);
    if (CONTACTS_STORES.indexOf(store) !== -1) return open(CONTACTS_DB, CONTACTS_VERSION, CONTACTS_STORES);
    return open(DB_NAME, DB_VERSION, STORES);
  }

  /** 在指定 store 上执行事务，返回 Promise<request.result> */
  function withStore(store, mode, fn) {
    return dbForStore(store).then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, mode);
          const req = fn(tx.objectStore(store));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  /** IndexedDB 实现：统一 list/get/put/delete/clear 接口 */
  function idbRepo(store) {
    return {
      list: () => withStore(store, "readonly", (os) => os.getAll()),
      get: (id) => withStore(store, "readonly", (os) => os.get(id)),
      put: (obj) => withStore(store, "readwrite", (os) => os.put(obj)),
      delete: (id) => withStore(store, "readwrite", (os) => os.delete(id)),
      clear: () => withStore(store, "readwrite", (os) => os.clear()),
      bulkPut: (arr) =>
        withStore(store, "readwrite", (os) => {
          arr.forEach((o) => os.put(o));
        }),
    };
  }

  // ---------- ApiRepository（server.py + SQLite）----------
  /** settings 的主键字段是 key，其余 store 为 id（与 IndexedDB keyPath 一致） */
  function keyOf(store, obj) {
    return store === "settings" ? obj.key : obj.id;
  }

  async function api(method, path, body) {
    const res = await fetch(API_BASE + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      on401();
      throw new Error("未登录或登录已过期");
    }
    if (!res.ok) throw new Error("服务器请求失败 HTTP " + res.status);
    return res.json();
  }

  /** API 实现：与 idbRepo 接口完全一致，get 未命中同样返回 undefined */
  function apiRepo(store) {
    return {
      list: () => api("GET", store),
      get: (id) =>
        api("GET", store + "/" + encodeURIComponent(id)).then((r) => (r === null ? undefined : r)),
      put: (obj) => api("PUT", store + "/" + encodeURIComponent(keyOf(store, obj)), obj),
      delete: (id) => api("DELETE", store + "/" + encodeURIComponent(id)),
      clear: () => api("DELETE", store),
      bulkPut: (arr) => api("POST", store + "/bulk", arr),
    };
  }

  const REPO_METHODS = ["list", "get", "put", "delete", "clear", "bulkPut"];

  /** Repository 工厂：按开关路由到 API 或 IndexedDB，业务模块无感知。
   *  返回“惰性代理”：每个方法在**调用时**才解析 USE_API 决定走 API 还是
   *  IndexedDB。这样即便业务模块在文件加载阶段（探测未完成、USE_API===null）
   *  就 const 缓存了 repo(store) 的返回值，实际读写也永远落到当前正确的存储，
   *  不会被静态绑定永久锁死在 IndexedDB（否则会出现“各页写本地、首页读服务器”
   *  的存储割裂）。 */
  function repo(store) {
    const proxy = {};
    REPO_METHODS.forEach((m) => {
      proxy[m] = (...args) => (USE_API === true ? apiRepo(store) : idbRepo(store))[m](...args);
    });
    return proxy;
  }

  // ---------- settings 便捷读写 ----------
  // 注意：每次调用重新解析 repo("settings")，避免探测完成前的静态绑定把
  // settings 永远锁在 IndexedDB。
  function getSetting(key, def) {
    return repo("settings").get(key).then((r) => {
      if (r === undefined || r === null) return def;
      // 兼容旧版行形状 {key, urls}（无 value 包装层）：读不到 value 时回退默认值，
      // 避免返回 undefined 导致调用方 (如 newsRemovedUrls.filter) 崩溃
      return r.value === undefined ? def : r.value;
    });
  }
  function setSetting(key, value) {
    return repo("settings").put({ key, value });
  }
  /** 批量读多个 settings：一次 list() 拿全量再取值，避免多次 API 往返（服务器模式下尤其省）
   *  返回 { key: value }；缺省用 defaults[key] 或 undefined */
  async function getSettings(keys) {
    const defs = keys && typeof keys === "object" && !Array.isArray(keys) ? keys : {};
    const keyList = Array.isArray(keys) ? keys : Object.keys(defs);
    const rows = await repo("settings").list().catch(() => []);
    const map = {};
    rows.forEach((r) => { if (r && r.key !== undefined) map[r.key] = r.value; });
    const out = {};
    keyList.forEach((k) => { out[k] = map[k] === undefined ? (defs[k] === undefined ? undefined : defs[k]) : map[k]; });
    return out;
  }

  // ---------- 全量导出 / 导入 ----------
  async function exportAll() {
    // 并行拉全部 store：API 模式下串行 await 是 15+ 次 HTTP 往返，慢一个量级
    const rows = await Promise.all(ALL_STORES.map((s) => repo(s).list()));
    const data = {};
    ALL_STORES.forEach((s, i) => { data[s] = rows[i]; });
    return { app: "workbench", version: EXPORT_VERSION, exportedAt: new Date().toISOString(), data };
  }

  async function importAll(payload) {
    if (!payload || payload.app !== "workbench" || !payload.data) {
      throw new Error("备份文件格式不正确");
    }
    // 服务器模式：走后端单事务接口，全量覆盖
    if (USE_API === true) {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { on401(); throw new Error("未登录或登录已过期"); }
      if (!res.ok) throw new Error("导入失败 HTTP " + res.status);
      return;
    }
    // 本地模式：先快照全部数据，失败时回滚
    const snapshots = {};
    for (const s of ALL_STORES) {
      try { snapshots[s] = await repo(s).list(); } catch (e) { snapshots[s] = []; }
    }
    try {
      for (const s of ALL_STORES) {
        const r = repo(s);
        await r.clear();
        const rows = Array.isArray(payload.data[s]) ? payload.data[s] : [];
        if (rows.length) await r.bulkPut(rows);
      }
    } catch (e) {
      // 回滚：逐个恢复快照数据
      for (const s of ALL_STORES) {
        try {
          const r = repo(s);
          await r.clear();
          if (snapshots[s] && snapshots[s].length) await r.bulkPut(snapshots[s]);
        } catch (rollbackErr) { /* 尽力回滚，不抛 */ }
      }
      throw new Error("导入失败，已回滚至导入前状态");
    }
  }

  /** 强制从浏览器 IndexedDB 导出（迁移旧数据到服务器专用，不走 API 路由） */
  async function exportLocal() {
    const rows = await Promise.all(ALL_STORES.map((s) => idbRepo(s).list()));
    const data = {};
    ALL_STORES.forEach((s, i) => { data[s] = rows[i]; });
    return { app: "workbench", version: EXPORT_VERSION, exportedAt: new Date().toISOString(), data };
  }

  // ---------- 通用工具 ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function dateStr(d) {
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }
  const todayStr = () => dateStr(new Date());

  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  const fmtMoney = (n) => Number(n || 0).toLocaleString("zh-CN");

  /** 仅允许 http/https 链接，其余降级为 # 防注入；返回前做 HTML 转义防 XSS */
  function safeUrl(u) {
    const s = String(u || "").trim();
    if (!/^https?:\/\//i.test(s)) return "#";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** 逗号/空格分隔的标签输入 → 数组 */
  function parseTags(input) {
    return String(input || "")
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8);
  }

  /** 防抖：ms 内无新调用才执行（搜索输入等高频场景） */
  function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /** 表单校验反馈：给输入框加红框抖动并聚焦，短暂后自动恢复 */
  function flashInvalid(input) {
    if (!input) return;
    input.classList.remove("invalid");
    void input.offsetWidth; // 重启动画
    input.classList.add("invalid");
    input.focus();
    setTimeout(() => input.classList.remove("invalid"), 1500);
  }

  /** 清空全部业务数据（设置页危险操作用） */
  async function clearAllData() {
    for (const s of ALL_STORES) await repo(s).clear();
  }

  // ---------- AI（智谱，经 server.py 代理，前端不接触 key） ----------
  let aiStatusCache = null; // 会话内只探测一次，配置变更需重启服务本就会刷新页面
  const ai = {
    /** 是否已配置 key：{configured, model}；无后端/请求失败视为未配置 */
    status() {
      if (!aiStatusCache) {
        aiStatusCache = fetch("/api/ai/status")
          .then((r) => (r.ok ? r.json() : { configured: false }))
          .catch(() => ({ configured: false }));
      }
      return aiStatusCache;
    },
    /** 单轮对话，返回文本；失败抛 Error（message 为后端 detail，可直接展示） */
    async chat(system, prompt, temperature) {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system, prompt, temperature }),
      });
      if (res.status === 401) {
        on401();
        throw new Error("未登录或登录已过期");
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "AI 请求失败 HTTP " + res.status);
      return data.text || "";
    },
    /** 从模型回复中提 JSON（容忍 ```json 围栏与前后废话），解不出返回 null */
    parseJson(text) {
      const s = String(text || "");
      const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
      const cand = m ? m[1] : s;
      const start = cand.search(/[\[{]/);
      if (start === -1) return null;
      try { return JSON.parse(cand.slice(start)); } catch (e) { /* 继续尝试截尾 */ }
      const end = Math.max(cand.lastIndexOf("}"), cand.lastIndexOf("]"));
      if (end > start) {
        try { return JSON.parse(cand.slice(start, end + 1)); } catch (e) { return null; }
      }
      return null;
    },
  };

  // ---------- 跨模块共享的小工具（原先在各业务模块各自复制一份，统一收口到 WB） ----------
  /** 读取 CSS 变量当前值（图表取主题色用） */
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /** 两个 yyyy-MM-dd 日期字符串的天数差（b - a） */
  function daysDiff(a, b) {
    return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
  }

  /** 本周一 ~ 周日的日期字符串区间 */
  function weekRange() {
    const d = new Date();
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return [dateStr(mon), dateStr(sun)];
  }

  /** 习惯连续打卡天数（今天没打卡不清零，从昨天起算也允许） */
  function streakOf(h) {
    let c = 0;
    const d = new Date();
    const ck = h.checkins || {};
    if (!ck[dateStr(d)]) d.setDate(d.getDate() - 1);
    for (let i = 0; i < 3660; i++) {
      if (ck[dateStr(d)]) { c++; d.setDate(d.getDate() - 1); } else break;
    }
    return c;
  }

  /** 重复任务：完成一期后生成下一期任务对象；非重复任务或无截止日返回 null。
   *  下一期日期从原截止日按周期步进，且必须晚于今天（逾期多日完成时不会生成过去日期）。 */
  function repeatNext(t) {
    if (!t || !t.repeat || !t.dueDate) return null;
    const today = todayStr();
    const step = t.repeat === "weekly" ? 7 : 1;
    const d = new Date(t.dueDate + "T00:00:00");
    if (isNaN(d.getTime())) return null;
    do { d.setDate(d.getDate() + step); } while (dateStr(d) <= today);
    return {
      id: uid(),
      title: t.title,
      note: t.note || "",
      dueDate: dateStr(d),
      priority: t.priority || "mid",
      tags: (t.tags || []).slice(),
      repeat: t.repeat,
      done: false,
      createdAt: new Date().toISOString(),
    };
  }

  /** 任务排序：未完成在前 → 截止日近的在前 → 优先级高的在前 */
  function sortTasks(list) {
    return list.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const da = a.dueDate || "9999-99-99";
      const db = b.dueDate || "9999-99-99";
      if (da !== db) return da < db ? -1 : 1;
      const pi = { high: 0, mid: 1, low: 2 };
      return (pi[a.priority] ?? 2) - (pi[b.priority] ?? 2);
    });
  }

  // ---------- 全局命名空间 ----------
  window.WB = {
    routes: {},
    get USE_API() { return USE_API; },
    onModeReady,
    /** 探测后端 + 检查登录态：在线且未登录时弹登录遮罩并挂起启动（登录成功后 reload） */
    ready: probeBackend().then(async (ok) => {
      if (ok) {
        const authed = await checkAuth();
        if (!authed) {
          showLogin();
          return new Promise(() => {}); // 挂起：app.js 的 await 不会继续，遮罩后无需渲染业务页
        }
      }
      fireModeReady(ok);
      return ok;
    }),
    auth,
    repo,
    getSetting,
    getSettings,
    setSetting,
    exportAll,
    importAll,
    exportLocal,
    /** 从服务器全量拉取写入本地 IndexedDB（一键同步：服务器 → 本地） */
    async pullServerToLocal() {
      const data = {};
      for (const s of ALL_STORES) data[s] = await apiRepo(s).list();
      for (const s of ALL_STORES) {
        const r = idbRepo(s);
        await r.clear();
        if (Array.isArray(data[s]) && data[s].length) await r.bulkPut(data[s]);
      }
    },
    /** 从本地 IndexedDB 全量推送到服务器（一键同步：本地 → 服务器） */
    async pushLocalToServer() {
      const payload = await exportLocal();
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        on401();
        throw new Error("未登录或登录已过期");
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
    },
    uid,
    dateStr,
    todayStr,
    esc,
    fmtMoney,
    safeUrl,
    parseTags,
    showToast,
    cssVar,
    daysDiff,
    weekRange,
    streakOf,
    sortTasks,
    repeatNext,
    debounce,
    flashInvalid,
    /** 内联 SVG 线性图标（Feather/Lucide 风格，stroke 取 currentColor，零依赖零构建）
     *  用法：`${WB.icon("edit")}` / `${WB.icon("del")}`；尺寸由 CSS .icon-btn svg 控制
     *  规范：高频操作一律用 SVG 图标，保持跨页面 stroke 风格统一；emoji 仅用于语义装饰。 */
    icon(name) {
      const paths = {
        edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
        del: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
        copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        up: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
        down: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
        export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
        prev: '<polyline points="15 18 9 12 15 6"/>',
        next: '<polyline points="9 18 15 12 9 6"/>',
        plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
        refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
        sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
        eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
        calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        forward: '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
        back: '<polyline points="9 18 15 12 9 6"/>',
        list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
        notes: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
        external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
        clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        check: '<polyline points="20 6 9 17 4 12"/>',
        close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
        trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
      };
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
    },

    /* ===== 弹层返回键管理（SPA 内浮层/模态进 history，手机返回键先关弹层再退路由） =====
     * openOverlay(marker, closeFn) 在打开浮层时调用：pushState 推标记状态，并在全局 popstate
     *   上登记关闭回调。效果：
     *   - 手机上按返回键 → popstate → 自动执行顶层浮层 closeFn（不退出页面）
     *   - 浮层用其它方式关闭时，先调用 closeOverlay(marker)（会 history.back() 恢复栈）
     * 浮层可叠加（栈式）；marker 区分来源。history.back() 触发的 popstate 用 _suppressPop 抑制，
     *   避免误关下层浮层。 */
    _overlays: [], // [{marker, close}]
    _overlayBound: false,
    _suppressPop: false,
    openOverlay(marker, closeFn) {
      const self = this;
      if (!self._overlayBound) {
        self._overlayBound = true;
        window.addEventListener("popstate", () => {
          if (self._suppressPop) { self._suppressPop = false; return; }
          const top = self._overlays[self._overlays.length - 1];
          if (top) {
            self._overlays.pop();
            try { top.close(); } catch (e) { /* 忽略 */ }
          }
        });
      }
      self._overlays.push({ marker, close: closeFn });
      try { history.pushState({ wbOverlay: marker }, ""); } catch (e) { /* 忽略 */ }
    },
    closeOverlay(marker) {
      const self = this;
      const idx = self._overlays.map((o) => o.marker).lastIndexOf(marker);
      if (idx < 0) return;
      const was = self._overlays[idx];
      self._overlays.splice(idx, 1);
      // 若是顶层浮层：history.back() 恢复历史栈，popstate 被抑制避免误关下层
      if (idx === self._overlays.length) {
        self._suppressPop = true;
        try { history.back(); } catch (e) { self._suppressPop = false; }
      }
      try { was.close(); } catch (e) { /* 忽略 */ }
    },
    clearAllData,
    ai,
    jump: {}, // 全局搜索 → 目标模块的一次性跳转句柄（如 { taskId, noteId }）
  };
})();
