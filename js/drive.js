/**
 * drive.js — 网盘聚合：夸克/百度网盘统一浏览
 */
(function () {
  "use strict";

  // 从 WB 命名空间解构需要的工具函数
  const { routes, repo, esc, debounce } = window.WB;

  // 当前路径历史
  const pathHistory = ["0"];
  let currentPathIndex = 0;

  // ========== 夸克网盘 API 封装
  const Drive = {};
  let currentDrive = "quark";
  Drive.quark = {
    async status() {
      const res = await fetch("/api/drive/quark/status");
      return res.json();
    },
    async list(pdirFid = "0") {
      const res = await fetch("/api/drive/quark/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdir_fid: pdirFid, page: 1, size: 200 }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async getDownloadUrl(fid) {
      const res = await fetch("/api/drive/quark/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fid: fid }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async saveConfig(cookie) {
      const res = await fetch("/api/drive/quark/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookie }),
      });
      return res.json();
    },
  };

  // ========== 百度网盘 API 封装
  Drive.baidu = {
    async status() {
      const res = await fetch("/api/drive/baidu/status");
      return res.json();
    },
    async list(dir = "/") {
      const res = await fetch("/api/drive/baidu/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: dir }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async getDownloadUrl(fsId) {
      const res = await fetch("/api/drive/baidu/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fs_id: fsId }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    async saveConfig(cookie) {
      const res = await fetch("/api/drive/baidu/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookie }),
      });
      return res.json();
    },
  };

  // ========== 通用工具函数
  function formatSize(bytes) {
    if (!bytes || bytes === 0) return "-";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  function formatDate(ts) {
    if (!ts) return "-";
    const d = new Date(ts * 1000);
    return d.toLocaleDateString("zh-CN");
  }

  // 根据文件扩展名返回类型（用于预览判断）
  function getFileType(name) {
    const ext = name.split(".").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].indexOf(ext) >= 0) return "image";
    if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v"].indexOf(ext) >= 0) return "video";
    if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].indexOf(ext) >= 0) return "audio";
    if (["pdf"].indexOf(ext) >= 0) return "pdf";
    return "unknown";
  }

  function getFileIcon(name) {
    const ext = name.split(".").pop().toLowerCase();

    if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].indexOf(ext) >= 0) return "🖼️";
    if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v"].indexOf(ext) >= 0) return "🎬";
    if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].indexOf(ext) >= 0) return "🎵";
    if (["pdf"].indexOf(ext) >= 0) return "📕";
    if (["doc", "docx", "docm"].indexOf(ext) >= 0) return "📘";
    if (["xls", "xlsx", "xlsm", "xlsb"].indexOf(ext) >= 0) return "📗";
    if (["ppt", "pptx", "pptm"].indexOf(ext) >= 0) return "📙";
    if (["zip", "rar", "7z", "tar", "gz"].indexOf(ext) >= 0) return "📦";
    return "📄";
  }

  // ========== 网盘选择卡片渲染
  function renderDriveCard(drive) {
    const status = drive.status || {};
    return `
    <div class="drive-card" data-drive="${drive.key}" onclick="window.WB.drive.enter('${drive.key}')">
      <div class="drive-icon">${drive.icon}</div>
      <div class="drive-info">
        <div class="drive-name">${drive.name}</div>
        <div class="drive-status ${status.valid ? "online" : "offline"}">
          ${status.configured ? (status.valid ? "✓ 已连接" : "⚠️ 配置无效") : "○ 未配置"}
        </div>
      </div>
      <div class="drive-arrow">›</div>
    </div>`;
  }

  // ========== 文件列表渲染
  function renderFileList(items, drive) {
    if (!items || items.length === 0) {
      return `<div class="empty" style="cursor:pointer;" onclick="window.WB.drive.goBack()">目录为空<br><span style="font-size:12px;color:var(--muted);">点击返回上一级</span></div>`;
    }
    // 文件夹在前，按名称排序
    const sorted = items.slice().sort(function (a, b) {
      // 目录优先于文件
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      // 同级按名称排序
      return a.name.localeCompare(b.name, "zh-CN");
    });

    let html = '<div class="file-list">';

    // 非根目录时，显示「..」返回项
    if (currentPathIndex > 0) {
      html += `
      <div class="file-item dir" style="opacity:0.6;" onclick="window.WB.drive.goBack()">
        <div class="file-icon">⬆️</div>
        <div class="file-info">
          <div class="file-name">返回上一级</div>
          <div class="file-meta">点击返回上级目录</div>
        </div>
      </div>`;
    }

    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      // 可预览的文件类型（图片/视频/PDF）单独提供预览按钮
      const ft = item.is_dir ? "" : getFileType(item.name);
      const previewable = ft === "image" || ft === "video" || ft === "pdf";
      html += `
      <div class="file-item ${item.is_dir ? "dir" : "file"}"
           data-fid="${esc(item.fid)}"
           data-is-dir="${item.is_dir}"
           onclick="window.WB.drive.openItem('${drive}', '${esc(item.fid)}', ${item.is_dir}, '${esc(item.name)}')">
        <div class="file-icon">${item.is_dir ? "📁" : getFileIcon(item.name)}</div>
        <div class="file-info">
          <div class="file-name">${esc(item.name)}</div>
          <div class="file-meta">
            ${item.is_dir ? "文件夹" : formatSize(item.size)}
            <span class="file-date">${formatDate(item.modified)}</span>
          </div>
        </div>
        ${previewable ? `<button class="file-preview-btn" title="预览" onclick="event.stopPropagation(); window.WB.drive.preview('${drive}', '${esc(item.fid)}', '${esc(item.name)}', '${esc(item.path || '')}')">👁 预览</button>` : ""}
      </div>`;
    }
    html += "</div>";
    return html;
  }

  // 存储路径名称（fid -> 文件夹名）
  const pathNames = { "0": "根目录" };

  // ========== 路径导航渲染
  function renderBreadcrumb() {
    let html = '<div class="breadcrumb">';
    for (let i = 0; i <= currentPathIndex; i++) {
      const fid = pathHistory[i];
      const name = pathNames[fid] || `第${i}层`;
      if (i > 0) html += '<span class="crumb-sep">/</span>';
      if (i === currentPathIndex) {
        html += `<span class="crumb current">${esc(name)}</span>`;
      } else {
        html += `<span class="crumb" onclick="window.WB.drive.jumpToPath(${i})">${esc(name)}</span>`;
      }
    }
    html += '</div>';
    return html;
  }

  // ========== 跳转到指定层级
  async function jumpToPath(index) {
    if (index < 0 || index >= currentPathIndex) return;
    const driveKey = currentDrive;
    try {
      currentPathIndex = index;
      const fid = pathHistory[index];
      const data = await Drive[driveKey].list(fid);
      const content = document.getElementById("browserContent");
      const pathEl = document.querySelector(".browser-path");
      if (content) content.innerHTML = renderFileList(data.items, driveKey);
      if (pathEl) pathEl.innerHTML = renderBreadcrumb(driveKey);
    } catch (e) {
      window.WB.showToast("跳转失败：" + e.message, "error");
    }
  }

  // ========== 加载网盘状态列表
  async function loadDriveStatus() {
    const grid = document.getElementById("driveGrid");
    if (!grid) return;

    const hideLoading = window.WB.showLoading("正在连接网盘...");
    try {
      const [quarkStatus, baiduStatus] = await Promise.all([
        Drive.quark.status(),
        Drive.baidu.status(),
      ]);
      const drives = [
        { key: "quark", name: "夸克网盘", icon: "🟡", status: quarkStatus },
        { key: "baidu", name: "百度网盘", icon: "🔵", status: baiduStatus },
      ];
      let html = "";
      for (let i = 0; i < drives.length; i++) {
        html += renderDriveCard(drives[i]);
      }
      grid.innerHTML = html;
      hideLoading();
    } catch (e) {
      hideLoading();
      window.WB.showToast("网盘状态加载失败：" + e.message, "error");
      grid.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    }
  }

// ========== 路由注册
  routes.drive = {
    title: "网盘",
    async render(el) {
      // 最简化测试
      el.innerHTML = '<div class="card"><div class="empty">网盘加载中...</div></div>';

      if (!window.WB.USE_API) {
        el.innerHTML = `
        <div class="card">
          <div class="empty">
            ⚠️ 网盘功能需要在线模式<br />
            <button class="btn" onclick="location.hash='#/settings'">去设置</button>
          </div>
        </div>`;
        return;
      }

      el.innerHTML = `
      <div class="drive-container">
        <div class="drive-header">
          <h2>我的网盘</h2>
          <div style="display: flex; gap: 8px; align-items: center;">
            <input type="text" id="driveSearchInput" placeholder="搜索文件..." style="width: 220px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); font-size: 13px; background: var(--card); color: var(--ink);" />
            <button class="btn sm" onclick="window.WB.drive.refreshAll()">刷新状态</button>
          </div>
        </div>
        <div class="drive-grid" id="driveGrid">
          <div class="empty">加载中…</div>
        </div>
      </div>`;

      await loadDriveStatus();
    },
  };

  // ========== 搜索当前目录的文件
  function searchFiles(keyword) {
    const content = document.getElementById("browserContent");
    if (!content) return; // 不在文件浏览页，只在网盘列表页搜索不做处理

    const items = window.WB.drive._currentItems || [];
    keyword = keyword.trim().toLowerCase();

    if (!keyword) {
      // 清空搜索，显示全部
      content.innerHTML = renderFileList(items, currentDrive);
      return;
    }

    // 过滤匹配的文件
    const filtered = items.filter(function(item) {
      return item.name.toLowerCase().indexOf(keyword) >= 0;
    });

    if (filtered.length === 0) {
      content.innerHTML = `<div class="empty">未找到包含 "${esc(keyword)}" 的文件</div>`;
    } else {
      content.innerHTML = renderFileList(filtered, currentDrive);
    }
  }

  // ========== 进入指定网盘浏览
  async function enterDrive(driveKey) {
    currentDrive = driveKey;
    const el = document.getElementById("view");
    if (!el) return;

    // 重置路径历史
    pathHistory.length = 0;
    pathHistory.push("0");
    currentPathIndex = 0;

    const hideLoading = window.WB.showLoading("正在加载文件列表...");
    try {
      const data = await Drive[driveKey].list("0");
      hideLoading();
      // 存储当前目录的文件列表供搜索使用
      window.WB.drive._currentItems = data.items;

      el.innerHTML = `
      <div class="drive-browser">
        <div class="browser-header">
          <button class="btn sm back-btn" onclick="window.WB.drive.backToList()">← 返回网盘列表</button>
          <h2>${({quark: "🟡 夸克网盘", baidu: "🔵 百度网盘"})[driveKey] || driveKey}</h2>
          <input type="text" id="driveFileSearch" placeholder="搜索当前目录..." style="margin-left: auto; width: 200px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); font-size: 13px; background: var(--card); color: var(--ink);" />
        </div>
        <div class="browser-path">
          ${renderBreadcrumb(driveKey)}
        </div>
        <div class="browser-content" id="browserContent">
          ${renderFileList(data.items, driveKey)}
        </div>
      </div>`;

      // 绑定搜索
      setTimeout(function() {
        const searchInput = document.getElementById("driveFileSearch");
        if (searchInput) {
          searchInput.addEventListener("input", debounce(function() {
            window.WB.drive.searchFiles(this.value);
          }, 300));
        }
      }, 0);
    } catch (e) {
      hideLoading();
      window.WB.showToast("文件列表加载失败", "error");
      el.innerHTML = `
      <div class="card">
        <div class="empty">
          ⚠️ 加载失败：${esc(e.message)}<br />
          <span style="font-size:12px;color:var(--muted);margin-top:8px;display:block;">可能是 Cookie 已过期，请去设置页重新配置</span>
          <br />
          <button class="btn sm" onclick="window.WB.drive.backToList()">返回</button>
          <button class="btn sm" onclick="location.hash='#/settings'">去配置</button>
        </div>
      </div>`;
    }
  }

  // ========== 打开文件/文件夹
  async function openItem(driveKey, fid, isDir, fileName) {
    if (!isDir) {
      // 文件：图片/视频/PDF 直接预览，其余提示去网页版
      const ft = getFileType(fileName || "");
      // 获取文件路径（用于百度网盘预览缩略图/跳网页版）
      const items = window.WB.drive._currentItems || [];
      const item = items.find(function(i) { return i.fid === fid; });
      const filePath = item ? item.path : "/" + fileName;
      if (ft === "image" || ft === "video" || ft === "pdf") {
        await preview(driveKey, fid, fileName, filePath);
      } else {
        const msg = driveKey === "baidu"
          ? "请在百度网盘网页版查看下载"
          : "请在夸克网盘网页版查看下载";
        window.WB.showToast(msg, "info");
      }
      return;
    }
    const hideLoading = window.WB.showLoading("正在打开文件夹...");
    try {
      // 先找到这个文件夹的名称并存储
      const currentDirItems = window.WB.drive._currentItems || [];
      const folderItem = currentDirItems.find(function(item) { return item.fid === fid; });
      if (folderItem) {
        pathNames[fid] = folderItem.name;
      }

      const data = await Drive[driveKey].list(fid);
      hideLoading();
      // 存储当前目录的文件列表供搜索使用
      window.WB.drive._currentItems = data.items;

      if (currentPathIndex < pathHistory.length - 1) {
        pathHistory.splice(currentPathIndex + 1);
      }
      pathHistory.push(fid);
      currentPathIndex = pathHistory.length - 1;

      const content = document.getElementById("browserContent");
      const pathEl = document.querySelector(".browser-path");
      if (content) content.innerHTML = renderFileList(data.items, driveKey);
      if (pathEl) pathEl.innerHTML = renderBreadcrumb(driveKey);
    } catch (e) {
      hideLoading();
      window.WB.showToast("打开文件夹失败", "error");
    }
  }

  // ========== 返回上一级
  async function goBack() {
    if (currentPathIndex <= 0) return;
    currentPathIndex--;
    const fid = pathHistory[currentPathIndex];
    const driveKey = currentDrive;
    const hideLoading = window.WB.showLoading("正在返回...");
    try {
      const data = await Drive[driveKey].list(fid);
      hideLoading();
      const content = document.getElementById("browserContent");
      const pathEl = document.querySelector(".browser-path");
      if (content) content.innerHTML = renderFileList(data.items, driveKey);
      if (pathEl) pathEl.innerHTML = renderBreadcrumb(driveKey);
    } catch (e) {
      hideLoading();
      window.WB.showToast("返回失败：" + e.message, "error");
    }
  }

  // ========== 预览文件
  async function preview(driveKey, fid, fileName, filePath) {
    // 百度网盘：图片走缩略图，视频/PDF 跳网页版（dlink 浏览器无法直连）
    if (driveKey === "baidu") {
      const fileType = getFileType(fileName);
      if (fileType === "image") {
        const modalHtml = `
        <div id="previewModal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;">
          <button onclick="window.WB.drive.closePreview()" style="position:absolute;top:15px;right:20px;background:none;border:none;color:white;font-size:40px;cursor:pointer;line-height:1;">&times;</button>
          <div style="max-width:95%;max-height:95%;overflow:auto;">
            <div style="color:white;margin-bottom:10px;text-align:center;">${esc(fileName)}</div>
            <img src="/api/drive/baidu/thumbnail?path=${encodeURIComponent(filePath)}" style="max-width:100%;max-height:85vh;display:block;margin:0 auto;" onerror="setTimeout(()=>{window.WB.drive.closePreview();window.WB.showToast('缩略图加载失败，请在百度网盘网页版查看','info')},100)" />
          </div>
        </div>`;
        document.body.insertAdjacentHTML("beforeend", modalHtml);
        document.addEventListener("keydown", function onEsc(e) {
          if (e.key === "Escape") { closePreview(); document.removeEventListener("keydown", onEsc); }
        });
        return;
      } else if (fileType === "video" || fileType === "pdf") {
        window.WB.showToast("正在打开百度网盘网页版...", "info");
        window.open(`https://pan.baidu.com/disk/main#/index?category=all&path=${encodeURIComponent(filePath)}`, "_blank", "noopener");
        return;
      } else {
        window.WB.showToast("该文件类型暂不支持预览", "info");
        return;
      }
    }

    // 夸克网盘：CDN防盗链导致所有直链/代理方案都412，跳转网页版
    if (driveKey === "quark") {
      window.WB.showToast("正在打开夸克网盘网页版...", "info");
      window.open("https://pan.quark.cn", "_blank", "noopener");
      return;
    }

    try {
      const data = await Drive[driveKey].getDownloadUrl(fid);
      if (!data.download_url) throw new Error("获取下载链接失败");

      const fileType = getFileType(fileName);
      let contentHtml = "";

      if (fileType === "image") {
        contentHtml = `<img src="${data.download_url}" style="max-width:100%;max-height:85vh;display:block;margin:0 auto;" />`;
      } else if (fileType === "video") {
        contentHtml = `<video src="${data.download_url}" controls autoplay style="max-width:100%;max-height:85vh;display:block;margin:0 auto;">您的浏览器不支持视频播放</video>`;
      } else if (fileType === "pdf") {
        contentHtml = `<iframe src="${data.download_url}" style="width:100%;height:85vh;border:none;"></iframe>`;
      } else {
        window.WB.showToast("该文件类型暂不支持预览", "info");
        return;
      }

      // 创建弹窗
      const modalHtml = `
      <div id="previewModal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;">
        <button onclick="window.WB.drive.closePreview()" style="position:absolute;top:15px;right:20px;background:none;border:none;color:white;font-size:40px;cursor:pointer;line-height:1;">&times;</button>
        <div style="max-width:95%;max-height:95%;overflow:auto;">
          <div style="color:white;margin-bottom:10px;text-align:center;">${esc(fileName)}</div>
          ${contentHtml}
        </div>
      </div>`;

      document.body.insertAdjacentHTML("beforeend", modalHtml);

      // ESC 关闭
      document.addEventListener("keydown", function onEsc(e) {
        if (e.key === "Escape") {
          closePreview();
          document.removeEventListener("keydown", onEsc);
        }
      });
    } catch (e) {
      window.WB.showToast("预览失败：" + e.message, "error");
    }
  }

  // ========== 关闭预览
  function closePreview() {
    const modal = document.getElementById("previewModal");
    if (modal) modal.remove();
  }

  // ========== 下载文件（直接跳夸克官方预览页）
  async function download(driveKey, fid, fileName) {
    // 直接在新标签页打开夸克的预览/下载页，由夸克处理所有鉴权逻辑
    // 注意：这里需要用户在浏览器里已经登录了夸克网盘
    window.WB.showToast("即将跳转到夸克网盘预览页，如果提示需要登录，请用浏览器先登录 pan.quark.cn", "info");
    window.open(`https://pan.quark.cn/s/${fid}`, "_blank", "noopener");
  }

  // ========== 刷新所有网盘状态
  async function refreshAll() {
    await loadDriveStatus();
  }

  // ========== 返回网盘列表
  function backToList() {
    // 重置浏览器状态
    pathHistory.length = 0;
    pathHistory.push("0");
    currentPathIndex = 0;
    window.WB.drive._currentItems = [];
    // 如果 hash 已经是 #/drive，直接调 render 强制刷新
    if (location.hash === "#/drive") {
      const el = document.getElementById("view");
      if (el && routes.drive) routes.drive.render(el);
    } else {
      location.hash = "#/drive";
    }
  }

  // ========== 设置页表单渲染
  function renderSettingsForm() {
    return `
    <div class="set-group">
      <h3>🟡 夸克网盘</h3>
      <div class="set-row">
        <span class="s-name">Cookie 配置</span>
        <div style="flex:1;display:flex;gap:8px;align-items:center">
          <input type="text" class="input" id="quarkCookieInput" placeholder="粘贴 Cookie 到此处" style="flex:1" />
          <button class="btn sm" id="quarkSaveBtn">保存</button>
          <button class="btn sm" id="quarkTestBtn">测试</button>
        </div>
        <span class="s-desc">
          获取方式：浏览器打开 pan.quark.cn 登录 → 按 F12 → Application → Cookies → 复制整个 Cookie 字符串
        </span>
      </div>
      <div class="set-row">
        <span class="s-name">连接状态</span>
        <span class="s-desc" id="quarkStatusText">未检测</span>
      </div>
    </div>
    <div class="set-group">
      <h3>🔵 百度网盘</h3>
      <div class="set-row">
        <span class="s-name">Cookie 配置</span>
        <div style="flex:1;display:flex;gap:8px;align-items:center">
          <input type="text" class="input" id="baiduCookieInput" placeholder="粘贴 Cookie 到此处" style="flex:1" />
          <button class="btn sm" id="baiduSaveBtn">保存</button>
          <button class="btn sm" id="baiduTestBtn">测试</button>
        </div>
        <span class="s-desc">
          获取方式：浏览器打开 pan.baidu.com 登录 → 按 F12 → Application → Cookies → 复制 BDUSS 与 STOKEN 两个 Cookie 的完整字符串（格式：BDUSS=xxx; STOKEN=xxx）
        </span>
      </div>
      <div class="set-row">
        <span class="s-name">连接状态</span>
        <span class="s-desc" id="baiduStatusText">未检测</span>
      </div>
    </div>`;
  }

  // ========== 绑定设置页事件
  function bindSettingsEvents() {
    const saveBtn = document.getElementById("quarkSaveBtn");
    const testBtn = document.getElementById("quarkTestBtn");
    const statusText = document.getElementById("quarkStatusText");
    const input = document.getElementById("quarkCookieInput");

    if (saveBtn) {
      saveBtn.addEventListener("click", async function () {
        const cookie = input.value.trim();
        if (!cookie) return window.WB.showToast("Cookie 不能为空", "warning");
        const hideLoading = window.WB.showLoading("正在保存...");
        try {
          await Drive.quark.saveConfig(cookie);
          hideLoading();
          window.WB.showToast("保存成功", "success");
        } catch (e) {
          hideLoading();
          window.WB.showToast("保存失败：" + e.message, "error");
        }
      });
    }

    if (testBtn) {
      testBtn.addEventListener("click", async function () {
        statusText.textContent = "测试中…";
        const hideLoading = window.WB.showLoading("正在测试连接...");
        try {
          const status = await Drive.quark.status();
          hideLoading();
          if (status.valid) {
            statusText.textContent = "✓ 连接成功 (" + (status.nickname || "用户") + ")";
            statusText.style.color = "var(--ok)";
            window.WB.showToast("网盘连接成功", "success");
          } else {
            statusText.textContent = "✗ 连接失败：" + (status.msg || "Cookie 无效");
            statusText.style.color = "var(--danger)";
            window.WB.showToast("Cookie 无效，请重新获取", "error");
          }
        } catch (e) {
          hideLoading();
          statusText.textContent = "✗ 测试失败：" + e.message;
          statusText.style.color = "var(--danger)";
          window.WB.showToast("连接失败：" + e.message, "error");
        }
      });
    }

    // 页面加载时读取已保存的配置并回显
    (async function () {
      if (!input) return;
      try {
        const cfg = await repo("settings").get("drive_quark_config");
        if (cfg && cfg.cookie) {
          input.value = cfg.cookie;
          window.WB.showToast("Cookie 为明文凭据，请勿分享给他人", "warn");
          const status = await Drive.quark.status();
          if (statusText) {
            if (status.valid) {
              statusText.textContent = "✓ 已连接 (" + (status.nickname || "用户") + ")";
              statusText.style.color = "var(--ok)";
            } else {
              statusText.textContent = "✗ 连接失效，请重新获取 Cookie";
              statusText.style.color = "var(--danger)";
            }
          }
        }
      } catch (e) {
        // 忽略未配置
      }
    })();

    // ========== 百度网盘设置事件
    const baiduSaveBtn = document.getElementById("baiduSaveBtn");
    const baiduTestBtn = document.getElementById("baiduTestBtn");
    const baiduStatusText = document.getElementById("baiduStatusText");
    const baiduInput = document.getElementById("baiduCookieInput");

    if (baiduSaveBtn) {
      baiduSaveBtn.addEventListener("click", async function () {
        const cookie = baiduInput.value.trim();
        if (!cookie) return window.WB.showToast("Cookie 不能为空", "warning");
        const hideLoading = window.WB.showLoading("正在保存...");
        try {
          await Drive.baidu.saveConfig(cookie);
          hideLoading();
          window.WB.showToast("保存成功", "success");
        } catch (e) {
          hideLoading();
          window.WB.showToast("保存失败：" + e.message, "error");
        }
      });
    }

    if (baiduTestBtn) {
      baiduTestBtn.addEventListener("click", async function () {
        baiduStatusText.textContent = "测试中…";
        const hideLoading = window.WB.showLoading("正在测试连接...");
        try {
          const status = await Drive.baidu.status();
          hideLoading();
          if (status.valid) {
            baiduStatusText.textContent = "✓ 连接成功 (" + (status.nickname || "用户") + ")";
            baiduStatusText.style.color = "var(--ok)";
            window.WB.showToast("网盘连接成功", "success");
          } else {
            baiduStatusText.textContent = "✗ 连接失败：" + (status.msg || "Cookie 无效");
            baiduStatusText.style.color = "var(--danger)";
            window.WB.showToast("Cookie 无效，请重新获取", "error");
          }
        } catch (e) {
          hideLoading();
          baiduStatusText.textContent = "✗ 测试失败：" + e.message;
          baiduStatusText.style.color = "var(--danger)";
          window.WB.showToast("连接失败：" + e.message, "error");
        }
      });
    }

    // 页面加载时读取已保存的配置并回显
    (async function () {
      if (!baiduInput) return;
      try {
        const cfg = await repo("settings").get("drive_baidu_config");
        if (cfg && cfg.cookie) {
          baiduInput.value = cfg.cookie;
          window.WB.showToast("Cookie 为明文凭据，请勿分享给他人", "warn");
          const status = await Drive.baidu.status();
          if (baiduStatusText) {
            if (status.valid) {
              baiduStatusText.textContent = "✓ 已连接 (" + (status.nickname || "用户") + ")";
              baiduStatusText.style.color = "var(--ok)";
            } else {
              baiduStatusText.textContent = "✗ 连接失效，请重新获取 Cookie";
              baiduStatusText.style.color = "var(--danger)";
            }
          }
        }
      } catch (e) {
        // 忽略未配置
      }
    })();
  }

  // ========== 导出到全局
  window.WB.drive = {
    enter: enterDrive,
    openItem: openItem,
    goBack: goBack,
    jumpToPath: jumpToPath,
    searchFiles: searchFiles,
    refreshAll: refreshAll,
    backToList: backToList,
    preview: preview,
    closePreview: closePreview,
    renderSettingsForm: renderSettingsForm,
    bindSettingsEvents: bindSettingsEvents,
    _currentItems: [],
  };

})();
