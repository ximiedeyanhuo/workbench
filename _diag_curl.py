import urllib.request, json, http.cookiejar, sqlite3, subprocess

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

# Login
login_data = json.dumps({'username':'admin','password':'admin123'}).encode()
req = urllib.request.Request('http://localhost:8642/api/auth/login', data=login_data, headers={'Content-Type':'application/json'})
opener.open(req)

# Get download_url
fid = '66bdfc27b4bd486ebf0e45324e99d330'
dl_data = json.dumps({'fid': fid}).encode()
req2 = urllib.request.Request('http://localhost:8642/api/drive/quark/download', data=dl_data, headers={'Content-Type':'application/json'})
resp2 = opener.open(req2)
dl_resp = json.loads(resp2.read())
download_url = dl_resp.get('download_url', '')
print('FULL download_url:')
print(download_url)
print()

# Read cookie
conn = sqlite3.connect('workbench.db')
row = conn.execute("SELECT data FROM settings WHERE id='drive_quark_config'").fetchone()
cfg = json.loads(row[0])
cookie = cfg.get('cookie', '')

QUARK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0"

# Test with curl
print('=== CURL TEST (with Cookie+Referer+UA) ===')
result = subprocess.run([
    'curl.exe', '-s', '-o', 'NUL', '-w', '%{http_code}',
    '-H', 'User-Agent: ' + QUARK_UA,
    '-H', 'Cookie: ' + cookie,
    '-H', 'Referer: https://pan.quark.cn/',
    download_url
], capture_output=True, text=True, timeout=20)
print('curl status:', result.stdout)

# Test without any headers
print('\n=== CURL TEST (no headers) ===')
result2 = subprocess.run([
    'curl.exe', '-s', '-o', 'NUL', '-w', '%{http_code}',
    download_url
], capture_output=True, text=True, timeout=20)
print('curl status (no headers):', result2.stdout)

# Test with only Referer
print('\n=== CURL TEST (only Referer) ===')
result3 = subprocess.run([
    'curl.exe', '-s', '-o', 'NUL', '-w', '%{http_code}',
    '-H', 'Referer: https://pan.quark.cn/',
    download_url
], capture_output=True, text=True, timeout=20)
print('curl status (only Referer):', result3.stdout)

# Check auth_key timestamp
print('\n=== AUTH_KEY ANALYSIS ===')
import time
if 'auth_key=' in download_url:
    auth_key = download_url.split('auth_key=')[1].split('&')[0]
    print('auth_key:', auth_key[:80])
    # auth_key format: timestamp-rand-uid-md5hash
    parts = auth_key.split('-')
    if parts:
        try:
            ts = int(parts[0])
            now = int(time.time())
            print('auth_key timestamp:', ts)
            print('current timestamp:', now)
            print('diff (seconds):', ts - now)
            print('diff (hours):', round((ts - now) / 3600, 1))
            if ts > now:
                print('auth_key is STILL VALID (not expired)')
            else:
                print('auth_key EXPIRED!')
        except:
            print('could not parse timestamp from:', parts[0])
