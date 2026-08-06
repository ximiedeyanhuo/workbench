import urllib.request, json, http.cookiejar

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

# Login
login_data = json.dumps({'username':'admin','password':'admin123'}).encode()
req = urllib.request.Request('http://localhost:8642/api/auth/login', data=login_data, headers={'Content-Type':'application/json'})
opener.open(req)

# Get download response - check ALL fields
fid = '66bdfc27b4bd486ebf0e45324e99d330'
dl_data = json.dumps({'fid': fid}).encode()
req2 = urllib.request.Request('http://localhost:8642/api/drive/quark/download', data=dl_data, headers={'Content-Type':'application/json'})
resp2 = opener.open(req2)
dl_resp = json.loads(resp2.read())
print('=== download response keys ===')
for k, v in dl_resp.items():
    val = str(v)[:100] if v else 'EMPTY'
    print('  %s: %s' % (k, val))

# Now call quark file/download API directly to see raw response
import sqlite3
conn = sqlite3.connect('workbench.db')
row = conn.execute("SELECT data FROM settings WHERE id='drive_quark_config'").fetchone()
cfg = json.loads(row[0])
cookie = cfg.get('cookie', '')

QUARK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0"

# Raw quark API call
api_url = 'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str='
body = json.dumps({'fids': [fid]}).encode()
req3 = urllib.request.Request(api_url, data=body, headers={
    'Content-Type': 'application/json',
    'User-Agent': QUARK_UA,
    'Cookie': cookie,
    'Referer': 'https://pan.quark.cn/',
    'Origin': 'https://pan.quark.cn',
})
resp3 = opener.open(req3, timeout=15)
raw = json.loads(resp3.read())
print('\n=== raw quark API response ===')
print('code:', raw.get('code'))
print('message:', raw.get('message'))
data_list = raw.get('data', [])
if data_list:
    first = data_list[0]
    print('data[0] keys:', list(first.keys()))
    for k, v in first.items():
        val = str(v)[:120] if v else 'EMPTY'
        print('  %s: %s' % (k, val))
