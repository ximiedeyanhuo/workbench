# 体检报告核对结论与修复方案

> 依据：外部工具生成的《工作台项目体检报告》（2026-08-05）。
> 本文件记录逐条核对结果（均已实测或读码确认）与对应的修复方案。
> 状态：方案已定，待执行。

---

## 一、报告核对结论

报告整体可靠。P0 安全项全部实测确认属实；P1 抽查 5 项 4 真 1 误报；P2 未逐条验证，代码层面推断成立。

### P0 安全项（全部实测属实）

| 论断 | 结果 | 实测证据 |
|---|---|---|
| P0-1 静态托管泄露 | ✅ 完全属实，最严重 | `server.py:1055` `StaticFiles(directory=BASE_DIR, html=True)`，`auth_guard` 只拦 `/api/*`。本地+生产匿名访问全部 200：sessions.json（本 4.9KB / 生产 666B）、users.json、zhipu.key（49B）、workbench.db（本 240KB / 生产 258KB）、server.py、deploy.ps1 |
| P0-3 fetch-title SSRF | ✅ 属实 | 已登录实测 `url=http://127.0.0.1:8642/api/docs` 请求真实发出（返回 401 证明打到本机）；公网 URL 正常。`fetch_title`（:650）只有 `re.match(r"^https?://")` 前缀校验，无 `assert_public_http_url` |
| P0-4 本机默认密码 | ✅ 属实 | 本机 admin/admin123 登录返回 `{"ok":true,"isAdmin":true}`；生产已改密 |

### P1 前端（抽查 5 项）

| 论断 | 结果 | 证据 |
|---|---|---|
| drive.js:298 `debounce` ReferenceError | ✅ 属实 | drive.js:8 只解构 `{routes, repo, esc}`，文件内无定义；db.js:343 的 `debounce` 只导出在 `window.WB` → 搜索框绑定失效 |
| finance.js:1297 `exportList` 参数错位 | ✅ 属实 | 调用传 3 参 `(cats, mtx, txs)`，签名（:832）只收 `(cats, txs)` → 第三个被忽略，第二个 mtx（当月）被当 txs → 导出当月而非全量 |
| news.js safeUrl 存储型 XSS | ✅ 属实 | db.js:328 `safeUrl` 只校验 `http(s)://` 前缀，不做 HTML 转义；news.js:270/271 把结果直插 `href`/`src` 属性（同行 `data-link` 反而转义了）→ 订阅含引号 URL 的恶意 RSS 源可逃逸属性 |
| app.js navigate 无渲染代数锁 | ✅ 属实 | `navigate()`（:94-125）`await route.render(view)` 无守卫；news.js 有 `stillOnNews()` 手动兜底，风险部分缓解，但通用入口没锁 |
| db.js `?mode=api` 假探测 | ❌ 误报 | `mode=` 是注释明确的调试/手机部署覆盖参数；默认路径是真 `fetch("/api/ping")` + AbortController 超时探测 |

### P2 中低风险项（未逐条实测，代码层面推断成立）

夸克 Cookie 明文导出、CSV 公式注入、life.js:43 颜色直插、登录限流仅内存、settings 行形状分裂、stocks.js:276 监听器累积、表单无防重复提交、写操作无 try/catch、`WB.showLoading/showToast` 零调用、links.js:74 sort 交换、finance.js:533 日均按整月摊、根目录 workbench_test1.db 残留、缺全局 `[hidden]` 兜底、manifest theme_color 不一致。

---

## 二、修复方案

### P0 安全（server.py 单文件，一次修复）

#### P0-1 静态托管隔离 — 最紧急

**现状**：`server.py:1055` 挂载整个 BASE_DIR；鉴权中间件只拦 `/api/*`。

**改法**（白名单中间件，改动最小、不破坏 SPA fallback）：

```python
# 放在 auth_guard 之前（:168 前），非 /api 路径做白名单放行
ALLOWED_STATIC = {"", "index.html", "sw.js", "manifest.json", "HELP.md",
                  "icon-192.png", "icon-512.png", "css", "js", "lib"}

@app.middleware("http")
async def static_guard(request, call_next):
    if not request.url.path.startswith("/api/"):
        p = request.url.path.lstrip("/")
        first = p.split("/")[0]
        if first not in ALLOWED_STATIC:
            return Response(status_code=404)
    return await call_next(request)
```

- 白名单依据：sw.js STATIC 清单（index.html / css/ / js/ / lib/ / HELP.md / manifest.json / icon-192.png / icon-512.png）+ `/`（html=True 回退 index.html）。
- 效果：`/sessions.json`、`/users.json`、`/zhipu.key`、`/workbench*.db`、`/server.py`、`/deploy.ps1`、`/backups/`、`/server.log`、`.workbuddy`、`.claude` 等全部 404。
- ⚠️ **生产 sessions.json 已泄露**：上线后清理生产 `sessions.json` 让所有用户重新登录（踢掉潜在冒用者）。users.json/zhipu.key 如未泄露风险可保留，但建议一并轮换 zhipu key。

#### P0-3 SSRF（fetch-title 无防护 + feed 重定向绕过）

**现状**：
- `fetch_title`（:650-669）：仅前缀正则校验，实测请求可达 127.0.0.1。
- `feed_proxy`（:498-508）：有 `assert_public_http_url`（:483-495），但 `urllib.request.urlopen` 默认跟随 302 重定向且**不重新校验目标** → 公网 URL 302 到内网即可绕过（代码层面成立）。

**改法**：
1. `fetch_title` 首行改调 `assert_public_http_url(url)`（替换原正则校验）。
2. 抽共享 helper `safe_fetch(url, ...)`：自定义 `HTTPRedirectHandler` 禁用自动重定向 → 手动循环跟随（上限 3-5 跳），**每跳重新 `assert_public_http_url`** → 校验通过才发请求。feed 与 fetch-title 统一改用它。

#### P0-4 本机默认密码 admin123

**现状**：`server.py:81` `DEFAULT_ADMIN_PASSWORD = "admin123"`；:146-148 首启无用户时建号并打印到控制台。

**改法**：首启建号密码取 `os.environ.get("ADMIN_INIT_PASSWORD")`，无则 `secrets.token_urlsafe(9)` 生成，仅打印到 stdout。已有用户（users.json 已存在 admin）不受影响。

**验证**：匿名 curl 6 个敏感文件全 404、静态资源 200；fetch-title 打 `http://127.0.0.1:8642` 返 400；重启后旧 admin123 失败。

---

### P1 前端（多文件，按模块并行）

| # | 文件:行 | 问题 | 改法 |
|---|---|---|---|
| 1 | drive.js:8 | 只解构 `{routes, repo, esc}`，:298 裸调 `debounce` → ReferenceError，搜索框失效 | 解构补 `debounce` |
| 2 | finance.js:1297 | `exportList(cats, mtx, txs)` 3 参 vs 签名 `(cats, txs)` → 导出当月非全量 | 改 `exportList(cats, txs)` |
| 3 | db.js:328 + news.js:270/271/300/303/412、links.js:26、notes.js:256 | safeUrl 只验前缀不转义 → URL 含 `"` 可逃逸属性（RSS 链接可控 → 存储型 XSS） | safeUrl 内部做 HTML 转义（`& < > " '`，不影响 `#` 判断与协议前缀） |
| 4 | app.js:94-125 | navigate 无渲染代数锁，慢路由回调污染已切走的页面 | `const token = ++navSeq`；`await route.render(view)` 后 `if (token !== navSeq) return` |
| 5 | finance.js:1100、:522 | `t.date.slice(0,7)`，date 缺失 → TypeError | `(t.date \|\| "").slice(...)` |
| 6 | finance.js:1057 | dueDay=31 生成非法日期（如 2 月） | `new Date(y, m, Math.min(day, daysInMonth(y, m)))` |
| 7 | finance.js:1279 + app.js:649 | checkSchedules 双入口 → 重复记账 | 统一入口或加标记防重 |
| 8 | finance.js:936-988 | 导入无去重 | 按 id 去重 |
| 9 | finance.js:746 | Chart.js 标签直插未转义 | 标签模板转义 |
| 10 | drive.js:121/440/100/382 | fid 未转义、backToList 失效、排序优先级、getFileType 不存在 | 分别修正 |
| 11 | news.js:677 | 删除源绑错元素 | 绑定修正 |
| 12 | notes.js:325 | 搜索丢焦点、无脏检查 | 修焦点 + beforeunload/hashchange 提示 |
| 13 | tasks.js:243-247 | 逾期顺延每次渲染都写 | 仅跨天时写 |
| 14 | db.js:285-295 | importAll 非原子 | 改走 server.py:466 已有的单事务 `/api/import` |
| 15 | sw.js:35-40 / :55-60 | addAll 全有或全无；降级死代码 | 逐个缓存容错；删死代码 |

### P2 可选项（低优先）

夸克 Cookie 明文导出 → 导出前提示风险；CSV 公式注入 → 以 `= + - @` 开头的单元格前缀 `'`；life.js:43 颜色直插 → 改用 CSS 变量；登录限流内存态 → 落盘持久化；settings 行形状分裂 → 统一写入形状；stocks.js:276 监听器累积 → 复用监听或事件委托；全部表单防重复提交；写操作 try/catch 兜底；删除死代码 `WB.showLoading/showToast` 或接上；links.js:74 sort 交换出 undefined → 修正；finance.js:533 日均按整月摊 → 按实际天数；删除根目录 workbench_test1.db 残留；补全局 `[hidden]` 兜底规则；manifest theme_color 与当前主题对齐。

---

## 三、执行与验证

1. **并行**：server.py P0 三项一个 fixer 全改（同文件避免冲突）；前端按模块并行 fixer（finance.js / news.js+links.js / drive.js / app.js+db.js+tasks.js+notes.js+sw.js），文件互不重叠。
2. **语法**：`python -m py_compile server.py` + 每个改过的 js `node --check`。
3. **API 实测**：curl 敏感文件 404、SSRF 400、旧密码失败、新密码可登录。
4. **前端 E2E**：Browser 子代理串行验证（注销 SW + 清 caches + `?nocache` 硬导航）——drive 搜索、finance 导出全量、快速切页不串台。
5. **上线**：改完升 sw.js CACHE → v56，`.\deploy.ps1`（内置 commit+push+重启）；上线后清理生产 sessions.json 强制全员重登。
6. **复检**：修复完成后可让报告工具再跑一遍，确认 P0 清零。

---

## 四、UI 设计评审核对与修复方案

> 依据：《工作台UI设计评审.md》（2026-08-05T07:19，双代理法，总分 26/40，P0×1 / P1×2）。
> **关键前提**：报告评估的是**已回退的「白昼站台」版本**（文中 #fff on #f4f6f5、accent #c2410c 均为被否回退的主题，已零残留）。涉及色彩的具体论断失效，**结构类论断与主题无关、全部仍成立**。

### 4.1 核对结论

| 论断 | 结果 | 证据 |
|---|---|---|
| **P0** 仪表盘 9+ 区块纵向堆叠 | ✅ 属实 | app.js:411-484+：greeting → stat-grid×4 → 净资产 → 今日焦点 → dash-actions（打卡/记支出/笔记）→ chart-grid×3 → 每周回顾 → footnote。移动端 6+ 屏 |
| **P1** 今日焦点是普通 `<ul class="list">` 非时间轴 | ✅ 属实 | app.js:425-426 `<h2>今日焦点` + `<ul class="list" id="focusList">`，CSS 无时间轴专用规则；隐喻只长在皮肤（stat 卡 s-lab 琥珀菱形标 :674-678），结构层缺席 |
| **P1** alert() 破坏设计语言 | ✅ 属实且量大 | 全项目约 40 处：app.js 20 处（:617 通知拒绝、:623/:625 AI 未配置、:824-1013 设置/迁移/备份），drive.js 4、finance.js 4、news.js 6、notes.js 3、tasks.js 2、stocks/life 各 1 |
| **P3** stat 卡可点击无视觉引导 | ✅ 部分属实 | .stat:hover 仅边框变色+投影+上移 1px（css:662-666），无箭头/无「查看详情」；s-lab 琥珀菱形标算轻微暗示 |
| viewport 违反 WCAG 1.4.4 | ✅ 属实 | index.html 确有 `maximum-scale=1.0, user-scalable=no` |
| **P2** 亮色卡片区分度脆弱（#fff on #f4f6f5） | ❌ 已随回退失效 | 但残留担忧成立：当前亮色 --shadow-sm 仅 6% + 1px 边框（css:35/46）；对比度注释 accent 5.4:1、muted-2 5.9:1 贴 AA 边界（css:24-27） |
| 「亮色 accent #c2410c → 暗色 #ffb454」 | ⚠️ 半对 | #ffb454 是暗色 accent（css:73，属实）；#c2410c 是已回退的亮色，当前亮色 #a94f08 |
| 夸赞项：色彩注释对比度/空态三件套/响应式/hover-none/reduced-motion | ✅ 属实 | css:24-27 对比度标注、app.js:394/409/429 空态、css:1575-1670 断点与动效降级 |

**结论**：报告专业且读得细，但核心前提过时。真正值得处理的只剩结构类四项——纯结构/交互改进，恰好避开被否的亮色方向。

### 4.2 UI 修复方案（结构类四项）

| # | 问题 | 方案 | 涉及 |
|---|---|---|---|
| U-1 | **P0 仪表盘信息过载**（9+ 区块堆叠） | 分层折叠：第一屏 = greeting + stat-grid + 今日焦点（到发时刻表本体）；第二屏 = 打卡 + 快速记支出（行动区）；净资产/图表/每周回顾折叠进 `<details>` 渐进披露 | js/app.js 仪表盘渲染（:411-490+）、css/app.css dash 相关规则 |
| U-2 | **P1 今日焦点时间轴化**（隐喻升到结构层） | 重构为纵向时间轴：左侧时间刻度列，任务是「车次行」（时间 + 标题 + 优先级徽标 + 检票 checkbox），逾期用晚点红标注，撕票虚线分隔已检票/待检票 | js/app.js focusList 渲染（:425-441）、css/app.css 新增时间轴规则；注意保留 data-act="toggle" 事件 |
| U-3 | **P1 全局 alert() 替换**（约 40 处） | 复用 .offline-banner 模式做内联提示；AI 未配置在按钮态体现（disabled + tooltip）；通知拒绝/导入结果用 toast；设置类操作成功用 toast、失败用内联 | app.js / drive.js / finance.js / news.js / notes.js / tasks.js / stocks.js / life.js |
| U-4 | **P3 stat 卡 hover 引导** | hover 时右下角出现箭头（→），或 s-sub 加「查看详情 →」链接式文字 | css/app.css .stat:hover（:662-666） |

### 4.3 UI 可选项（低优先）

viewport 去掉 `maximum-scale/user-scalable` 限制；AI 拆解按钮 ✨ emoji 换 SVG 图标；空态虚线圆环加文字区分（避免误认 loading）；登录页隐喻文案下沉到高频页面（如仪表盘 footer 一句话）；亮色 --shadow-sm 提到 8-10% 不透明度（残留担忧）。

### 4.4 执行与验证（UI）

1. **责任人**：des-2（已有全站 CSS/JS 上下文）负责 U-1/U-2 结构重构 + U-3/U-4；若 U-3 涉及 8 个 js 文件量大，可与 U-1/U-2 拆两个 lane 并行（app.js 不重叠）。
2. **语法**：每个改过的 js `node --check`。
3. **E2E**：Browser 子代理串行验证（注销 SW + 清 caches + `?nocache` 硬导航）——仪表盘分区折叠、时间轴勾选任务不串台、alert 替换后各失败路径出现内联提示。
4. **上线**：升 sw.js CACHE → v56（与安全修复同批次），`.\deploy.ps1`。
5. **注意**：U-1/U-2 改仪表盘渲染，须保持 WB.jump / data-go / 全局搜索跳转逻辑不受影响；不与 P0 安全修复抢同文件（app.js 仅前端，server.py 后端，可并行）。
