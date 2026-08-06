import urllib.request, json, http.cookiejar, sqlite3

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

# Login
login_data = json.dumps({'username':'admin','password':'admin123'}).encode()
req = urllib.request.Request('http://localhost:8642/api/auth/login', data=login_data, headers={'Content-Type':'application/json'})
opener.open(req)

# Get download_url via API
fid = '66bdfc27b4bd486ebf0e45324e99d330'
dl_data = json.dumps({'fid': fid}).encode()
req2 = urllib.request.Request('http://localhost:8642/api/drive/quark/download', data=dl_data, headers={'Content-Type':'application/json'})
resp2 = opener.open(req2)
dl_resp = json.loads(resp2.read())
download_url = dl_resp.get('download_url', '')
print('download_url:', download_url[:150])
print()

# Read quark cookie from DB
conn = sqlite3.connect('workbench.db')
row = conn.execute("SELECT data FROM settings WHERE id='drive_quark_config'").fetchone()
cfg = json.loads(row[0])
cookie = cfg.get('cookie', '')

# Test 1: No redirect, with Cookie+Referer+UA (Chrome UA)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
nr_opener = urllib.request.build_opener(NoRedirect)

QUARK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0"
QUARK_UA_ELECTRON = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch"

tests = [
    ("Chrome UA + Cookie + Referer", QUARK_UA, cookie, "https://pan.quark.cn/"),
    ("Electron UA + Cookie + Referer", QUARK_UA_ELECTRON, cookie, "https://pan.quark.cn/"),
    ("Chrome UA + Referer (no Cookie)", QUARK_UA, "", "https://pan.quark.cn/"),
    ("Chrome UA + Cookie (no Referer)", QUARK_UA, cookie, ""),
    ("Electron UA + Cookie (no Referer)", QUARK_UA_ELECTRON, cookie, ""),
]

for name, ua, ck, ref in tests:
    headers = {"User-Agent": ua}
    if ck: headers["Cookie"] = ck
    if ref: headers["Referer"] = ref
    req3 = urllib.request.Request(download_url, headers=headers)
    try:
        with nr_opener.open(req3, timeout=15) as r:
            print("[%s] status=%d Location=%s" % (name, r.status, r.headers.get('Location','')[:100]))
    except urllib.error.HTTPError as e:
        loc = e.headers.get('Location','')[:100] if e.headers else ''
        body = ''
        try: body = e.read().decode('utf-8','replace')[:150]
        except: pass
        print("[%s] HTTPError %d Location=%s body=%s" % (name, e.code, loc, body))
    except Exception as e:
        print("[%s] EXC: %s" % (name, str(e)[:100]))

# Test 2: Follow redirect WITH headers (use custom redirect handler that preserves headers)
print("\n=== FOLLOW REDIRECT WITH COOKIE+REFERER+UA ===")
class KeepHeadersRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Preserve all custom headers
        new_req = urllib.request.Request(newurl, 
            headers={
                "User-Agent": req.headers.get("User-agent", QUARK_UA),
                "Cookie": req.headers.get("Cookie", ""),
                "Referer": req.headers.get("Referer", ""),
            })
        return new_req

keep_opener = urllib.request.build_opener(KeepHeadersRedirect)
req4 = urllib.request.Request(download_url, headers={
    "User-Agent": QUARK_UA,
    "Cookie": cookie,
    "Referer": "https://pan.quark.cn/",
})
try:
    with keep_opener.open(req4, timeout=20) as r:
        ct = r.headers.get('Content-Type','')
        cl = r.headers.get('Content-Length','')
        chunk = r.read(64)
        print("Status: %d, CT: %s, CL: %s, head: %s" % (r.status, ct, cl, chunk[:30]))
except urllib.error.HTTPError as e:
    body = ''
    try: body = e.read().decode('utf-8','replace')[:200]
    except: pass
    print("HTTPError %d: %s" % (e.code, body))
except Exception as e:
    print("EXC:", str(e)[:200])
