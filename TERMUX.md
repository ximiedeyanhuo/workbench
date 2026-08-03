# Termux 部署指南（手机本地运行 + PWA 桌面安装）

## 1. 安装 Termux

**不要从 Google Play 下载**（版本太旧）。去 F-Droid 下载：

- 手机浏览器打开 https://f-droid.org/packages/com.termux/
- 下载 F-Droid App → 安装 → 在里面搜索 Termux → 安装
- 再装一个 Termux:API（保持后台用）

## 2. 安装 Python 和依赖

打开 Termux，依次执行：

```bash
pkg update && pkg upgrade -y
pkg install python git -y
pip install fastapi uvicorn
```

## 3. 把项目传到手机

有多种方式，选一个方便的：

**方式 A：微信/QQ 文件传输**
- 在电脑上把整个 `workbench` 文件夹压缩成 zip
- 发到微信/QQ，手机接收后放到 `内部存储/Download/`
- 在 Termux 里解压：

```bash
cd ~
cp /sdcard/Download/workbench.zip .
unzip workbench.zip
cd workbench
```

**方式 B：scp（同局域网）**
```bash
# 手机 Termux 先装 openssh
pkg install openssh -y
# 查看手机 IP
ip a
# 在电脑上执行
scp -r /path/to/workbench user@手机IP:/data/data/com.termux/files/home/
```

## 4. 修改 server.py 绑定地址

```bash
cd ~/workbench
# 编辑 server.py，找到这一行：
# HOST = "127.0.0.1"
# 改为：
# HOST = "0.0.0.0"
```

可以用 `sed` 快速改：

```bash
sed -i 's/HOST = "127.0.0.1"/HOST = "0.0.0.0"/' server.py
```

## 5. 配置智谱 AI Key（可选）

```bash
# 方案 A：环境变量
echo 'export ZHIPU_API_KEY="你的key"' >> ~/.bashrc
source ~/.bashrc

# 方案 B：zhipu.key 文件
echo "你的key" > ~/workbench/zhipu.key
```

## 6. 启动服务

```bash
cd ~/workbench
python server.py
```

看到 `workbench server: http://0.0.0.0:8642` 说明启动成功。

## 7. 保持后台运行

按 `Ctrl+C` 停止，然后重新启动并锁住：

```bash
# 安装 termux-api
pkg install termux-api -y

# 启动前加锁（防止息屏后断连）
termux-wake-lock
python server.py
```

如果想让它在后台安静运行，另开一个 Termux 会话（滑到左侧 → 新建会话）：

```bash
termux-wake-lock
cd ~/workbench && nohup python server.py > /tmp/wb.log 2>&1 &
```

停止服务：
```bash
kill $(pgrep -f "server.py")
```

## 8. 安装到手机桌面（PWA）

1. 手机 Chrome 打开 `http://localhost:8642`
2. 等待页面加载完成后，Chrome 底部会弹出提示条 **"添加到主屏幕"**
3. 点一下 → 确认名称 → 桌面生成图标
4. 如果没有弹出，点 Chrome 右上角菜单 → **"添加到主屏幕"**

以后点桌面图标就能全屏打开，没有地址栏，像原生 App 一样。

## 9. 开机自启（可选）

Termux 支持开机启动脚本，需要额外装 Termux:Boot：

```bash
pkg install termux-boot -y
```

在 `~/.termux/boot/` 目录下创建启动脚本：

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/workbench.sh << 'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd ~/workbench
nohup python server.py > /tmp/wb.log 2>&1 &
EOF
chmod +x ~/.termux/boot/workbench.sh
```

## 常用命令

```bash
# 启动
cd ~/workbench && python server.py

# 带锁屏保活启动
termux-wake-lock && cd ~/workbench && python server.py

# 后台静默启动
cd ~/workbench && nohup python server.py > /tmp/wb.log 2>&1 &

# 查看日志
cat /tmp/wb.log

# 停止服务
kill $(pgrep -f "server.py")

# 更新代码（重新上传后）
# 数据在 IndexedDB 里，跟代码没关系，直接替换文件重启即可
```