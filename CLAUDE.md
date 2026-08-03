# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

个人工作台 (Personal Workbench) — 自托管的个人效率仪表盘，集成了任务管理、笔记、习惯打卡、财务追踪、RSS 资讯阅读、健康记录、快捷入口等功能。

- **端口**: 8642
- **启动**: `python server.py`（依赖: `pip install fastapi uvicorn`）
- **数据文件**: `workbench.db`（SQLite 单文件）
- **启动脚本**: 双击 `启动工作台.bat`（Windows）

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python FastAPI + SQLite (WAL mode) |
| 前端 | 原生 JS（无框架），Hash-based SPA 路由 |
| 图表 | Chart.js (`lib/chart.umd.min.js`) |
| Markdown | `lib/md.js` |
| AI | 智谱 API (`glm-4.5-air`)，经后端代理 |

## 项目结构

```
workbench/
├── server.py          # FastAPI 后端（静态托管 + CRUD API + RSS代理 + AI代理）
├── index.html         # SPA 入口 shell（含 PWA manifest + Service Worker 注册）
├── manifest.json      # PWA 清单（可安装到手机桌面）
├── sw.js              # Service Worker（静态资源缓存，离线可用）
├── icon-192.png       # PWA 图标 192x192
├── icon-512.png       # PWA 图标 512x512
├── workbench.db       # SQLite 数据文件（自动生成）
├── zhipu.key          # 智谱 API Key（可选，环境变量 ZHIPU_API_KEY 优先）
├── 启动工作台.bat     # Windows 一键启动脚本
├── css/
│   └── app.css        # 完整样式（明暗主题变量）
├── js/
│   ├── db.js          # 数据层：Repository 模式（后端 API / IndexedDB 回退）
│   ├── app.js         # 路由、主题、全局搜索、仪表盘、设置页
│   ├── tasks.js       # 事务追踪（列表 + 月历视图）
│   ├── notes.js       # 笔记（Markdown 编辑/预览）+ 链接收藏
│   ├── life.js        # 习惯打卡（热力图）+ 财务 + 健康记录
│   ├── news.js        # RSS 资讯中心（6 分类、已读/收藏、AI 精选）
│   └── links.js       # 快捷入口（卡片面板，可排序）
├── lib/
│   ├── chart.umd.min.js  # Chart.js
│   └── md.js             # Markdown 解析器
├── backups/           # 自动备份目录（服务启动时生成，保留最近 7 份）
└── .workbuddy/
    └── memory/        # 工作记忆
```

## 架构要点

### 数据层（db.js）

Repository 模式，所有业务模块通过 `WB.repo(store)` 访问数据，接口统一为 `list/get/put/delete/clear/bulkPut`。

- `USE_API = true`（默认）：走后端 FastAPI + SQLite
- `USE_API = false`：纯浏览器 IndexedDB 模式（无后端也能用）
- 数据存储：SQLite 每个 store 一张 `(id TEXT PK, data TEXT)` 表，data 为 JSON 文本
- settings store 的主键为 `key`，其余为 `id`
- 前端 `STORES` 列表：tasks, notes, bookmarks, habits, finance, quicklinks, settings
- feeds 和 health 各自独立 IndexedDB 数据库（避免版本升级冲突）

### 后端 API（server.py）

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/db/{store}` | GET | 列出 store 全部记录 |
| `/api/db/{store}/{id}` | GET/PUT/DELETE | 单条记录 CRUD |
| `/api/db/{store}` | DELETE | 清空 store |
| `/api/db/{store}/bulk` | POST | 批量写入 |
| `/api/import` | POST | 全量数据导入（exportAll 格式） |
| `/api/feed?url=` | GET | RSS 代理（带 SSRF 防护） |
| `/api/ai/chat` | POST | 智谱 AI 代理（前端不接触 key） |
| `/api/ai/status` | GET | AI 配置状态查询 |
| `/api/backup/status` | GET | 备份状态查询 |
| `/api/docs` | GET | Swagger 文档 |

### 前端路由

Hash-based SPA 路由，注册在 `WB.routes`，每个路由实现 `{title, render(el)}` 接口：

- `#/dashboard` — 仪表盘
- `#/tasks` — 事务（列表/日历视图）
- `#/notes` — 笔记 + 链接收藏
- `#/life` — 生活（习惯/财务/健康）
- `#/news` — 资讯（RSS 阅读器，6 分类）
- `#/links` — 快捷入口
- `#/settings` — 设置

### 全局搜索

`WB.jump` 对象实现跨模块跳转：搜索命中后在 `WB.jump` 中写入目标 ID，切换 hash 后目标路由读取并消费该句柄。

### AI 集成

- 智谱 API Key 仅存在服务端（环境变量 `ZHIPU_API_KEY` 或 `zhipu.key` 文件）
- 模型默认为 `glm-4.5-air`，可通过环境变量 `ZHIPU_MODEL` 覆盖
- 三个 AI 功能：任务拆解、笔记摘要、每日精选

## 关键约定

- 数据层的 JSON 序列化使用 `json_text()` 函数，容错孤立代理项（emoji 截断场景）
- RSS 抓取有 SSRF 防护（`assert_public_http_url`），拒绝内网地址
- 已读状态持久化在 settings store 的 `newsRead` 记录中，保留最近 500 条
- 资讯源删除预置源时记入 `settings.newsRemovedUrls`，防止增量补种时被加回
- 备份逻辑：启动时自动备份 `workbench.db` 到 `backups/` 目录，保留最近 7 份
- 前端表单校验用 `flashInvalid()` 函数，抖动红框 + focus