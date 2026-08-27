# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## 项目概述

个人工作台 (Personal Workbench) — 自托管的多用户个人效率仪表盘：任务、笔记、习惯打卡、记账、健康记录、RSS 资讯、夸克网盘浏览、快捷入口，带登录鉴权与按用户数据隔离。零构建、零 Node 依赖的 PWA，这是硬性架构约束（不引入打包器/框架/模板引擎）。

## 常用命令

```bash
# 启动（唯一后端进程，端口 8642，Windows 也可双击 启动工作台.bat）
python server.py            # 依赖: pip install fastapi uvicorn

# 语法检查（没有构建和单测框架，这是最基本的静态验证）
python -m py_compile server.py
node --check js/app.js      # 逐个检查改过的 js 文件

# API 冒烟测试（Swagger: http://localhost:8642/api/docs）
# PowerShell 下 curl 传 JSON 必须写临时文件，inline 转义会损坏 body：
Set-Content -Path "$env:TEMP\body.json" -Value '{"username":"admin","password":"..."}' -Encoding ascii
curl.exe -s -c "$env:TEMP\ck.txt" -X POST http://localhost:8642/api/auth/login -H "Content-Type: application/json" --data "@$env:TEMP\body.json"
curl.exe -s -b "$env:TEMP\ck.txt" http://localhost:8642/api/db/tasks
```

- 端口被占时用 `netstat -ano | Select-String ':8642'` 找 PID（沙箱内 Get-NetTCPConnection 不可靠）。
- 前端改动的端到端验证靠 Browser 子代理，见下方「测试约定」。

## 上线流程（硬性规则）

### 目标服务器参数（写死，不要猜）

- 服务器 `root@111.228.27.161`，代码目录 `/data/app/workbench`，端口 8642。
- git remote 是 **SSH over 443**：`ssh://git@ssh.github.com:443/ximiedeyanhuo/workbench.git`。**不是** github.com:22，直接 `git push` 默认走 22 会超时；也别改成 https（需要额外凭据）。
- 本地 `server.py` 里 `HOST = "0.0.0.0"`，**远程服务器上必须改成 `"127.0.0.1"`**（8642 不暴露公网，由 nginx 反代）。scp 覆盖 server.py 后必须改回，否则服务监听全网口。
- 远程验证用 `curl http://127.0.0.1:8642/...`（服务器本机回环）；外部访问走 https://workbench.duole.site（nginx 反代 + certbot HTTPS，HTTP 301 跳 HTTPS；IP 直访 http://111.228.27.161 保留兜底）。
- 本机 PowerShell 版本 7.6.x；git 未设 `push.default`，推送必须写全 `git push origin main`。

### 标准流程（二选一）

**方式 A（推荐，自动规避全部坑）：`.\deploy.ps1 "提交说明"`**
自动完成：强制 `git add/commit/push`（推送失败即中止）→ SSH 免密检查（不通就退出并提示配公钥）→ scp 代码白名单 → sed 把 server.py 的 HOST 改回 127.0.0.1 → `systemctl restart workbench` → `is-active` 验证。
只传代码：`server.py/index.html/sw.js/manifest.json/icon-192.png/icon-512.png/HELP.md/js/css/lib`。**绝不传数据**：`workbench*.db/users.json/sessions.json/zhipu.key/backups`。
若沙箱执行策略拦截 .ps1（"running scripts is disabled"），用 `powershell -ExecutionPolicy Bypass -File deploy.ps1 "说明"`。

**方式 B（手动，等价命令序列）**：
```bash
# 1. 提交推送（提交信息按仓库风格，中文一行）
git add <改过的文件> && git commit -m "说明" && git push origin main

# 2. scp 代码（目标路径必须完整：/data/app/workbench/ + 相对路径，漏掉 workbench 段文件会进错目录）
scp js/app.js root@111.228.27.161:/data/app/workbench/js/app.js
scp css/app.css root@111.228.27.161:/data/app/workbench/css/app.css
# 改了 server.py 的话：scp 后必须改回 HOST（GNU sed 的 \x22 转义双引号，避开 PowerShell 破坏）：
ssh root@111.228.27.161 'sed -i "s/^HOST = .*$/HOST = \"127.0.0.1\"/" /data/app/workbench/server.py && grep ^HOST /data/app/workbench/server.py'

# 3. 重启 + 验证（重启后 sleep 2 再 curl，服务起得慢）
ssh root@111.228.27.161 "systemctl restart workbench && sleep 2 && curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8642/"
# 再确认新代码真的上线（grep 新函数名/特征字符串），只看 200 不够——可能跑的是旧缓存或旧文件
ssh root@111.228.27.161 "curl -s http://127.0.0.1:8642/js/app.js | grep -c '新函数名'"
```

### 常见失败原因（其他 AI 踩过的坑，按出现频率）

1. **git push 超时/失败**：remote 必须 `ssh.github.com:443`；别用 https、别期望 22 端口通。推送写 `git push origin main`（本机没设 push.default，裸 `git push` 可能报 "no upstream"）。
2. **scp 目标路径写错**：必须完整 `root@111.228.27.161:/data/app/workbench/<相对路径>`。漏 `workbench` 段、多写斜杠、Windows 反斜杠，都会把文件放到错误位置甚至变成新目录。
3. **覆盖 server.py 后忘改 HOST**：远程必须是 `"127.0.0.1"`。deploy.ps1 自动处理；手动 scp 必须自己 sed，否则服务监听 0.0.0.0 或 nginx 反代失效。
4. **PowerShell 下用 `curl`**：`curl` 是 Invoke-WebRequest 别名，必须 `curl.exe`。API 冒烟测试传 JSON 必须写临时文件（inline 引号转义会损坏 body），见「常用命令」。
5. **改 js/css 忘升 sw.js 版本号**：`CACHE = "workbench-vNN"` 必须递增，否则用户浏览器走旧缓存，本地验证"修复无效"是假结论。
6. **重启后立刻验证**：`systemctl restart workbench` 后 sleep 2 再 curl，否则服务还没起来。
7. **验证只看 HTTP 200**：200 不代表新代码生效。用 grep 确认新函数/新字符串在远程文件里（或浏览器硬刷新验证）。
8. **ssh 远程命令引号被 PowerShell 转义破坏**：双引号用 `\x22`（deploy.ps1 第 64 行有示范），复杂命令优先写进 deploy.ps1。
9. **浏览器 E2E 跑旧代码**：必须注销 SW + 清 caches + `?nocache=<时间戳>` 硬导航，否则测的是内存里的旧代码（见「测试约定」）。
10. **沙箱内 Get-NetTCPConnection 不可靠**：端口排查用 `netstat -ano | Select-String ':8642'`。
- 改了 js/css 等静态文件记得升 sw.js 的 `CACHE` 版本号（workbench-vNN），否则用户浏览器走旧缓存。

## 架构

### 后端：server.py 单文件（FastAPI + SQLite WAL）

四类职责集中在一个文件里：静态托管（根路径）、通用 CRUD、RSS/AI 代理、用户体系。

- **schema-less 存储**：每个 store 一张 `(id TEXT PK, data TEXT)` 表，data 是 JSON 文本，前端加字段后端永不改。store 白名单在 `STORES` 元组，必须与 db.js 的 store 列表保持一致；settings 表主键字段是 `key`，其余是 `id`。
- **鉴权**：`auth_guard` 中间件拦截所有 `/api/*`（`OPEN_API_PATHS` 白名单除外），未登录 401。账号存 `users.json`（PBKDF2），会话存 `sessions.json`（30 天，重启不掉线），token 走 HttpOnly Cookie `wb_token`。预设账号制，不开放注册；首启无用户自建 admin/admin123。
- **按用户数据隔离**：登录用户由中间件写入 `CURRENT_USER` contextvar，`get_conn()` 据此路由库文件——admin 用存量 `workbench.db`，其他用户各自 `workbench_<用户名>.db`（懒创建）。改动任何数据接口都必须经 `get_conn()`，不要直接连 DB_FILE。
- **AI 代理**：智谱 key 只在服务端（环境变量 `ZHIPU_API_KEY` 或 `zhipu.key` 文件），模型 `ZHIPU_MODEL` 可覆盖，默认 glm-4.5-air。
- **RSS 代理** `/api/feed?url=`：有 SSRF 内网拦截（`assert_public_http_url`）、2MB 上限、20s 超时。
- **备份**：启动时 `auto_backup()` 遍历所有 `workbench*.db`，每库每日一份、各保留 7 份到 `backups/`。
- JSON 序列化用 `json_text()`，容错孤立代理项（emoji 被截断的场景）。

### 前端：原生 JS Hash-SPA，全局命名空间 `WB`

- **数据层 db.js 是核心**：业务模块统一通过 `WB.repo(store)` 拿仓库，接口 `list/get/put/delete/clear/bulkPut`。`repo()` 返回的是**惰性代理**——每次方法调用时才根据 `USE_API`（后端探测结果）决定走 ApiRepository 还是 IndexedDB。业务模块可以在顶层 `const xxxRepo = repo("xxx")`，但**绝不能绕过代理直接绑定具体实现**，否则会重现"各页写本地、首页读服务器"的存储割裂 bug。
- **启动门控**：`WB.ready = probeBackend → checkAuth`。在线且未登录时显示登录遮罩并返回永不 resolve 的 Promise 挂起整个 app；离线/本地模式不需要登录。所有 `api()` 调用遇 401 统一走 `on401()` 弹"登录已过期"遮罩。
- **路由**：注册在 `WB.routes`，每个路由实现 `{title, render(el)}`，共用同一个 `#view` 容器。**任何长 await 之后的重渲染必须先校验当前路由还是本页**（参考 news.js 的 `stillOnNews()` 守卫），否则慢请求回调会污染已切走的页面。
- **跨模块跳转**：全局搜索命中后往 `WB.jump` 写目标 ID，切 hash 后目标路由读取并消费。
- feeds 和 health 在本地模式下各自独立 IndexedDB 库（避免主库版本升级冲突）；服务器模式下都是普通 store。
- 设置持久化：已读状态在 settings 的 `newsRead`（上限 500 条）；删除预置资讯源记入 `newsRemovedUrls` 防增量补种加回。
- 表单校验统一用 `WB.flashInvalid()`（红框 + 抖动），不要用 alert 做校验提示。

### Service Worker（sw.js）

静态资源 stale-while-revalidate，`/api/*` 网络优先不缓存。改了 STATIC 清单里的文件后**升级 `CACHE` 版本号**（workbench-vNN）。新增静态文件记得加进 STATIC 清单。

### CSS（css/app.css，单文件 ~1400 行）

明暗主题靠 CSS 变量 + `data-theme`。两个已踩过的坑：
- 改完必须确认 `{}` 配平（多余的 `}` 会让浏览器静默吞掉紧随其后的整条规则）；
- 给带 `hidden` 属性的元素写 `display` 非 none 的规则时，必须同时补 `.xxx[hidden]{display:none}` 兜底（作者样式会覆盖 UA 的 `[hidden]`）。

## 测试约定

没有自动化测试框架。验证方式是分层的：

1. 语法检查（`node --check` / `py_compile`）；
2. curl 直测 API（注意上面的 PowerShell JSON 坑）；
3. Browser 子代理端到端验证，**必须先注销 Service Worker + 清 caches + 带 `?nocache=<时间戳>` 硬导航**，否则跑的是内存里的旧代码，会得出"修复无效"的假结论；
4. 多个 Browser 子代理会共用同一浏览器标签页互相干扰，浏览器测试必须串行；
5. 测试数据用 `ZT-` 前缀命名，验证完必须清理（包括测试账号及其 `workbench_<user>.db`）。

## 项目文档与记忆

- `HELP.md` — 面向小白用户的功能手册（页面内"帮助"路由直接渲染它），改了用户可见功能要同步更新；
- `DEPLOY.md` / `TERMUX.md` — VPS 部署与手机 Termux 部署指南；
- `.workbuddy/memory/YYYY-MM-DD.md` — 工作日志，完成实质改动后在同一轮对话内追加记录；
- `CLAUDE.md` — 早期架构说明，部分内容（无鉴权、单库）已过时，以本文件为准。
