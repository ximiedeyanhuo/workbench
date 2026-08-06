import urllib.request, json, http.cookiejar, sqlite3

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

# Login
login_data = json.dumps({'username':'admin','password':'admin123'}).encode()
req = urllib.request.Request('http://localhost:8642/api/auth/login', data=login_data, headers={'Content-Type':'application/json'})
opener.open(req)

# Get quark cookie from DB
conn = sqlite3.connect('workbench.db')
row = conn.execute("SELECT data FROM settings WHERE id='drive_quark_config'").fetchone()
if not row:
    print("No quark config")
    exit()

cfg = json.loads(row[0])
quark_cookie = cfg.get('cookie', '')
print("Cookie length:", len(quark_cookie))

# Direct quark API: file/list
api_url = 'https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&uc_param_str='
params = 'pdir_fid=0&_page=1&_size=10&_sort=file_type:asc,updated_at:desc'
req3 = urllib.request.Request(api_url, data=params.encode(), headers={
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': quark_cookie,
    'User-Agent': 'Mozilla/5.0'
})
try:
    resp3 = opener.open(req3, timeout=15)
    raw = json.loads(resp3.read())
    print("file/list code:", raw.get('code'), "msg:", raw.get('message'))
    data_list = raw.get('data', {}).get('list', [])
    files = [f for f in data_list if not f.get('dir')]
    print("Files:", len(files))
    
    if not files:
        # Try root dirs
        dirs = [f for f in data_list if f.get('dir')]
        print("Dirs:", len(dirs))
        if dirs:
            # Enter first dir
            dir_fid = dirs[0]['fid']
            print("Entering dir:", dirs[0]['file_name'], "fid:", dir_fid)
            params2 = 'pdir_fid={}&_page=1&_size=50&_sort=file_type:asc,updated_at:desc'.format(dir_fid)
            req4 = urllib.request.Request(api_url, data=params2.encode(), headers={
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': quark_cookie,
                'User-Agent': 'Mozilla/5.0'
            })
            resp4 = opener.open(req4, timeout=15)
            raw2 = json.loads(resp4.read())
            data_list2 = raw2.get('data', {}).get('list', [])
            files = [f for f in data_list2 if not f.get('dir')]
            print("Files in subdir:", len(files))
    
    if files:
        # Pick first image-like file
        img_exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
        img = next((f for f in files if any(f.get('file_name','').lower().endswith(e) for e in img_exts)), files[0])
        fid = img['fid']
        print("\n=== Testing file:", img['file_name'], "fid:", fid[:30])
        print("All keys:", list(img.keys()))
        
        # Download API
        dl_url = 'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str='
        dl_body = json.dumps({'fids': [fid]}).encode()
        req5 = urllib.request.Request(dl_url, data=dl_body, headers={
            'Content-Type': 'application/json',
            'Cookie': quark_cookie,
            'User-Agent': 'Mozilla/5.0'
        })
        resp5 = opener.open(req5, timeout=15)
        dl_raw = json.loads(resp5.read())
        print("\n=== DOWNLOAD RESPONSE ===")
        print("code:", dl_raw.get('code'), "msg:", dl_raw.get('message'))
        dl_data = dl_raw.get('data', [])
        if isinstance(dl_data, list) and dl_data:
            first_dl = dl_data[0]
        elif isinstance(dl_data, dict):
            first_dl = dl_data
        else:
            first_dl = {}
        
        if isinstance(first_dl, dict):
            for k, v in first_dl.items():
                val = str(v)[:80] if v else 'EMPTY'
                print("  ", k, ":", val)
            
            # Check preview_url specifically
            preview = first_dl.get('preview_url', '')
            download = first_dl.get('download_url', '')
            print("\n=== KEY TEST ===")
            print("download_url present:", bool(download))
            print("preview_url present:", bool(preview))
            
            if preview:
                print("preview_url:", preview[:120])
                # Test if preview_url is accessible
                req6 = urllib.request.Request(preview)
                try:
                    resp6 = opener.open(req6, timeout=10)
                    print("preview_url accessible: YES, status:", resp6.status, "ct:", resp6.headers.get('Content-Type'))
                except Exception as e:
                    print("preview_url accessible: NO,", str(e)[:80])
            else:
                print("preview_url is MISSING from API response!")
                print("Available keys:", list(first_dl.keys()))
        else:
            print("No data in download response")
            print("Raw:", json.dumps(dl_raw, ensure_ascii=False)[:300])
    else:
        print("No files found anywhere")
except Exception as e:
    print("Error:", str(e)[:200])
