# 个人工作台部署指南（VPS + 域名）

> **实际生产服务器参数（写死，不要猜）**：`root@111.228.27.161`，代码目录 `/data/app/workbench`，端口 8642。
> **访问地址**：域名 `https://workbench.duole.site`（推荐，走 HTTPS）；旧 IP `http://111.228.27.161` 仍保留 HTTP 直访兼容。
> **HTTPS**：certbot（Let's Encrypt）管理，证书 `/etc/letsencrypt/live/workbench.duole.site/`，`certbot.timer` 每天自动续期。nginx 配置在 `/etc/nginx/sites-enabled/workbench`（改前备份在 `/root/workbench.ngx.bak`）。IP 走 80、域名 80 端口 301 跳 443。
> 日常增量上线（改完代码后）走 **deploy.ps1** 或下方「日常上线」章节，**只传代码绝不传数据**；本指南其余章节是**首次部署/迁移**用。

## 0. 日常增量上线（每次改完代码）

### 方式 A：deploy.ps1（推荐，一条命令）

```powershell
# 项目根目录执行；自动完成：强制 git add/commit/push → SSH 免密检查 → scp 代码白名单 → HOST 改回 127.0.0.1 → 重启 → 状态验证
.\deploy.ps1 "提交说明"
# 若沙箱执行策略拦截脚本：
powershell -ExecutionPolicy Bypass -File deploy.ps1 "提交说明"
```

- 只传代码：`server.py/index.html/sw.js/manifest.json/icon-192.png/icon-512.png/HELP.md/js/css/lib`。
- **绝不传数据**：`workbench*.db/users.json/sessions.json/zhipu.key/backups`。
- 改了 js/css 必须升 `sw.js` 的 `CACHE = "workbench-vNN"` 版本号，否则用户浏览器走旧缓存。

### 方式 B：手动（等价命令）

```bash
# 1. 提交推送（remote 是 SSH over 443：ssh://git@ssh.github.com:443/...，别走 https 或 22 端口）
git add <改过的文件> && git commit -m "说明" && git push origin main

# 2. scp 代码（目标路径必须完整：/data/app/workbench/ + 相对路径）
scp js/app.js root@111.228.27.161:/data/app/workbench/js/app.js
# 改了 server.py 的话，scp 后必须改回 HOST=127.0.0.1（GNU sed 用 \x22 转义双引号，避开 PowerShell 破坏）：
ssh root@111.228.27.161 'sed -i "s/^HOST = .*$/HOST = \"127.0.0.1\"/" /data/app/workbench/server.py && grep ^HOST /data/app/workbench/server.py'

# 3. 重启 + 验证（sleep 2 再 curl，服务起得慢；远程验证走 127.0.0.1 回环）
ssh root@111.228.27.161 "systemctl restart workbench && sleep 2 && curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8642/"
# 再确认新代码真的上线（grep 特征字符串），只看 200 不够
ssh root@111.228.27.161 "curl -s http://127.0.0.1:8642/js/app.js | grep -c '新函数名'"
```

### 常见失败原因速查

| 症状 | 原因 | 解决 |
|------|------|------|
| git push 超时/失败 | remote 走了 https 或 22 端口 | remote 必须 `ssh.github.com:443`；推送写 `git push origin main` |
| 文件传到了错误位置/新目录 | scp 目标路径漏了 `workbench` 段或用反斜杠 | 必须完整 `root@111.228.27.161:/data/app/workbench/<相对路径>` |
| 服务监听全网口/反代失效 | server.py 的 HOST 被覆盖成 0.0.0.0 | 远程必须 `"127.0.0.1"`（deploy.ps1 自动处理，手动要自己 sed） |
| curl 报错/JSON 损坏 | PowerShell 里 `curl` 是 Invoke-WebRequest 别名 | 用 `curl.exe`；传 JSON 写临时文件 `--data "@file"` |
| 用户看到旧界面 | 改了 js/css 没升 sw.js CACHE 版本 | `CACHE = "workbench-vNN"` 递增 |
| 重启后 curl 失败 | 服务还没起来 | `sleep 2` 后再验证 |
| 浏览器测试"修复无效" | 测的是内存旧代码 | 注销 SW + 清 caches + `?nocache=<时间戳>` 硬导航 |
| 远程验证 200 但代码没生效 | 只看状态码不够 | 用 grep 确认新函数/新字符串在远程文件里 |

## 1. 上传代码到服务器

```bash
# scp 上传（从本地执行）
scp -r /path/to/workbench user@your-server-ip:/home/user/workbench

# 或 rsync（推荐，断点续传）
rsync -avz /path/to/workbench/ user@your-server-ip:/home/user/workbench/
```

> 数据一起带走：`workbench*.db`（admin 及各用户的库）、`users.json`（账号）、`zhipu.key`（AI）。
> `sessions.json` 可不带（大家重新登录即可），`backups/` 不用上传。

## 2. 服务器上安装依赖

```bash
ssh user@your-server-ip
cd /home/user/workbench

# 安装 Python 依赖
pip install fastapi uvicorn

# 验证
python -c "import fastapi; import uvicorn; print('ok')"
```

## 3. 配置环境变量

```bash
# 方案 A：环境变量（推荐）
export ZHIPU_API_KEY="your-key-here"

# 持久化到 ~/.bashrc
echo 'export ZHIPU_API_KEY="your-key-here"' >> ~/.bashrc

# 方案 B：zhipu.key 文件
echo "your-key-here" > /home/user/workbench/zhipu.key
```

## 4. 绑定地址

server.py 已默认绑定 `0.0.0.0`（全网口监听），无需修改。若想改端口，改 server.py 顶部的 `PORT` 常量。

## 5. 创建 systemd 服务（开机自启）

```bash
sudo tee /etc/systemd/system/workbench.service << 'EOF'
[Unit]
Description=Personal Workbench
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/home/user/workbench
Environment=ZHIPU_API_KEY=your-key-here
ExecStart=python /home/user/workbench/server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable workbench
sudo systemctl start workbench
sudo systemctl status workbench  # 检查状态
```

## 6. 安全防护

工作台已内置登录鉴权（预设账号 + 全接口 401 拦截 + 防爆破锁定），**可以直接暴露公网使用**。但纯 HTTP 下密码是明文传输，建议：

- 登录密码不要和其他网站复用；首次部署后立即改掉 admin 初始密码
- 有域名的话上 nginx + Let's Encrypt 免费 HTTPS（见方案 B，去掉其中的 auth_basic 两行即可，工作台自己的登录已够用）
- 追求零暴露可选 Tailscale（方案 A）或 SSH 隧道（方案 C）

### 方案 A：Tailscale（推荐，最省心）

创建免费的私有网络，只有你加入的设备能访问。

```bash
# 服务器安装 Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 本地电脑也安装 Tailscale，加入同一账号
# 然后通过 Tailscale 分配的 100.x.x.x IP 访问
# 此时 server.py 绑定 127.0.0.1 即可，不暴露到公网
```

### 方案 B：nginx 反向代理 + 密码认证（纯 IP 访问）

```bash
# 安装 nginx
sudo apt install nginx apache2-utils

# 创建密码
sudo htpasswd -c /etc/nginx/.htpasswd admin

# 配置 nginx
sudo tee /etc/nginx/sites-available/workbench << 'EOF'
server {
    listen 80;

    # 如果后面配了域名，改这里：
    # server_name your-domain.com;

    # 基础认证
    auth_basic "个人工作台";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:8642;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 限制上传大小（导入备份时用）
    client_max_body_size 10m;
}
EOF

sudo ln -s /etc/nginx/sites-available/workbench /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

### 方案 C：只监听本地 + SSH 隧道

不开任何端口到公网，通过 SSH 隧道访问：

```bash
# 本地执行（server.py 保持绑定 127.0.0.1）
ssh -L 8642:127.0.0.1:8642 user@your-server-ip -N

# 然后本地浏览器打开 http://127.0.0.1:8642
```

## 7. 防火墙放行

如果用 nginx 方案，需要放行 80 端口：

```bash
# 如果用 nginx 方案放行 80/443；直接暴露方案放行 8642
# 如果使用 ufw
sudo ufw allow 8642/tcp
sudo ufw allow 22/tcp  # SSH 别忘了
sudo ufw enable

# ❗ 腾讯云/阿里云还有一层控制台安全组，必须在控制台添加入站规则：TCP 8642（或 80）
```

## 8. 数据持久化

```bash
# 确认数据库文件在正确位置（admin 一个 + 每个用户各一个）
ls -la /home/user/workbench/workbench*.db

# 服务每次启动会自动备份全部库到 backups/（各留 7 份）；
# 长期不重启的服务器建议加 crontab 每天凌晨兼做一次：
crontab -e
# 添加一行：
0 3 * * * cd /home/user/workbench && for f in workbench*.db; do cp "$f" "backups/${f%.db}-$(date +\%Y\%m\%d).db"; done
```

## 9. 验收

```bash
# 检查服务状态
sudo systemctl status workbench

# 查看日志
sudo journalctl -u workbench -f -n 20

# 访问测试：http://your-server-ip
```

## 推荐方案总结

| 方案 | 安全性 | 复杂度 | 推荐场景 |
|------|--------|--------|----------|
| **直接暴露（内置登录）** | ⭐⭐⭐ | 最低 | 多人使用，快速上线 |
| **nginx + HTTPS** | ⭐⭐⭐⭐⭐ | 中 | 有域名，长期使用 |
| **Tailscale** | ⭐⭐⭐⭐⭐ | 低 | 仅自己/家人，设备少 |
| **SSH 隧道** | ⭐⭐⭐⭐⭐ | 中 | 临时使用，不想开端口 |

**快速上线推荐**：先直接暴露 8642 跑起来（已有登录鉴权），后续有域名再套 nginx + HTTPS。