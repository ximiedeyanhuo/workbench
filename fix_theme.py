#!/usr/bin/env python3
"""把 [data-theme="dark"], [data-theme="midnight"] X 拆成两条独立规则。
X 是从 [data-theme="midnight"] 后到第一个 '{' 之前的所有字符。
完全保 X 不变 —— 不再有任何正则裁剪/重组。"""
import re, sys
p = 'css/app.css'
lines = open(p, encoding='utf-8').read().splitlines(keepends=True)
out = []
n = 0
# 匹配开头 [data-theme="dark"], [data-theme="midnight"] 后接空白，再接 X（任意非 { 字符）直到 {
pat = re.compile(r'^\[data-theme="dark"\], \[data-theme="midnight"\]\s+(\S[^{]*?)\s*\{')
for ln in lines:
    m = pat.match(ln)
    if m:
        x = m.group(1).rstrip()  # 整段选择器，去尾随空白
        # 保留 m.end() 之后的内容（即 { ... } 块体及其余）
        tail = ln[m.end()-1:]  # m.end()-1 是 '{' 位置
        out.append(f'[data-theme="dark"] {x}, [data-theme="midnight"] {x} {tail}')
        n += 1
    else:
        out.append(ln)
open(p, 'w', encoding='utf-8').writelines(out)
print(f'replaced {n}')
