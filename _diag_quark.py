import urllib.request, json, http.cookiejar

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

# Login
login_data = json.dumps({'username':'admin','password':'admin123'}).encode()
req = urllib.request.Request('http://localhost:8642/api/auth/login', data=login_data, headers={'Content-Type':'application/json'})
opener.open(req)

# quark/list - root
req2 = urllib.request.Request('http://localhost:8642/api/drive/quark/list', data=b'{}', headers={'Content-Type':'application/json'})
resp2 = opener.open(req2)
data = json.loads(resp2.read())
items = data.get('items', [])
dirs = [i for i in items if i.get('is_dir')]
files = [i for i in items if not i.get('is_dir')]
print('Root: %d dirs, %d files' % (len(dirs), len(files)))
for d in dirs[:5]:
    print('  DIR:', d['name'], 'fid:', d['fid'][:30])

# Enter first dir to find files
target_fid = None
target_name = None
if dirs:
    dir_fid = dirs[0]['fid']
    print('\nEntering dir:', dirs[0]['name'])
    req3 = urllib.request.Request('http://localhost:8642/api/drive/quark/list', data=json.dumps({'pdir_fid': dir_fid}).encode(), headers={'Content-Type':'application/json'})
    resp3 = opener.open(req3)
    data3 = json.loads(resp3.read())
    items3 = data3.get('items', [])
    files3 = [i for i in items3 if not i.get('is_dir')]
    print('  Files in subdir:', len(files3))
    img_exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
    imgs = [i for i in files3 if any(i.get('name','').lower().endswith(e) for e in img_exts)]
    print('  Image files:', len(imgs))
    if imgs:
        target_fid = imgs[0]['fid']
        target_name = imgs[0]['name']
    elif files3:
        target_fid = files3[0]['fid']
        target_name = files3[0]['name']
    
    # If no files in first dir, try other dirs
    if not target_fid:
        for d2 in dirs[1:4]:
            print('  Trying dir:', d2['name'])
            req4 = urllib.request.Request('http://localhost:8642/api/drive/quark/list', data=json.dumps({'pdir_fid': d2['fid']}).encode(), headers={'Content-Type':'application/json'})
            resp4 = opener.open(req4)
            data4 = json.loads(resp4.read())
            items4 = data4.get('items', [])
            files4 = [i for i in items4 if not i.get('is_dir')]
            imgs4 = [i for i in files4 if any(i.get('name','').lower().endswith(e) for e in img_exts)]
            if imgs4:
                target_fid = imgs4[0]['fid']
                target_name = imgs4[0]['name']
                break
            elif files4:
                target_fid = files4[0]['fid']
                target_name = files4[0]['name']
                break

if target_fid:
    print('\n=== TARGET FILE ===')
    print('Name:', target_name)
    print('FID:', target_fid[:40])
    
    # Test proxy endpoint
    print('\n=== TESTING PROXY ENDPOINT ===')
    proxy_url = 'http://localhost:8642/api/drive/quark/proxy?fid=' + urllib.request.quote(target_fid)
    req5 = urllib.request.Request(proxy_url)
    try:
        resp5 = opener.open(req5, timeout=30)
        print('Status:', resp5.status)
        print('Content-Type:', resp5.headers.get('Content-Type'))
        print('Content-Length:', resp5.headers.get('Content-Length'))
        chunk = resp5.read(1024)
        print('First bytes:', chunk[:50])
        print('PROXY WORKS!' if resp5.status == 200 else 'UNEXPECTED STATUS')
    except Exception as e:
        print('PROXY ERROR:', str(e)[:200])
        # Try to read error body
        if hasattr(e, 'read'):
            body = e.read().decode('utf-8', errors='replace')[:300]
            print('Error body:', body)
else:
    print('\nNo files found anywhere!')
    print('All root items:')
    for i in items:
        print('  ', 'DIR' if i.get('is_dir') else 'FILE', i['name'])
