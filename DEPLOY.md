# 个人工作台部署指南（VPS + 无域名）

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