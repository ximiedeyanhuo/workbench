"""
server.py — 个人工作台后端（FastAPI + SQLite）

职责：
  1. 静态托管前端页面（替代 python -m http.server，端口不变 8642）；
  2. 通用 CRUD API：/api/db/{store}[/{id}]，SQLite 每个 store 一张 (id, data) 表，
     数据本体是 JSON 文本，前端加字段后端永不用改；
  3. RSS 代理：/api/feed?url=…，服务端抓取绕开浏览器 CORS 限制；
  4. 一键迁移：/api/import，接收前端 exportAll 格式的全量数据覆盖入库。

启动：python server.py     （依赖：pip install fastapi uvicorn）
数据：同目录 workbench.db 单文件，备份 = 复制该文件。
"""

import base64
import contextvars
import hashlib
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
DB_FILE = BASE_DIR / "workbench.db"
BACKUP_DIR = BASE_DIR / "backups"
BACKUP_KEEP = 7  # 保留最近 7 份每日备份
HOST = "0.0.0.0"
PORT = 8642

# 与前端 db.js 的 ALL_STORES 保持一致；settings 的主键字段是 key，其余为 id
STORES = ("tasks", "notes", "bookmarks", "habits", "finance", "quicklinks", "settings", "feeds", "health", "stocks", "mockexams")

FEED_TIMEOUT = 20  # RSS 抓取超时（秒），公共 RSSHub 实例较慢，需给足余量
FEED_MAX_BYTES = 2 * 1024 * 1024  # 单个源最大 2MB，防异常大响应
FEED_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkbenchFeedReader/1.0"

# 智谱 AI：key 只在服务端读取（环境变量优先，其次项目根 zhipu.key 文件），不进库不进导出
ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
# 模型可用环境变量 ZHIPU_MODEL 覆盖；赠送额度期用 glm-4.5-air，额度用完可换回免费的 glm-4-flash
ZHIPU_MODEL = os.environ.get("ZHIPU_MODEL", "").strip() or "glm-4.5-air"
ZHIPU_KEY_FILE = BASE_DIR / "zhipu.key"
AI_TIMEOUT = 60  # 大模型接口响应较慢，超时给足

# Swagger 文档开在 /api/docs，避免被根路径静态托管遮挡；仅本机监听，无泄露风险
app = FastAPI(title="workbench", docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")

# ---------- 静态资源白名单 ----------
# 只放行前端所需的公开资源，防止敏感文件（sessions.json/users.json/zhipu.key/*.db/server.py 等）匿名下载
ALLOWED_STATIC = {"", "index.html", "sw.js", "manifest.json", "HELP.md", "icon-192.png", "icon-512.png", "css", "js", "lib"}


@app.middleware("http")
async def static_whitelist(request: Request, call_next):
    """非 /api 路径仅放行白名单中的第一段路径，其余全部 404"""
    path = request.url.path
    if not path.startswith("/api/"):
        first_segment = path.lstrip("/").split("/")[0]
        if first_segment not in ALLOWED_STATIC:
            return Response(status_code=404)
    return await call_next(request)


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    """静态资源强制协商缓存：避免浏览器启发式缓存拿到旧版 JS/CSS（本机 304 开销可忽略）"""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# ---------- 用户体系与会话 ----------
# 预设账号制（不开放注册）：users.json 存 PBKDF2 哈希；会话 token 存 sessions.json
# （重启不掉线），前端通过 HttpOnly Cookie 携带，JS 接触不到 token 本体。
# 数据隔离：admin 用历史 workbench.db，其他用户各自 workbench_<用户名>.db。
USERS_FILE = BASE_DIR / "users.json"
SESSIONS_FILE = BASE_DIR / "sessions.json"
LOGIN_FAILS_FILE = BASE_DIR / "login_fails.json"
SESSION_TTL = 30 * 24 * 3600  # 会话 30 天过期
PBKDF2_ITERS = 120_000
ADMIN_USER = "admin"
DEFAULT_ADMIN_PASSWORD = "admin123"  # 首次启动自动建 admin，务必登录后改密
COOKIE_NAME = "wb_token"
USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{2,20}$")  # 用户名直接拼库文件名，严格限字符
# 防暴力破解：同一用户名连错 5 次锁 60 秒
LOGIN_FAIL_MAX = 5
LOGIN_LOCK_SECONDS = 60

# 无需登录即可访问的 API（其余 /api/* 全部鉴权，静态页面不拦——登录遮罩在前端）
OPEN_API_PATHS = {"/api/ping", "/api/auth/login"}

# 当前请求的登录用户：鉴权中间件写入，get_conn 据此路由到对应库文件。
# Starlette 把同步端点扔进线程池时会复制 contextvars，线程内读得到。
CURRENT_USER: contextvars.ContextVar = contextvars.ContextVar("wb_user", default=None)

_auth_lock = threading.Lock()  # users/sessions/login_fails 文件读写互斥


def _load_json_file(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _save_json_file(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


USERS: dict = _load_json_file(USERS_FILE, {})
SESSIONS: dict = _load_json_file(SESSIONS_FILE, {})
_login_fails: dict = _load_json_file(LOGIN_FAILS_FILE, {})  # username -> {"count": int, "lock_until": ts}


def _save_login_fails() -> None:
    with _auth_lock:
        _save_json_file(LOGIN_FAILS_FILE, _login_fails)


def hash_password(password: str, salt_hex: str = None) -> tuple:
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERS)
    return salt.hex(), digest.hex()


def verify_password(password: str, user: dict) -> bool:
    _, digest = hash_password(password, user["salt"])
    return secrets.compare_digest(digest, user["hash"])


def save_users() -> None:
    with _auth_lock:
        _save_json_file(USERS_FILE, USERS)


def save_sessions() -> None:
    with _auth_lock:
        now = time.time()
        # 顺手清理过期会话，避免文件无限增长
        for t in [t for t, s in SESSIONS.items() if now - s.get("created", 0) > SESSION_TTL]:
            SESSIONS.pop(t, None)
        _save_json_file(SESSIONS_FILE, SESSIONS)


def ensure_default_admin() -> None:
    """首次启动无任何用户时自动建 admin，历史 workbench.db 归属 admin"""
    if USERS:
        return
    salt, digest = hash_password(DEFAULT_ADMIN_PASSWORD)
    USERS[ADMIN_USER] = {"salt": salt, "hash": digest, "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M")}
    save_users()
    print(f"!! 已创建默认管理员账号 {ADMIN_USER} / {DEFAULT_ADMIN_PASSWORD}，请登录后到设置页修改密码")


def session_user(request: Request):
    """从 Cookie 解析当前登录用户，无效/过期/用户已删返回 None"""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    sess = SESSIONS.get(token)
    if not sess or time.time() - sess.get("created", 0) > SESSION_TTL:
        return None
    username = sess.get("user")
    return username if username in USERS else None


def require_admin() -> None:
    if CURRENT_USER.get() != ADMIN_USER:
        raise HTTPException(status_code=403, detail="仅管理员可操作")


@app.middleware("http")
async def auth_guard(request: Request, call_next):
    """鉴权门禁：除白名单外的 /api/* 全部要求登录，并把用户名写入 contextvar"""
    path = request.url.path
    if path.startswith("/api/") and path not in OPEN_API_PATHS:
        user = session_user(request)
        if not user:
            return JSONResponse({"detail": "未登录"}, status_code=401)
        ctx_token = CURRENT_USER.set(user)
        try:
            return await call_next(request)
        finally:
            CURRENT_USER.reset(ctx_token)
    return await call_next(request)


# ---------- SQLite ----------
def db_file_for(user: str) -> Path:
    """数据隔离核心：admin 沿用历史 workbench.db，其他用户各自一个库文件"""
    return DB_FILE if user == ADMIN_USER else BASE_DIR / f"workbench_{user}.db"


_initialized_dbs: set = set()  # 已建过表的库，避免每次请求重复 CREATE


def get_conn() -> sqlite3.Connection:
    """每次请求独立连接（FastAPI 同步端点跑在线程池，连接不可跨线程共享），
    按当前登录用户路由到各自的库文件；新用户首次访问时懒建表"""
    user = CURRENT_USER.get() or ADMIN_USER
    path = db_file_for(user)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    if str(path) not in _initialized_dbs:
        for s in STORES:
            conn.execute(f'CREATE TABLE IF NOT EXISTS "{s}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
        conn.commit()
        _initialized_dbs.add(str(path))
    return conn


def init_db() -> None:
    with get_conn() as conn:
        for s in STORES:
            conn.execute(f'CREATE TABLE IF NOT EXISTS "{s}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)')


def auto_backup() -> None:
    """启动时自动备份所有用户库：每天每库最多一份（同日重启不重复），各保留最近 BACKUP_KEEP 份。
    用 SQLite 在线备份 API 而非直接复制文件：WAL 模式下未合并的日志也能进备份"""
    db_files = sorted(BASE_DIR.glob("workbench*.db"))
    if not db_files:
        return
    BACKUP_DIR.mkdir(exist_ok=True)
    for db_path in db_files:
        target = BACKUP_DIR / f"{db_path.stem}-{date.today().isoformat()}.db"
        if not target.exists():
            src = sqlite3.connect(db_path)
            dst = sqlite3.connect(target)
            try:
                with dst:
                    src.backup(dst)
            finally:
                src.close()
                dst.close()
            print(f"auto backup: {target.name}")
        # 滚动清理：文件名含日期，按名排序即按时间排序（注意 workbench-* 不会误匹配 workbench_xxx-*）
        for old in sorted(BACKUP_DIR.glob(f"{db_path.stem}-*.db"))[:-BACKUP_KEEP]:
            old.unlink()


def check_store(store: str) -> None:
    if store not in STORES:
        raise HTTPException(status_code=404, detail=f"unknown store: {store}")


def row_key(store: str, obj: dict) -> str:
    key = obj.get("key" if store == "settings" else "id")
    if key is None or str(key) == "":
        raise HTTPException(status_code=400, detail="object missing primary key")
    return str(key)


def json_text(obj: dict) -> str:
    """对象 -> JSON 文本；容错孤立代理项（如前端截断 emoji 产生的半个码点），
    避免 SQLite 写入时 UTF-8 编码失败导致 500"""
    return json.dumps(obj, ensure_ascii=False).encode("utf-8", "replace").decode("utf-8")


# ---------- 通用 CRUD ----------
@app.get("/api/ping")
def ping():
    return {"ok": True}


# ---------- 登录 / 会话 / 用户管理 ----------
@app.post("/api/auth/login")
async def auth_login(request: Request):
    """登录：body {username, password}，成功下发 HttpOnly Cookie（前端 JS 接触不到 token）"""
    payload = await request.json()
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    # 防暴力破解：连错 LOGIN_FAIL_MAX 次锁 LOGIN_LOCK_SECONDS 秒
    fail = _login_fails.get(username)
    if fail and fail.get("lock_until", 0) > time.time():
        raise HTTPException(status_code=429, detail="失败次数过多，请 1 分钟后重试")
    user = USERS.get(username)
    if not user or not verify_password(password, user):
        rec = _login_fails.setdefault(username, {"count": 0, "lock_until": 0})
        rec["count"] += 1
        if rec["count"] >= LOGIN_FAIL_MAX:
            rec["count"] = 0
            rec["lock_until"] = time.time() + LOGIN_LOCK_SECONDS
        _save_login_fails()  # 持久化失败计数
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    _login_fails.pop(username, None)
    _save_login_fails()  # 持久化清除计数
    token = secrets.token_urlsafe(32)
    SESSIONS[token] = {"user": username, "created": time.time()}
    save_sessions()
    resp = JSONResponse({"ok": True, "username": username, "isAdmin": username == ADMIN_USER})
    # 不设 Secure：局域网/公网 http 直连也能用；上 HTTPS 后可改 secure=True
    resp.set_cookie(COOKIE_NAME, token, max_age=SESSION_TTL, httponly=True, samesite="lax", path="/")
    return resp


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    token = request.cookies.get(COOKIE_NAME)
    if token and token in SESSIONS:
        SESSIONS.pop(token, None)
        save_sessions()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.get("/api/auth/me")
def auth_me():
    """当前登录用户；未登录时中间件直接回 401，前端据此弹登录遮罩"""
    user = CURRENT_USER.get()
    return {"username": user, "isAdmin": user == ADMIN_USER}


@app.post("/api/auth/password")
async def auth_change_password(request: Request):
    """修改自己的密码：body {oldPassword, newPassword}"""
    payload = await request.json()
    username = CURRENT_USER.get()
    user = USERS[username]
    if not verify_password(str(payload.get("oldPassword", "")), user):
        raise HTTPException(status_code=400, detail="原密码错误")
    new_pwd = str(payload.get("newPassword", ""))
    if len(new_pwd) < 6:
        raise HTTPException(status_code=400, detail="新密码至少 6 位")
    user["salt"], user["hash"] = hash_password(new_pwd)
    save_users()
    return {"ok": True}


@app.get("/api/auth/users")
def list_users():
    """管理员：用户列表（不回哈希）"""
    require_admin()
    return [
        {"username": name, "isAdmin": name == ADMIN_USER, "createdAt": u.get("createdAt", "")}
        for name, u in sorted(USERS.items())
    ]


@app.post("/api/auth/users")
async def create_user(request: Request):
    """管理员：新建用户 body {username, password}；库文件首次访问时懒创建"""
    require_admin()
    payload = await request.json()
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not USERNAME_RE.match(username):
        raise HTTPException(status_code=400, detail="用户名仅支持 2-20 位字母/数字/下划线/短横线")
    if username in USERS:
        raise HTTPException(status_code=400, detail="用户已存在")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    salt, digest = hash_password(password)
    USERS[username] = {"salt": salt, "hash": digest, "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M")}
    save_users()
    return {"ok": True}


@app.post("/api/auth/users/{username}/password")
async def reset_user_password(username: str, request: Request):
    """管理员：重置指定用户密码 body {password}"""
    require_admin()
    if username not in USERS:
        raise HTTPException(status_code=404, detail="用户不存在")
    payload = await request.json()
    password = str(payload.get("password", ""))
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    user = USERS[username]
    user["salt"], user["hash"] = hash_password(password)
    save_users()
    # 踢掉该用户已有会话，迫使用新密码重登
    for t in [t for t, s in SESSIONS.items() if s.get("user") == username]:
        SESSIONS.pop(t, None)
    save_sessions()
    return {"ok": True}


@app.delete("/api/auth/users/{username}")
def delete_user(username: str):
    """管理员：删除用户（admin 不可删）。库文件保留在磁盘上，需彻底清除手动删 workbench_<用户>.db"""
    require_admin()
    if username == ADMIN_USER:
        raise HTTPException(status_code=400, detail="不能删除管理员账号")
    if username not in USERS:
        raise HTTPException(status_code=404, detail="用户不存在")
    USERS.pop(username)
    save_users()
    for t in [t for t, s in SESSIONS.items() if s.get("user") == username]:
        SESSIONS.pop(t, None)
    save_sessions()
    return {"ok": True}


@app.get("/api/backup/status")
def backup_status():
    """设置页展示用：当前用户库最近一次自动备份的文件名与时间"""
    stem = db_file_for(CURRENT_USER.get() or ADMIN_USER).stem
    backups = sorted(BACKUP_DIR.glob(f"{stem}-*.db")) if BACKUP_DIR.exists() else []
    if not backups:
        return {"latest": None, "count": 0}
    latest = backups[-1]
    mtime = datetime.fromtimestamp(latest.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
    return {"latest": latest.name, "at": mtime, "count": len(backups)}


@app.get("/api/db/{store}")
def list_rows(store: str):
    check_store(store)
    with get_conn() as conn:
        rows = conn.execute(f'SELECT data FROM "{store}"').fetchall()
    return Response(content="[" + ",".join(r[0] for r in rows) + "]", media_type="application/json")


@app.get("/api/db/{store}/{item_id}")
def get_row(store: str, item_id: str):
    check_store(store)
    with get_conn() as conn:
        row = conn.execute(f'SELECT data FROM "{store}" WHERE id=?', (item_id,)).fetchone()
    return Response(content=row[0] if row else "null", media_type="application/json")


@app.put("/api/db/{store}/{item_id}")
async def put_row(store: str, item_id: str, request: Request):
    check_store(store)
    obj = await request.json()
    if not isinstance(obj, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    with get_conn() as conn:
        conn.execute(
            f'INSERT INTO "{store}" (id, data) VALUES (?, ?) '
            "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            (item_id, json_text(obj)),
        )
    return {"ok": True}


@app.delete("/api/db/{store}/{item_id}")
def delete_row(store: str, item_id: str):
    check_store(store)
    with get_conn() as conn:
        conn.execute(f'DELETE FROM "{store}" WHERE id=?', (item_id,))
    return {"ok": True}


@app.delete("/api/db/{store}")
def clear_rows(store: str):
    check_store(store)
    with get_conn() as conn:
        conn.execute(f'DELETE FROM "{store}"')
    return {"ok": True}


@app.post("/api/db/{store}/bulk")
async def bulk_put(store: str, request: Request):
    check_store(store)
    arr = await request.json()
    if not isinstance(arr, list):
        raise HTTPException(status_code=400, detail="body must be a JSON array")
    rows = [(row_key(store, o), json_text(o)) for o in arr if isinstance(o, dict)]
    with get_conn() as conn:
        conn.executemany(
            f'INSERT INTO "{store}" (id, data) VALUES (?, ?) '
            "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            rows,
        )
    return {"ok": True, "count": len(rows)}


# ---------- 一键迁移（前端 exportAll 格式，整体覆盖） ----------
@app.post("/api/import")
async def import_all(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict) or payload.get("app") != "workbench" or "data" not in payload:
        raise HTTPException(status_code=400, detail="备份数据格式不正确")
    data = payload["data"]
    with get_conn() as conn:  # 单事务：要么全部导入成功，要么保持原样
        for s in STORES:
            conn.execute(f'DELETE FROM "{s}"')
            arr = data.get(s) or []
            rows = [(row_key(s, o), json_text(o)) for o in arr if isinstance(o, dict)]
            if rows:
                conn.executemany(f'INSERT INTO "{s}" (id, data) VALUES (?, ?)', rows)
    return {"ok": True}


# ---------- RSS 代理 ----------
def assert_public_http_url(url: str) -> None:
    """仅放行公网 http/https，拒绝内网/本机地址（基础 SSRF 防护）"""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="仅支持 http/https 地址")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="域名无法解析")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(status_code=400, detail="不允许访问内网地址")


class _RedirectHandled(Exception):
    """自定义异常：捕获重定向目标 URL，供 safe_fetch 手动跟随"""
    def __init__(self, new_url: str):
        self.new_url = new_url


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """不自动跟随重定向；当遇到 301/302/303/307/308 时抛出 _RedirectHandled 异常"""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _RedirectHandled(newurl)


def safe_fetch(url: str, headers: dict, timeout: int, max_bytes: int) -> tuple:
    """带 SSRF 防护的 HTTP GET 请求，手动跟随重定向（最多 3 跳），每跳重新校验目标地址。
    返回 (raw_bytes, charset_from_header)"""
    current_url = url
    for _ in range(4):  # 原请求 + 最多 3 次重定向跟随
        assert_public_http_url(current_url)
        req = urllib.request.Request(current_url, headers=headers)
        try:
            opener = urllib.request.build_opener(_NoRedirectHandler)
            with opener.open(req, timeout=timeout) as res:
                raw = res.read(max_bytes)
                charset = res.headers.get_content_charset() or ""
                return raw, charset
        except _RedirectHandled as e:
            current_url = urllib.parse.urljoin(current_url, e.new_url)
            continue
    raise HTTPException(status_code=502, detail="重定向次数过多（超过 3 次）")


@app.get("/api/feed")
def feed_proxy(url: str):
    try:
        raw, charset = safe_fetch(url, {"User-Agent": FEED_UA, "Accept": "*/*"}, FEED_TIMEOUT, FEED_MAX_BYTES)
        if not charset:
            charset = "utf-8"
    except HTTPException:
        raise
    except Exception as exc:  # 统一转为 502，前端据此降级为「直达源站」
        raise HTTPException(status_code=502, detail=f"源站抓取失败: {exc}")
    return PlainTextResponse(content=raw.decode(charset, errors="replace"), media_type="application/xml; charset=utf-8")


# ---------- 公考专用解析器 ----------
# 华图、中公、公务员局 没有原生 RSS，RSSHub 路由也不稳定。
# 我们后端直接抓公告页 HTML，正则解析出条目，输出成 RSS 2.0 让前端复用同一解析路径。
import re
import html as _html

GOV_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"

# 每个源定义：入口 URL + 抽取条目的正则（返回 (link, title[, date]) 元组）
GOV_SOURCES = {
    "huatu-gg": {
        "name": "华图·招考公告",
        "url": "http://www.huatu.com/gwy/zhaokao/gg/",
        "base": "http://www.huatu.com",
        # 结构：<time> MM-DD</time><a href="http://xx.huatu.com/YYYY/MMDD/xxxxx.html">标题</a>
        # 从 URL 路径直接提取年月日，比 <time> 里的月-日更可靠（含年份）
        "pattern": re.compile(
            r'<a[^>]*href="(https?://[a-z]+\.huatu\.com/(\d{4})/(\d{4})/\d+\.html?)"[^>]*>([^<]{6,120})</a>',
            re.I,
        ),
        "kind": "huatu",
    },
    "offcn-gwy": {
        "name": "中公·公务员招考",
        "url": "https://www.offcn.com/gwy/",
        "base": "https://www.offcn.com",
        # 中公 URL 形如 //www.offcn.com/xxx/2026/0728/xxxx.html，日期含在路径里
        "pattern": re.compile(
            r'<a[^>]*href="(//www\.offcn\.com/[a-z]+/(\d{4})/(\d{4})/\d+\.html?)"[^>]*>([^<]{6,120})</a>',
            re.I,
        ),
        "kind": "offcn",
    },
}


def _fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": GOV_UA, "Accept-Language": "zh-CN,zh;q=0.9"})
    with urllib.request.urlopen(req, timeout=FEED_TIMEOUT) as res:
        raw = res.read(FEED_MAX_BYTES)
        charset = res.headers.get_content_charset() or "utf-8"
    return raw.decode(charset, errors="replace")


def _rss_escape(s: str) -> str:
    return _html.escape(s or "", quote=True)


def _build_rss(title: str, home: str, items: list) -> str:
    """items: [{title, link, date_iso}]"""
    entries = []
    for it in items[:40]:
        entries.append(
            "<item>"
            f"<title>{_rss_escape(it['title'])}</title>"
            f"<link>{_rss_escape(it['link'])}</link>"
            f"<guid isPermaLink=\"true\">{_rss_escape(it['link'])}</guid>"
            f"<pubDate>{_rss_escape(it.get('date_iso',''))}</pubDate>"
            "</item>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rss version="2.0"><channel>'
        f"<title>{_rss_escape(title)}</title>"
        f"<link>{_rss_escape(home)}</link>"
        f"<description>{_rss_escape(title)}</description>"
        + "".join(entries)
        + "</channel></rss>"
    )


@app.get("/api/gov-feed")
def gov_feed(source: str):
    """公考专用抓取：source 为 GOV_SOURCES 的 key（如 huatu-gg / offcn-gwy），
    后端抓 HTML 解析成 RSS 返回，前端 fetchFeed 走同一解析器。"""
    cfg = GOV_SOURCES.get(source)
    if not cfg:
        raise HTTPException(status_code=404, detail=f"未知公考源: {source}")
    try:
        html = _fetch_html(cfg["url"])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"源站抓取失败: {exc}")

    items = []
    seen = set()
    kind = cfg.get("kind")

    def _clean_title(s: str) -> str:
        s = _html.unescape(s).strip()
        # 部分站点会把 "标题：X作者：更新：日期" 拼在一起当锚文本，做一次清洗
        s = re.sub(r"^\s*标题[:：]\s*", "", s)
        s = re.sub(r"作者[:：].*$", "", s).strip()
        s = re.sub(r"更新[:：].*$", "", s).strip()
        return s

    if kind in ("offcn", "huatu"):
        # 两家结构相同：URL 路径含 /YYYY/MMDD/，直接从 URL 抽日期最稳
        for m in cfg["pattern"].finditer(html):
            path, y, md = m.group(1), m.group(2), m.group(3)
            title = _clean_title(m.group(4))
            link = "https:" + path if path.startswith("//") else path
            if link in seen or not title:
                continue
            seen.add(link)
            date_iso = f"{y}-{md[:2]}-{md[2:]}"
            try:
                dt = datetime.strptime(date_iso, "%Y-%m-%d")
                pub = dt.strftime("%a, %d %b %Y 00:00:00 +0800")
            except Exception:
                pub = ""
            items.append({"title": title, "link": link, "date_iso": pub})
    else:
        for m in cfg["pattern"].finditer(html):
            link, title, d = m.group(1), _clean_title(m.group(2)), m.group(3)
            if link in seen or not title:
                continue
            seen.add(link)
            d_norm = d.replace(".", "-").replace("/", "-")
            try:
                dt = datetime.strptime(d_norm, "%Y-%m-%d")
                pub = dt.strftime("%a, %d %b %Y 00:00:00 +0800")
            except Exception:
                pub = ""
            items.append({"title": title, "link": link, "date_iso": pub})

    # 按日期倒序（新在前），日期缺失的排最后
    items.sort(key=lambda it: it.get("date_iso", ""), reverse=True)

    xml = _build_rss(cfg["name"], cfg["url"], items)
    return PlainTextResponse(content=xml, media_type="application/xml; charset=utf-8")


# ---------- 网页标题抓取 ----------
# 收藏链接时自动填标题：前端粘贴 URL 后调此接口取 <title>。
# 字节级正则 + meta charset 探测：很多中文站响应头不声明编码，只在 meta 里写 gbk。
TITLE_RE = re.compile(rb"<title[^>]*>(.*?)</title>", re.I | re.S)
META_CHARSET_RE = re.compile(rb"charset\s*=\s*[\"']?([\w-]+)", re.I)


@app.get("/api/fetch-title")
def fetch_title(url: str):
    """抓网页标题：{ok, title}；只允许公网 http(s)，失败返 502。"""
    try:
        raw, charset = safe_fetch(url, {"User-Agent": GOV_UA, "Accept-Language": "zh-CN,zh;q=0.9"}, FEED_TIMEOUT, FEED_MAX_BYTES)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"抓取失败: {exc}")
    m = TITLE_RE.search(raw)
    if not m:
        return {"ok": False, "title": ""}
    if not charset:
        mc = META_CHARSET_RE.search(raw[:4096])
        charset = mc.group(1).decode("ascii", "ignore") if mc else "utf-8"
    try:
        title = m.group(1).decode(charset, errors="replace")
    except (LookupError, UnicodeError):
        title = m.group(1).decode("utf-8", errors="replace")
    title = _html.unescape(re.sub(r"\s+", " ", title)).strip()[:120]
    return {"ok": bool(title), "title": title}


# ---------- 股票行情代理 ----------
# 腾讯免费行情（GBK 编码）：后端代理绕开浏览器 CORS，解析成 JSON 供前端直用。
# 字段位置已实测确认（qt.gtimg.cn 返回用 ~ 分隔）：
#   [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [30]时间 [31]涨跌额 [32]涨跌幅% [33]最高 [34]最低
STOCK_TIMEOUT = 10
STOCK_CODES_RE = re.compile(r"^(?:sh|sz|bj)\d{6}(?:,(?:sh|sz|bj)\d{6}){0,49}$")  # 最多 50 只，防滥用


def _stock_fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": GOV_UA, "Referer": "https://gu.qq.com/"})
    with urllib.request.urlopen(req, timeout=STOCK_TIMEOUT) as res:
        return res.read(FEED_MAX_BYTES).decode("gbk", errors="replace")


@app.get("/api/stock/quote")
def stock_quote(codes: str):
    """批量行情：codes=sh600519,sz000858 → [{code,name,price,prevClose,open,high,low,change,pct,time}]"""
    codes = codes.strip().lower()
    if not STOCK_CODES_RE.match(codes):
        raise HTTPException(status_code=400, detail="codes 格式应为 sh/sz/bj + 6 位数字，逗号分隔，最多 50 只")
    try:
        text = _stock_fetch("https://qt.gtimg.cn/q=" + codes)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"行情抓取失败: {exc}")

    def num(s):
        try:
            return float(s)
        except (TypeError, ValueError):
            return 0.0

    out = []
    for line in text.split(";"):
        line = line.strip()
        m = re.match(r'^v_((?:sh|sz|bj)\d{6})="(.*)"$', line)
        if not m:
            continue
        p = m.group(2).split("~")
        if len(p) < 35 or not p[3]:  # 无效/停牌无价数据的代码直接跳过
            continue
        out.append({
            "code": m.group(1),
            "name": p[1],
            "price": num(p[3]),
            "prevClose": num(p[4]),
            "open": num(p[5]),
            "high": num(p[33]),
            "low": num(p[34]),
            "change": num(p[31]),
            "pct": num(p[32]),
            "time": p[30],
        })
    return out


@app.get("/api/stock/search")
def stock_search(q: str):
    """股票搜索（代码/名称/拼音）：腾讯 smartbox，UTF-8 查询 GBK 返回，
    每项格式 sh~600519~贵州茅台~gzmt~GP-A（实测确认），只回 A 股三市场条目"""
    q = q.strip()
    if not q or len(q) > 20:
        return []
    try:
        text = _stock_fetch("https://smartbox.gtimg.cn/s3/?v=2&t=all&c=1&q=" + urllib.parse.quote(q))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"搜索失败: {exc}")
    m = re.search(r'"(.*)"', text)
    if not m or m.group(1) == "N":
        return []
    out = []
    for item in m.group(1).split("^"):
        p = item.split("~")
        if len(p) >= 3 and p[0] in ("sh", "sz", "bj") and re.match(r"^\d{6}$", p[1]):
            name = p[2]
            # v=2 接口把中文名回成 \uXXXX 字面转义文本（实测），这里还原成真字符
            if re.search(r"\\u[0-9a-fA-F]{4}", name):
                try:
                    name = name.encode("latin-1", "ignore").decode("unicode_escape")
                except Exception:
                    pass
            out.append({"code": p[0] + p[1], "name": name, "kind": p[4] if len(p) > 4 else ""})
    return out[:10]


# ---------- 基金/理财净值代理 ----------
# 天天基金（东方财富）免费公开接口，净值每个交易日 16:00 后更新：
#   搜索: fundsuggest.eastmoney.com（UTF-8 返回）
#   历史净值: api.fund.eastmoney.com/f10/lsjz（需 Referer，一次返回最近 N 条日净值+日增长率）
FUND_CODES_RE = re.compile(r"^\d{6}(?:,\d{6}){0,19}$")  # 最多 20 只，防滥用


def _fund_fetch(url: str, referer: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": GOV_UA, "Referer": referer})
    with urllib.request.urlopen(req, timeout=STOCK_TIMEOUT) as res:
        return res.read(FEED_MAX_BYTES).decode("utf-8", errors="replace")


@app.get("/api/fund/search")
def fund_search(q: str):
    """基金搜索（代码/名称/拼音）：天天基金 fundsuggest，返回 [{code,name}]"""
    q = q.strip()
    if not q or len(q) > 20:
        return []
    try:
        text = _fund_fetch(
            "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=" + urllib.parse.quote(q),
            "https://fund.eastmoney.com/",
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"基金搜索失败: {exc}")
    try:
        data = json.loads(text)
        out = [
            {"code": d.get("CODE") or "", "name": d.get("NAME") or ""}
            for d in (data.get("Datas") or [])
            if re.match(r"^\d{6}$", d.get("CODE") or "")
        ]
    except (ValueError, AttributeError):
        out = []
    return out[:10]


@app.get("/api/fund/nav")
def fund_nav(codes: str):
    """基金最新净值：codes=023636,000198 → [{code,name,nav,navDate,prevNav,prevDate,pct}]
    每只基金取最近两条日净值（最新 + 前一日），当日收益由前端按份额计算；
    名称来自 fundgz 估算接口（jsonp 顺手带出，失败留空前端用记录名）"""
    codes = codes.strip()
    if not FUND_CODES_RE.match(codes):
        raise HTTPException(status_code=400, detail="codes 应为 6 位基金代码，逗号分隔，最多 20 只")
    out = []
    for code in codes.split(","):
        try:
            text = _fund_fetch(
                f"https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=2",
                "https://fundf10.eastmoney.com/",
            )
            data = json.loads(text)
            lst = ((data.get("Data") or {}).get("LSJZList") or [])
            if len(lst) < 2:
                continue  # 成立首日等无前日净值的情况跳过
            cur, prev = lst[0], lst[1]
            # 货币基金（FundType 005）接口口径不同：DWJZ 字段是「每万份收益」，净值恒 1；
            # 交给前端用 isMoney 区分计算（市值=份额，当日收益=万份收益×份额/10000）
            is_money = ((data.get("Data") or {}).get("SYType") or "").find("每万份收益") >= 0
            item = {
                "code": code,
                "name": "",
                "nav": float(cur.get("DWJZ") or 0),
                "navDate": cur.get("FSRQ") or "",
                "prevNav": float(prev.get("DWJZ") or 0),
                "prevDate": prev.get("FSRQ") or "",
                "pct": float(cur.get("JZZZL") or 0),
                "isMoney": is_money,
            }
            try:  # 名称：fundgz 估值接口 jsonp，拿不到就留空
                gz = _fund_fetch(f"https://fundgz.1234567.com.cn/js/{code}.js", "https://fund.eastmoney.com/")
                m = re.search(r'"name":"(.*?)"', gz)
                if m:
                    item["name"] = m.group(1)
            except Exception:
                pass
            out.append(item)
        except Exception:
            continue  # 单只失败不影响其余
    return out


# ---------- 智谱 AI 代理 ----------
def zhipu_api_key() -> str:
    """环境变量 ZHIPU_API_KEY 优先；其次项目根 zhipu.key 文件；都没有则返回空串"""
    key = os.environ.get("ZHIPU_API_KEY", "").strip()
    if not key and ZHIPU_KEY_FILE.exists():
        key = ZHIPU_KEY_FILE.read_text(encoding="utf-8").strip()
    return key


@app.get("/api/ai/status")
def ai_status():
    """前端据此决定 AI 按钮是否可用；只回是否已配置，绝不回 key 本身"""
    return {"configured": bool(zhipu_api_key()), "model": ZHIPU_MODEL}


@app.post("/api/ai/chat")
async def ai_chat(request: Request):
    """智谱 chat 代理：body {system, prompt, temperature?}，返回 {text}。
    同步 urllib 调用会阻塞事件循环，交给线程池执行（与 feed_proxy 的 def 路由同理）"""
    key = zhipu_api_key()
    if not key:
        raise HTTPException(status_code=503, detail="未配置智谱 API Key：设环境变量 ZHIPU_API_KEY 或在项目根创建 zhipu.key 文件后重启服务")
    payload = await request.json()
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt 不能为空")
    messages = []
    if payload.get("system"):
        messages.append({"role": "system", "content": str(payload["system"])})
    messages.append({"role": "user", "content": prompt})
    body = json.dumps({
        "model": ZHIPU_MODEL,
        "messages": messages,
        "temperature": float(payload.get("temperature", 0.3)),
    }).encode("utf-8")

    def call() -> str:
        req = urllib.request.Request(
            ZHIPU_URL, data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        )
        with urllib.request.urlopen(req, timeout=AI_TIMEOUT) as res:
            data = json.loads(res.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]

    try:
        text = await run_in_threadpool(call)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise HTTPException(status_code=502, detail=f"智谱接口返回 {exc.code}: {detail}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"智谱接口调用失败: {exc}")
    return {"text": text}


# ---------- 网盘聚合（多网盘统一接口）----------
# 各网盘配置存在 settings store 中，key 为 drive_夸克_cookie
# Cookie 方案：模拟浏览器调用网页版内部接口，不依赖官方开放 API

DRIVE_TIMEOUT = 30
DRIVE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def get_drive_config(drive: str) -> dict:
    """从 settings 读取指定网盘的配置"""
    with get_conn() as conn:
        row = conn.execute('SELECT data FROM "settings" WHERE id=?', (f"drive_{drive}_config",)).fetchone()
    if not row:
        return {}
    return json.loads(row[0])


def save_drive_config(drive: str, config: dict) -> None:
    """保存网盘配置到 settings"""
    obj = {"key": f"drive_{drive}_config", **config}
    with get_conn() as conn:
        conn.execute(
            f'INSERT INTO "settings" (id, data) VALUES (?, ?) '
            'ON CONFLICT(id) DO UPDATE SET data=excluded.data',
            (f"drive_{drive}_config", json.dumps(obj, ensure_ascii=False)),
        )


# ========== 夸克网盘 ==========
# 用真实 Chrome 浏览器 UA，减少被拦截概率
QUARK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0"
# 大文件下载限流（code=23018）时需切换 Electron 客户端 UA 重试
QUARK_UA_ELECTRON = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch"

def quark_api(endpoint: str, params=None, cookie=None, method="GET", body=None, ua=None, quiet=False):
    """调用夸克网盘内部接口（默认 GET，下载链接接口用 POST）"""
    url = f"https://drive-pc.quark.cn/1/clouddrive/{endpoint.lstrip('/')}"
    headers = {
        "User-Agent": ua or QUARK_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,en-GB;q=0.6",
        "Referer": "https://pan.quark.cn/",
        "Origin": "https://pan.quark.cn",
        "sec-ch-ua": '"Microsoft Edge";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "priority": "u=1, i",
    }
    if cookie:
        headers["Cookie"] = cookie

    # 拼接公共参数 + 业务参数
    query = {"pr": "ucpro", "fr": "pc", "uc_param_str": ""}
    if params:
        query.update(params)
    query_str = urllib.parse.urlencode(query)
    url = f"{url}?{query_str}"

    data = None
    if method == "POST" and body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(url, headers=headers, method=method, data=data)
    try:
        with urllib.request.urlopen(req, timeout=DRIVE_TIMEOUT) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # quiet 模式：把错误 body 当 JSON 返回（夸克限流 23018 走 HTTP 400，body 里带 code）
        if quiet:
            body_text = e.read().decode("utf-8", "ignore")
            try:
                return json.loads(body_text)
            except Exception:
                return {"code": e.code, "message": body_text[:200]}
        raise


@app.get("/api/drive/quark/status")
def quark_status():
    """检查夸克网盘是否已配置且有效"""
    cfg = get_drive_config("quark")
    cookie = cfg.get("cookie", "")
    if not cookie:
        return {"configured": False, "valid": False, "msg": "未配置 Cookie"}
    try:
        # 用根目录列表验证 Cookie 有效性（注意参数名前面有下划线！）
        data = quark_api("file/sort", {"pdir_fid": "0", "_page": 1, "_size": 1, "_fetch_total": 1, "_fetch_sub_dirs": 0, "_sort": "file_type:asc,updated_at:desc", "fetch_all_file": 1, "fetch_risk_file_name": 1}, cookie)
        if data.get("code") == 0:
            return {"configured": True, "valid": True, "nickname": data.get("nickname", "用户")}
        return {"configured": True, "valid": False, "msg": data.get("message", "Cookie 无效")}
    except Exception as e:
        return {"configured": True, "valid": False, "msg": str(e)[:80]}


@app.post("/api/drive/quark/list")
async def quark_list(request: Request):
    """列出指定目录下的文件"""
    cfg = get_drive_config("quark")
    cookie = cfg.get("cookie", "")
    if not cookie:
        raise HTTPException(status_code=400, detail="请先在设置页配置夸克网盘 Cookie")
    payload = await request.json()
    pdir_fid = payload.get("pdir_fid", "0")
    page = payload.get("page", 1)
    size = payload.get("size", 100)
    try:
        # 注意：夸克的分页参数是 _page/_size（前面有下划线！）
        data = quark_api("file/sort", {"pdir_fid": pdir_fid, "_page": page, "_size": size, "_fetch_total": 1, "_fetch_sub_dirs": 0, "_sort": "file_type:asc,updated_at:desc", "fetch_all_file": 1, "fetch_risk_file_name": 1}, cookie)
        if data.get("code") != 0:
            raise HTTPException(status_code=502, detail=data.get("message", "接口调用失败"))
        # 标准化返回格式
        items = []
        for item in data.get("data", {}).get("list", []):
            items.append({
                "fid": item.get("fid"),
                "name": item.get("file_name"),
                "is_dir": item.get("file_type") == 0,  # 0=目录，1=文件
                "size": item.get("size", 0),
                "size_str": item.get("size_format", ""),
                "modified": item.get("updated_at", ""),
                "parent_fid": pdir_fid,
            })
        return {"items": items, "current_path": pdir_fid, "total": data.get("data", {}).get("_count", 0)}
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise HTTPException(status_code=401, detail="Cookie 已过期，请重新获取")
        raise HTTPException(status_code=502, detail=f"HTTP {e.code}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/drive/quark/download")
async def quark_download(request: Request):
    """获取文件下载链接"""
    cfg = get_drive_config("quark")
    cookie = cfg.get("cookie", "")
    if not cookie:
        raise HTTPException(status_code=400, detail="请先配置 Cookie")
    payload = await request.json()
    fid = payload.get("fid", "")
    if not fid:
        raise HTTPException(status_code=400, detail="fid 不能为空")
    try:
        # 注意：夸克下载接口要求 body 传 {"fids": [数组]}，字段是复数 fids；放 query 或单数 fid 会返回 302
        data = quark_api("file/download", None, cookie, method="POST", body={"fids": [fid]}, quiet=True)
        # 大文件下载限流（code=23018）：切换 Electron 客户端 UA 重试一次
        if data.get("code") == 23018:
            data = quark_api("file/download", None, cookie, method="POST", body={"fids": [fid]}, ua=QUARK_UA_ELECTRON)
        if data.get("code") != 0:
            raise HTTPException(status_code=502, detail=data.get("message", "获取下载链接失败"))
        # 成功时 data 是数组，取第一个的 download_url
        dl = data.get("data") or []
        first = dl[0] if dl else {}
        if not first.get("download_url"):
            raise HTTPException(status_code=502, detail="下载链接为空")
        return {
            "download_url": first.get("download_url", ""),
            "file_name": first.get("file_name", "")
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/drive/quark/config")
async def quark_config_save(request: Request):
    """保存夸克网盘配置"""
    payload = await request.json()
    cookie = payload.get("cookie", "").strip()
    save_drive_config("quark", {"cookie": cookie})
    return {"ok": True}


# ========== 百度网盘 ==========

def format_size(size: int) -> str:
    """格式化文件大小，与前端 drive.js formatSize 一致"""
    if not size or size == 0:
        return "-"
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    if size < 1024 * 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MB"
    return f"{size / 1024 / 1024 / 1024:.1f} GB"


def baidu_headers(cookie: str) -> dict:
    """百度网盘 API 通用请求头"""
    return {
        "User-Agent": DRIVE_UA,
        "Cookie": cookie,
        "Referer": "https://pan.baidu.com/disk/home?",
    }


def baidu_sign(sign1: str, sign3: str) -> str:
    """百度网盘 sign 算法：类 RC4，用 sign3 作密钥对 sign1 加密后 base64"""
    # KSA —— 用 sign3 初始化 S-box
    key = [ord(sign3[i % len(sign3)]) for i in range(256)]
    S = list(range(256))
    j = 0
    for i in range(256):
        j = (j + S[i] + key[i]) % 256
        S[i], S[j] = S[j], S[i]
    # PRGA —— 加密 sign1
    i = j = 0
    result = []
    sign1_bytes = sign1.encode("utf-8")
    for byte in sign1_bytes:
        i = (i + 1) % 256
        j = (j + S[i]) % 256
        S[i], S[j] = S[j], S[i]
        k = S[(S[i] + S[j]) % 256]
        result.append(byte ^ k)
    return base64.b64encode(bytes(result)).decode("utf-8")


@app.get("/api/drive/baidu/status")
def baidu_status():
    """检查百度网盘是否已配置且有效"""
    cfg = get_drive_config("baidu")
    cookie = cfg.get("cookie", "")
    if not cookie:
        return {"configured": False, "valid": False, "msg": "未配置 Cookie"}
    try:
        req = urllib.request.Request(
            "https://pan.baidu.com/api/quota?app_id=250528&channel=chunlei&clienttype=0&web=1&checkexpire=1&checkfree=1",
            headers=baidu_headers(cookie),
        )
        with urllib.request.urlopen(req, timeout=DRIVE_TIMEOUT) as res:
            data = json.loads(res.read().decode("utf-8"))
        if data.get("errno") == 0:
            # 获取用户昵称
            try:
                req2 = urllib.request.Request(
                    "https://pan.baidu.com/api/user/getinfo?need_selfinfo=1",
                    headers=baidu_headers(cookie),
                )
                with urllib.request.urlopen(req2, timeout=DRIVE_TIMEOUT) as res2:
                    user_data = json.loads(res2.read().decode("utf-8"))
                records = user_data.get("records", [])
                nickname = records[0].get("netdisk_name") or records[0].get("baidu_name", "用户") if records else "用户"
            except Exception:
                nickname = "用户"
            return {"configured": True, "valid": True, "nickname": nickname}
        errno = data.get("errno")
        if errno == -6:
            return {"configured": True, "valid": False, "msg": "Cookie 已过期，请重新获取"}
        return {"configured": True, "valid": False, "msg": data.get("message", f"errno={errno}")}
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return {"configured": True, "valid": False, "msg": "Cookie 已过期，请重新获取"}
        # 百度对无效 cookie 常直接回 HTTP 400，body 里可能带 errno，尝试解析出更明确的错误
        try:
            body = json.loads(e.read().decode("utf-8", "ignore"))
            if body.get("errno") == -6:
                return {"configured": True, "valid": False, "msg": "Cookie 已过期，请重新获取"}
        except Exception:
            pass
        return {"configured": True, "valid": False, "msg": f"HTTP {e.code}"}
    except Exception as e:
        return {"configured": True, "valid": False, "msg": str(e)[:80]}


@app.post("/api/drive/baidu/list")
async def baidu_list(request: Request):
    """列出百度网盘指定目录下的文件"""
    cfg = get_drive_config("baidu")
    cookie = cfg.get("cookie", "")
    if not cookie:
        raise HTTPException(status_code=400, detail="请先在设置页配置百度网盘 Cookie")
    payload = await request.json()
    dir_path = payload.get("dir", "/")
    if not dir_path or dir_path == "0":
        dir_path = "/"
    try:
        params = {
            "dir": dir_path,
            "order": "name",
            "desc": "0",
            "num": "100",
            "page": "1",
            "web": "1",
            "app_id": "250528",
            "clienttype": "0",
            "channel": "chunlei",
            "showempty": "0",
            "t": str(int(time.time() * 1000)),
        }
        req = urllib.request.Request(
            f"https://pan.baidu.com/api/list?{urllib.parse.urlencode(params)}",
            headers=baidu_headers(cookie),
        )
        with urllib.request.urlopen(req, timeout=DRIVE_TIMEOUT) as res:
            data = json.loads(res.read().decode("utf-8"))
        if data.get("errno") != 0:
            errno = data.get("errno")
            if errno == -6:
                raise HTTPException(status_code=401, detail="Cookie 已过期，请重新获取")
            raise HTTPException(status_code=502, detail=data.get("message", f"errno={errno}"))
        items = []
        for item in data.get("list", []):
            items.append({
                "fid": item.get("path") if item.get("isdir") == 1 else str(item.get("fs_id", "")),
                "name": item.get("server_filename", ""),
                "is_dir": item.get("isdir") == 1,
                "size": item.get("size", 0),
                "size_str": format_size(item.get("size", 0)),
                "modified": item.get("server_mtime", 0),
                "parent_dir": dir_path,
                "path": item.get("path", ""),
            })
        return {"items": items, "current_path": dir_path, "total": len(items)}
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise HTTPException(status_code=401, detail="Cookie 已过期，请重新获取")
        raise HTTPException(status_code=502, detail=f"HTTP {e.code}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/drive/baidu/download")
async def baidu_download(request: Request):
    """获取百度网盘文件下载链接

    ⚠️ 该签名流程为逆向实现，未经真实 cookie 验证，可能随百度改版失效
    """
    cfg = get_drive_config("baidu")
    cookie = cfg.get("cookie", "")
    if not cookie:
        raise HTTPException(status_code=400, detail="请先配置 Cookie")
    payload = await request.json()
    fs_id = payload.get("fs_id", "")
    if not fs_id:
        raise HTTPException(status_code=400, detail="fs_id 不能为空")
    try:
        # Step 1: 获取 sign1, sign3, timestamp
        req1 = urllib.request.Request(
            "https://pan.baidu.com/api/gettemplatevariable?app_id=250528&channel=chunlei&clienttype=0&fields=%5B%22sign1%22%2C%22sign3%22%2C%22timestamp%22%5D&web=1",
            headers=baidu_headers(cookie),
        )
        with urllib.request.urlopen(req1, timeout=DRIVE_TIMEOUT) as res1:
            tmpl = json.loads(res1.read().decode("utf-8"))
        if tmpl.get("errno") != 0:
            raise HTTPException(status_code=502, detail=tmpl.get("message", "获取签名参数失败"))
        result = tmpl.get("result", {})
        sign1 = result.get("sign1", "")
        sign3 = result.get("sign3", "")
        timestamp = result.get("timestamp", "")
        if not sign1 or not sign3:
            raise HTTPException(status_code=502, detail="获取签名参数不完整")

        # Step 2: 计算 sign
        sign = baidu_sign(sign1, sign3)

        # Step 3: 获取 dlink
        req2 = urllib.request.Request(
            f"https://pan.baidu.com/api/download?type=dlink&sign={sign}&timestamp={timestamp}&fidlist=%5B{fs_id}%5D&app_id=250528&channel=chunlei&clienttype=0&web=1",
            headers=baidu_headers(cookie),
        )
        with urllib.request.urlopen(req2, timeout=DRIVE_TIMEOUT) as res2:
            dl_data = json.loads(res2.read().decode("utf-8"))
        if dl_data.get("errno") != 0:
            raise HTTPException(status_code=502, detail=dl_data.get("message", "获取下载链接失败"))
        dlink_list = dl_data.get("dlink", [])
        if not dlink_list or not dlink_list[0].get("dlink"):
            raise HTTPException(status_code=502, detail="下载链接为空")
        dlink_url = dlink_list[0].get("dlink")

        # Step 4: 跟随重定向（不自动跳转）获取真实下载地址
        class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        opener = urllib.request.build_opener(NoRedirectHandler)
        req3 = urllib.request.Request(
            dlink_url,
            headers={"User-Agent": "LogStatistic", "Cookie": cookie},
        )
        with opener.open(req3, timeout=DRIVE_TIMEOUT) as res3:
            real_url = res3.headers.get("Location", dlink_url)

        return {
            "download_url": real_url,
            "file_name": dlink_list[0].get("server_filename", ""),
        }
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise HTTPException(status_code=401, detail="Cookie 已过期，请重新获取")
        raise HTTPException(status_code=502, detail=f"HTTP {e.code}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/drive/baidu/thumbnail")
async def baidu_thumbnail(path: str = ""):
    """百度网盘缩略图：filemetas 拿 thumbs URL 后 302 重定向（缩略图域名无需鉴权，浏览器可直接加载）"""
    cfg = get_drive_config("baidu")
    cookie = cfg.get("cookie", "")
    if not cookie:
        raise HTTPException(status_code=400, detail="请先配置 Cookie")
    if not path:
        raise HTTPException(status_code=400, detail="path 不能为空")
    try:
        params = {
            "target": json.dumps([path], ensure_ascii=False),
            "dlink": "1", "web": "5", "origin": "dlna",
        }
        req = urllib.request.Request(
            f"https://pan.baidu.com/api/filemetas?{urllib.parse.urlencode(params)}",
            headers={"User-Agent": "netdisk;P2SP;3.0.0.8;netdisk;11.12.3;awsl;1000857f94914b0b0", "Cookie": cookie, "Referer": "https://pan.baidu.com/disk/home?"},
        )
        with urllib.request.urlopen(req, timeout=DRIVE_TIMEOUT) as res:
            data = json.loads(res.read().decode("utf-8"))
        if data.get("errno") != 0:
            raise HTTPException(status_code=502, detail=f"errno={data.get('errno')}")
        thumbs = (data.get("info") or [{}])[0].get("thumbs") or {}
        thumb_url = thumbs.get("url3") or thumbs.get("url2") or thumbs.get("url1") or thumbs.get("icon")
        if not thumb_url:
            raise HTTPException(status_code=502, detail="无缩略图")
        return RedirectResponse(thumb_url, status_code=302)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise HTTPException(status_code=401, detail="Cookie 已过期，请重新获取")
        raise HTTPException(status_code=502, detail=f"HTTP {e.code}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/drive/baidu/config")
async def baidu_config_save(request: Request):
    """保存百度网盘配置"""
    payload = await request.json()
    cookie = payload.get("cookie", "").strip()
    save_drive_config("baidu", {"cookie": cookie})
    return {"ok": True}


# ---------- 静态托管（必须在所有 API 路由之后 mount） ----------
app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="static")


if __name__ == "__main__":
    ensure_default_admin()
    init_db()
    auto_backup()
    print(f"workbench server: http://{HOST}:{PORT}  (用户数: {len(USERS)}, admin 库: {DB_FILE.name})")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
