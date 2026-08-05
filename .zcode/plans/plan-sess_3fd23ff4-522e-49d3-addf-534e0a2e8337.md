## 目标
给「入口(quicklinks)」模块增加可选「账号密码」字段：添加时可填，点击卡片时弹出浮层明文显示账号/密码并支持一键复制。

## 背景约束
- 零构建 PWA，纯 DOM 操作，无框架、无后端 schema 改动（quicklinks 是 schema-less JSON，直接加字段即可）。
- 浏览器同源策略下**无法自动填充**第三方网站登录框，只能帮存好 + 快速复制，已和用户确认采用「浮层显示 + 一键复制」交互。
- 存储采用明文（与 drive 的 cookie 一致），字段 `account`/`password` 保留在 quicklinks 记录 JSON。

## 改动文件：`js/links.js`（主要）+ `css/app.css`（浮层样式）+ `sw.js`（升版本号）

### 1. js/links.js
- **添加表单**（L32-43 的 `.row`）：在 URL 与颜色之间追加两个可选输入：
  - `<input id="qlAccount" placeholder="账号（可选）" …>`
  - `<input id="qlPass" type="password" placeholder="密码（可选）" …>`（type=password 防余光直读）
  - 表单布局可能需换行：原 `.row` 一行放不下，新增字段包进一个新的 `.row` 或让 account/pass 在一行。
- **addLink**（L51-61）：`put` 时带上 `account: 账号.trim() || undefined`、`password: 密码.value || undefined`（空则不留字段，避免污染）。
- **卡片渲染**（L16-30）：当条目有 account 或 password 时，卡片上显示一个「凭据」小标识（🔑 或小角标），点击可打开凭据浮层；无凭据的卡片维持原样（点击直接新标签打开）。
- **点击行为**：两种路径
  - 无账号密码：保持现状，`<a>` 直接新标签打开。
  - 有账号密码：点击先打开目标网站（新标签），同时弹出凭据浮层；或点击浮层触发——采用「点击卡片 → 新标签打开 + 弹浮层」。
- **凭据浮层**：新建函数 `showCred(link)`，动态插入 body：
  - 半透明遮罩 + 居中卡片，展示名称、账号、密码。
  - 账号、密码分别有「复制」按钮；密码默认 `type=text` 明文显示（用户已选明文显示），或加一个显隐切换。
  - 复制用兼容方案：优先 `navigator.clipboard.writeText`，否则 `execCommand('copy')` + 隐藏 textarea 兜底（http 部署下可靠）。
  - 关闭：右上角 ×、点击遮罩、ESC 键。
  - 复用 drive.js 的 modal 模式（body.insertAdjacentHTML + 遮罩 + ESC 关闭）。

### 2. css/app.css
- 新增浮层与凭据按钮样式（`.cred-modal`、`.cred-*`、复制按钮），保持现有明暗主题变量体系。注意 AGENTS.md 提示的 `{}` 配平与 `[hidden]` 兜底规则。

### 3. sw.js
- 升 `CACHE` 版本号（workbench-vNN），使改动的 js/css 走新缓存。

## 验证
1. `node --check js/links.js`。
2. 浏览器端到端：注销 SW + 清 caches + 带 `?nocache=` 硬导航；添加一个带账号密码的入口 → 卡片显示凭据标识 → 点击弹浮层 → 复制账号/密码 → 验证 toast；删除测试数据（ZT- 命名并清理）。
3. 同步更新 HELP.md 中入口模块的说明（若涉及用户可见功能）。

## 不做的事
- 不做自动填充（浏览器限制）。
- 不做编码/混淆（用户已确认明文，与 drive 一致）。
- 不新增编辑已有条目的 UI（超出本次需求）；如需可后续再加。