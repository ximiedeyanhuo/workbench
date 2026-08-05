# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- 用户本人为主，家人/朋友为辅的小范围熟人群体（预设账号制，不开放注册）。
- 使用场景：每天在桌面和手机浏览器上管理个人事务——任务、笔记、习惯、记账、健康、资讯、网盘、快捷入口，一个入口管完日常。

## Product Purpose

自托管的多用户个人效率仪表盘：把任务、笔记、习惯打卡、记账、健康记录、RSS 资讯、夸克网盘浏览、快捷入口聚合在一个 PWA 里，带登录鉴权与按用户数据隔离。成功 = 用户愿意每天打开它作为个人事务的唯一入口。

## Positioning

一站式聚合 + 完全自托管，两者缺一不可：数据存自己的服务器（VPS 或手机 Termux 都能跑），零 Node 依赖零构建，部署和维护成本低到个人能长期持有；同时一个入口覆盖全部日常效率需求，不必在多个工具间切换。

## Operating Context

- 部署：Windows/本地双击 `启动工作台.bat` 或 `python server.py`（FastAPI + SQLite，端口 8642）；VPS（root@111.228.27.161:/data/app/workbench，deploy.ps1 部署）或手机 Termux。
- 访问：桌面浏览器 + 手机浏览器（PWA，可安装到主屏）；有明暗主题切换。
- 维护：上线前必须先提交 GitHub；改静态文件要升 sw.js 的 CACHE 版本号。
- 测试约定：无自动化测试框架，靠 `python -m py_compile` / `node --check` + curl 冒烟 + 浏览器端到端验证。

## Capabilities and Constraints

- 模块：任务、笔记、习惯打卡、记账、健康记录、RSS 资讯（含 AI 摘要）、夸克网盘浏览、快捷入口、股票/理财/基金持仓（天天基金/东方财富免费接口）、全局搜索、AI 助手（智谱 GLM 服务端代理）。
- **硬性架构约束**：零构建、零 Node 依赖（不引入打包器/框架/模板引擎）——所有前端是原生 JS Hash-SPA + 单文件 CSS，后端是 server.py 单文件（FastAPI + SQLite WAL，schema-less JSON 存储）。
- 多用户：预设账号制，不开放注册；每个用户独立数据库文件（admin 用 workbench.db，其他用户 workbench_<用户名>.db），所有数据接口经 get_conn() 按当前用户路由。
- 数据安全：登录走 PBKDF2 + HttpOnly Cookie 会话（30 天），启动时自动备份各库到 backups/（每库每日一份，保留 7 份）。
- 免费数据源依赖：股票行情腾讯财经、基金净值天天基金、RSS 代理（有 SSRF 拦截与 2MB/20s 限制）、夸克网盘（用户 cookie 会话）。
- AI 能力：智谱 key 只在服务端，模型默认 glm-4.5-air（可用 ZHIPU_MODEL 覆盖）。

## Brand Commitments

- 名称：个人工作台（Personal Workbench）；中文界面。
- 产品名为中性工具名，无强视觉品牌承诺；视觉系统未固化，待整体打磨。
- 已确认的界面语言习惯：中文、涨红跌绿（A 股惯例）、表单校验用红框+抖动而非弹窗。

## Evidence on Hand

- AGENTS.md（架构与上线流程的权威文档，产品约束的主要来源）
- HELP.md（面向小白用户的功能手册，路由 #/help 直接渲染，需与用户可见功能同步）
- css/app.css（单文件 ~1400 行，CSS 变量 + data-theme 明暗主题）
- 真实数据源：腾讯财经、天天基金接口在生产可用。

## Product Principles

1. 一个入口管全部日常——聚合是核心价值，模块间可以互相跳转，不要做成孤立功能页。
2. 数据必须在自己手里——自托管与数据隔离不可妥协，免费第三方接口只是数据来源，不能成为依赖。
3. 轻到个人能长期维护——零构建、单文件后端、schema-less 存储是刻意选择，任何"更工程化"的诱惑都要先质疑。
4. 小范围熟人群体——预设账号、按用户隔离，不做开放注册和复杂权限体系。
5. 手机也要好用——PWA + 响应式是日常使用场景的一部分，不是附加项。

## Accessibility & Inclusion

- 明暗主题（CSS 变量 + data-theme，含自动/手动切换）是最低要求，继续保留。
- 用户为小范围熟人，无已确认的特殊无障碍需求；后续 UI 打磨需守住基础可访问性（对比度、可点击区域、键盘可达）。
