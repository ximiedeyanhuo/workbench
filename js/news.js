/**
 * news.js — 资讯中心：每日推荐（财经 / 科技数码 / 体育 / 热点 / 开发者 / 游戏 六分类）
 *
 * 抓取链路：默认走后端代理 /api/feed（server.py 服务端抓取，无 CORS 限制）；
 *   - RSS/Atom 源：解析后展示标题/摘要/缩略图（文字与视频混排）；
 *   - 解析失败（非 RSS 地址 / 源站故障）的源：降级为「一键直达源站」卡片；
 *   - 每个源的最近一次抓取结果缓存进数据层，按天自动刷新（每日推荐）。
 * 回退模式（USE_API=false）保留浏览器直连抓取，受 CORS 限制时同样降级。
 */
(function () {
  "use strict";
  const { routes, repo, esc, uid, safeUrl, todayStr } = window.WB;
  const feedRepo = repo("feeds");

  const CATS = [
    { k: "finance", label: "财经", icon: "📈", color: "#FF5A36" },
    { k: "tech", label: "科技数码", icon: "💻", color: "#3B82F6" },
    { k: "sports", label: "体育", icon: "⚽", color: "#10B981" },
    { k: "hot", label: "热点", icon: "🔥", color: "#F59E0B" },
    { k: "dev", label: "开发者", icon: "👨‍💻", color: "#8B5CF6" },
    { k: "game", label: "游戏", icon: "🎮", color: "#EC4899" },
    { k: "gov", label: "公考", icon: "📋", color: "#06B6D4" },
  ];

  // 预置源（首次进入自动写入，可自由增删）。均为实测可用的 RSS 地址，走服务端代理抓取。
  const DEFAULTS = [
    { name: "华尔街见闻", url: "https://dedicated.wallstreetcn.com/rss.xml", category: "finance", type: "article" },
    { name: "FT中文网", url: "http://www.ftchinese.com/rss/news", category: "finance", type: "article" },
    { name: "东方财富", url: "http://rss.eastmoney.com/rss_partener.xml", category: "finance", type: "article" },
    { name: "雪球今日话题", url: "https://xueqiu.com/hots/topic/rss", category: "finance", type: "article" },
    { name: "36氪", url: "https://36kr.com/feed", category: "tech", type: "article" },
    { name: "少数派", url: "https://sspai.com/feed", category: "tech", type: "article" },
    { name: "IT之家", url: "https://www.ithome.com/rss/", category: "tech", type: "article" },
    { name: "爱范儿", url: "https://www.ifanr.com/feed", category: "tech", type: "article" },
    { name: "极客公园", url: "http://mainssl.geekpark.net/rss.rss", category: "tech", type: "article" },
    { name: "懂球帝", url: "https://rsshub.rssforever.com/dongqiudi/top_news", category: "sports", type: "article" },
    { name: "虎扑NBA", url: "https://rsshub.rssforever.com/hupu/all/nba", category: "sports", type: "article" },
    { name: "NBA官方(视频)", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCWJ2lWNubArHWmf3FIHbfcQ", category: "sports", type: "video" },
    { name: "澎湃新闻", url: "https://rsshub.rssforever.com/thepaper/featured", category: "hot", type: "article" },
    { name: "中新网滚动", url: "https://www.chinanews.com.cn/rss/scroll-news.xml", category: "hot", type: "article" },
    { name: "南方周末", url: "https://rsshub.rssforever.com/infzm/2", category: "hot", type: "article" },
    { name: "阮一峰周刊", url: "https://www.ruanyifeng.com/blog/atom.xml", category: "dev", type: "article" },
    { name: "V2EX", url: "https://www.v2ex.com/index.xml", category: "dev", type: "article" },
    { name: "GitHub趋势", url: "https://rsshub.rssforever.com/github/trending/daily/any", category: "dev", type: "article" },
    { name: "开源中国", url: "https://www.oschina.net/news/rss", category: "dev", type: "article" },
    { name: "游研社", url: "https://www.yystv.cn/rss/feed", category: "game", type: "article" },
    { name: "机核", url: "https://www.gcores.com/rss", category: "game", type: "article" },
    { name: "触乐", url: "http://www.chuapp.com/feed", category: "game", type: "article" },
    // 公考：华图/中公用后端专用解析器（parser 字段），能真抓出条目列表；
    // 国家公务员局 scs.gov.cn 有反爬 JS 检测，只留作"直达源站"入口。
    { name: "华图·招考公告", url: "http://www.huatu.com/gwy/zhaokao/gg/", parser: "huatu-gg", category: "gov", type: "article" },
    { name: "中公·公务员招考", url: "https://www.offcn.com/gwy/", parser: "offcn-gwy", category: "gov", type: "article" },
    { name: "国家公务员局·招考专栏", url: "http://www.scs.gov.cn/zw/", category: "gov", type: "article" },
    { name: "国家公务员局·政策法规", url: "http://www.scs.gov.cn/zcfg/", category: "gov", type: "article" },
  ];

  // 模块内状态
  let cat = "finance";
  let manageOpen = false;
  let unreadOnly = false; // 只看未读开关
  let timeRange = ""; // "" | "24h" | "3d" | "7d"
  let readMap = {}; // link -> 已读时间 ISO 字符串（持久化在 settings.newsRead）
  let savedSet = new Set(); // 已收藏到链接库的 link 集合
  let digestOpen = false; // 今日精选面板开关（结果持久化在 settings.newsDigest，每天一份）
  let digestData = null; // settings.newsDigest 记录：{key, day, items:[{title,link,src,reason}]}
  let keywords = []; // 关注关键词：命中标题的条目置顶+高亮（持久化在 settings.newsKeywords）

  const RANGES = [
    { k: "", label: "全部" },
    { k: "24h", label: "24小时" },
    { k: "3d", label: "3天" },
    { k: "7d", label: "一周" },
  ];
  const RANGE_HOURS = { "24h": 24, "3d": 72, "7d": 168 };

  // ---------- 抓取层 ----------
  // USE_API 模式下走后端代理 /api/feed，无 CORS 限制，所有源都能真抓取；
  // 特殊：source.parser 有值时走 /api/gov-feed?source=<parser>，后端专用 HTML→RSS 解析器（公考源）；
  // 回退模式保留浏览器直连，拉不到的降级为「直达源站」卡片。
  async function fetchFeed(source) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      let target;
      if (source.parser) {
        // 公考专用抓取：后端从入口页 HTML 解析条目再输出 RSS，前端复用同一 RSS 解析路径
        if (!window.WB.USE_API) throw new Error("公考源需服务端解析，离线不可用");
        target = "/api/gov-feed?source=" + encodeURIComponent(source.parser);
      } else {
        target = window.WB.USE_API
          ? "/api/feed?url=" + encodeURIComponent(source.url)
          : source.url;
      }
      const res = await fetch(target, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      const items = parseFeed(text);
      if (!items.length) throw new Error("未解析到可展示条目");
      return items;
    } finally {
      clearTimeout(timer);
    }
  }

  function tagText(node, tag) {
    const e = node.getElementsByTagName(tag)[0];
    return e ? e.textContent.trim() : "";
  }

  /** 用 text/html 解析剥离 HTML 标签取纯文本（不执行脚本、不加载资源，防 XSS） */
  function stripHtml(html) {
    if (!html) return "";
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
    } catch (e) {
      return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  /** 解析 RSS 2.0 (<item>) 与 Atom (<entry>) */
  function parseFeed(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return [];
    let nodes = Array.prototype.slice.call(doc.getElementsByTagName("item"));
    const atom = nodes.length === 0;
    if (atom) nodes = Array.prototype.slice.call(doc.getElementsByTagName("entry"));

    return nodes.slice(0, 12).map((n) => {
      const title = tagText(n, "title");
      // 链接：RSS 为 <link>text</link>；Atom 为 <link href="…"/>
      let link = "";
      const linkEl = n.getElementsByTagName("link")[0];
      if (linkEl) link = (linkEl.getAttribute("href") || linkEl.textContent || "").trim();
      const rawDesc = tagText(n, "description") || tagText(n, "summary") || tagText(n, "content");
      const date = tagText(n, "pubDate") || tagText(n, "published") || tagText(n, "updated");

      // 缩略图：media:thumbnail / media:content / enclosure / 正文首图
      let thumb = "";
      const mt = n.getElementsByTagName("media:thumbnail")[0] || n.getElementsByTagName("media:content")[0];
      if (mt) thumb = mt.getAttribute("url") || "";
      if (!thumb) {
        const enc = n.getElementsByTagName("enclosure")[0];
        if (enc && /^image\//i.test(enc.getAttribute("type") || "")) thumb = enc.getAttribute("url") || "";
      }
      if (!thumb && rawDesc) {
        const m = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (m) thumb = m[1];
      }

      return { title, link, summary: cut(stripHtml(rawDesc), 140), date, thumb };
    })
      // 过滤脏数据：无标题或无链接的条目不展示（如部分门户僵尸 RSS 标题全空）
      .filter((it) => it.title && it.link);
  }

  /** 按码点安全截断：避免把 emoji 的 surrogate pair 从中劈开，产生非法 JSON 字符 */
  function cut(s, n) {
    const cp = Array.from(String(s || ""));
    return cp.length > n ? cp.slice(0, n).join("") + "…" : cp.join("");
  }

  // ---------- 时间格式化 ----------
  /** 解析源时间为 Date（含 Unix 时间戳 / 1970 年异常兜底处理），解析失败返回 null */
  function parseDate(s) {
    if (!s) return null;
    let d;
    if (/^\d{9,13}$/.test(String(s).trim())) {
      // 部分源（如懂球帝）的 pubDate 是纯数字 Unix 时间戳：10位为秒、13位为毫秒
      const n = Number(String(s).trim());
      d = new Date(n < 1e12 ? n * 1000 : n);
    } else {
      d = new Date(s);
      // 兼容上游（如 RSSHub 部分实例）把秒级时间戳当毫秒转出的 1970 年日期：
      // 此时 getTime() 恰为原始秒值，乘回 1000 即可还原真实时间
      if (!isNaN(d.getTime()) && d.getTime() > 0 && d.getFullYear() < 1972) {
        d = new Date(d.getTime() * 1000);
      }
    }
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(s) {
    const d = parseDate(s);
    if (!d) return s ? String(s).slice(0, 16) : "";
    return (
      d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0") + " " +
      String(d.getHours()).padStart(2, "0") + ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  }

  /** 当前是否仍停留在资讯页：长 await（抓取 / AI 生成）后重渲染前必须校验。
   *  #view 是所有路由复用的主内容区，若抓取期间用户已切到别的路由，异步回调
   *  再调 routes.news.render(el) 会把资讯列表写进当前页面，造成「标题是新页、
   *  内容却是资讯」的渲染污染。校验不通过则放弃重渲染（缓存此时已落库，无损失）。 */
  function stillOnNews() {
    return /^#\/news/.test(location.hash || "");
  }

  // ---------- 抓取并写缓存 ----------
  async function refresh(sources) {
    await Promise.all(
      sources.map(async (f) => {
        try {
          const items = await fetchFeed(f);
          f.cache = { day: todayStr(), at: new Date().toISOString(), ok: true, items };
        } catch (err) {
          f.cache = { day: todayStr(), at: new Date().toISOString(), ok: false, err: err && err.message ? err.message : "拉取失败（跨域或网络）" };
        }
        // 单源缓存保存失败只记日志，不能拖垮整个分类的渲染
        try {
          await feedRepo.put(f);
        } catch (err) {
          console.error("资讯源缓存保存失败:", f.name, err);
        }
      })
    );
  }

  // ---------- 已读 / 过滤 ----------
  /** 记已读并持久化；容量控制只保留最近 500 条，防止 settings 记录无限膨胀 */
  async function markRead(link) {
    readMap[link] = new Date().toISOString();
    const keys = Object.keys(readMap);
    if (keys.length > 500) {
      keys.sort((a, b) => readMap[a].localeCompare(readMap[b]));
      keys.slice(0, keys.length - 500).forEach((k) => delete readMap[k]);
    }
    try {
      await repo("settings").put({ key: "newsRead", urls: readMap });
    } catch (err) {
      console.error("已读状态保存失败:", err);
    }
  }

  /** 条目级过滤：只看未读 + 时间范围（时间过滤下无法解析时间的条目不展示） */
  function passFilters(it) {
    if (unreadOnly && readMap[it.link]) return false;
    if (timeRange) {
      const d = parseDate(it.date);
      if (!d) return false;
      if (Date.now() - d.getTime() > RANGE_HOURS[timeRange] * 3600 * 1000) return false;
    }
    return true;
  }

  // ---------- 关键词高亮 / 置顶 ----------
  /** 标题是否命中任一关注关键词（忽略大小写） */
  function hitKeyword(title) {
    if (!keywords.length || !title) return false;
    const low = String(title).toLowerCase();
    return keywords.some((k) => low.includes(k.toLowerCase()));
  }

  /** 转义后高亮关键词：先 esc 再替换，避免把高亮标签也转义掉 */
  function hiTitle(title) {
    let h = esc(title);
    keywords.forEach((k) => {
      const ek = esc(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (ek) h = h.replace(new RegExp(ek, "gi"), (m) => `<mark class="news-kw">${m}</mark>`);
    });
    return h;
  }

  // ---------- 渲染 ----------
  function itemCard(it, isVideo, srcName, catLabel) {
    const href = safeUrl(it.link);
    const thumb = it.thumb ? safeUrl(it.thumb) : "";
    const isRead = !!readMap[it.link];
    const isSaved = savedSet.has(it.link);
    return `<a class="news-card${isRead ? " read" : ""}" href="${href}" target="_blank" rel="noopener noreferrer" data-link="${esc(it.link)}">
      ${thumb && thumb !== "#" ? `<div class="news-thumb-wrap"><img class="news-thumb" src="${thumb}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.style.display='none'" />${isVideo ? '<span class="news-play">▶</span>' : ""}</div>` : ""}
      <div class="news-body">
        <div class="news-title">${hiTitle(it.title) || "（无标题）"}</div>
        ${it.summary ? `<div class="news-sum">${esc(it.summary)}</div>` : ""}
        <div class="news-meta">${isVideo ? '<span class="tag">视频</span>' : ""}<span>${esc(fmtDate(it.date))}</span>
          <button class="news-fav${isSaved ? " on" : ""}" data-fav="${esc(it.link)}" data-title="${esc(it.title)}" data-src="${esc(srcName)}" data-tag="${esc(catLabel)}" title="${isSaved ? "已收藏" : "收藏到沉淀·链接收藏"}">${isSaved ? "★" : "☆"}</button>
        </div>
      </div>
    </a>`;
  }

  function sourceBlock(f) {
    const c = CATS.find((x) => x.k === f.category) || CATS[0];
    const isVideo = f.type === "video";
    const cache = f.cache;
    let body;
    if (cache && cache.ok && cache.items && cache.items.length) {
      let shown = cache.items.filter(passFilters);
      // 关键词置顶：命中的条目插队到前面，同态内保持原抓取顺序
      if (keywords.length) shown = shown.filter((it) => hitKeyword(it.title)).concat(shown.filter((it) => !hitKeyword(it.title)));
      body = shown.length
        ? `<div class="news-grid">${shown.map((it) => itemCard(it, isVideo, f.name, c.label)).join("")}</div>`
        : `<div class="news-degraded">当前过滤条件下没有条目（共 ${cache.items.length} 条，试试放宽「只看未读 / 时间范围」）</div>`;
    } else if (cache && !cache.ok) {
      body = `<div class="news-degraded">此源未能解析出资讯条目（${esc(cache.err)}）。
        <a href="${safeUrl(f.url)}" target="_blank" rel="noopener noreferrer">点此直达源站 →</a>
        <div class="news-degraded-hint">若长期失败，可在「管理源」里把地址换成该站的 RSS 订阅地址。</div></div>`;
    } else {
      body = `<div class="news-degraded">尚未抓取，点击右上角「🔄 刷新本类」获取，或 <a href="${safeUrl(f.url)}" target="_blank" rel="noopener noreferrer">直达源站 →</a></div>`;
    }
    const updated = cache && cache.at ? "更新于 " + fmtDate(cache.at) : "未更新";
    return `<div class="news-src-blk">
      <div class="news-src-head">
        <span class="dot" style="background:${c.color}"></span>
        <span>${esc(f.name)}</span>
        ${isVideo ? '<span class="tag">视频</span>' : ""}
        <span class="news-src-upd">${esc(updated)}</span>
      </div>
      ${body}
    </div>`;
  }

  routes.news = {
    title: "资讯",
    async render(el) {
      const all = await feedRepo.list();
      // 已读表与收藏集：驱动卡片灰化、分类未读数、星标状态
      const readRec = await repo("settings").get("newsRead");
      readMap = (readRec && readRec.urls) || {};
      const kwRec = await repo("settings").get("newsKeywords");
      keywords = (kwRec && kwRec.words) || [];
      digestData = (await repo("settings").get("newsDigest")) || null;
      try {
        const marks = await repo("bookmarks").list();
        savedSet = new Set(marks.map((m) => m.url));
      } catch (err) {
        savedSet = new Set();
      }
      // 一次性迁移：上一版给公考类塞了错误的 rsshub 路由和临时的官方 URL 占位，
      // 直接清掉再让下面的补种逻辑写入正确的解析器版本。用 settings 里的版本 flag 保证只在需要时跑。
      const MIG_VER = 2;
      const migRec = (await repo("settings").get("newsGovMigrated")) || { key: "newsGovMigrated", ver: 0 };
      if ((migRec.ver || 0) < MIG_VER) {
        const badGovUrls = [
          "https://rsshub.app/gov/scs/zw",
          "https://rsshub.app/gov/scs/zcfg",
          "https://rsshub.app/fenbi/notice",
          "https://rsshub.app/huatu/tzgg",
          "https://rsshub.app/offcn/news",
          // v1 临时占位版：华图/中公首页与粉笔单页应用，都抓不出条目
          "https://www.huatu.com/gwy/",
          "https://www.offcn.com/",
          "https://www.fenbi.com/spa/notice/index",
        ];
        for (const f of all.slice()) {
          if (badGovUrls.indexOf(f.url) !== -1) {
            await feedRepo.delete(f.id);
          }
        }
        const removedRec = (await repo("settings").get("newsRemovedUrls")) || { key: "newsRemovedUrls", urls: [] };
        removedRec.urls = (removedRec.urls || []).filter((u) => badGovUrls.indexOf(u) === -1);
        await repo("settings").put(removedRec);
        await repo("settings").put({ key: "newsGovMigrated", ver: MIG_VER });
        return routes.news.render(el);
      }

      // 预置源增量补种：按 URL 去重，新增预置源（如新分类）对存量用户也能自动生效；用户删过的不会重复加回（记在 settings）
      const seenUrls = new Set(all.map((f) => f.url));
      const removed = (await repo("settings").get("newsRemovedUrls")) || { key: "newsRemovedUrls", urls: [] };
      const missing = DEFAULTS.filter((d) => !seenUrls.has(d.url) && removed.urls.indexOf(d.url) === -1);
      if (missing.length) {
        let i = all.length;
        for (const d of missing) {
          await feedRepo.put({ id: uid(), sort: i++, cache: null, ...d });
        }
        return routes.news.render(el);
      }

      const list = all
        .filter((f) => f.category === cat)
        .sort((a, b) => (a.sort || 0) - (b.sort || 0));

      // 各分类未读数（基于已抓取缓存的全量统计，不受当前过滤影响）
      const counts = {};
      all.forEach((f) => {
        if (f.cache && f.cache.ok && f.cache.items) {
          counts[f.category] = (counts[f.category] || 0) + f.cache.items.filter((it) => !readMap[it.link]).length;
        }
      });

      // 自动刷新：6 小时内不重复抓取（避免频繁请求 RSS 源站）
      const SIX_HOURS = 6 * 60 * 60 * 1000;
      const stale = list.filter((f) => {
        if (!f.cache) return true;
        return Date.now() - new Date(f.cache.at).getTime() > SIX_HOURS;
      });
      // 离线时跳过自动抓取，直接展示已有缓存（服务端代理不可达，硬抓只会拉长白屏时间）
      if (stale.length && window.WB.USE_API) {
        el.innerHTML = renderShell(list, true, counts);
        bindShell(el);
        await refresh(stale);
        if (!stillOnNews()) return; // 抓取期间已切走路由，放弃重渲染避免污染当前页
        return routes.news.render(el);
      }

      el.innerHTML = renderShell(list, false, counts);
      bindShell(el);
    },
  };

  /** 今日精选面板：当天已生成且展开时渲染 */
  function digestHtml() {
    if (!digestOpen || !digestData || digestData.day !== todayStr() || !Array.isArray(digestData.items)) return "";
    const rows = digestData.items
      .map(
        (it, i) => `<li class="item">
          <span class="txt"><b style="color:var(--muted);margin-right:6px">${i + 1}</b>
            <a href="${safeUrl(it.link)}" target="_blank" rel="noopener noreferrer" data-dlink="${esc(it.link)}" style="font-weight:700;text-decoration:none">${esc(it.title)}</a>
            <div style="font-size:12px;color:var(--muted)">${esc(it.src || "")}${it.reason ? " · " + esc(it.reason) : ""}</div>
          </span>
        </li>`
      )
      .join("");
    return `<div class="card" id="digestPanel">
      <h2>今日精选<span class="count">智谱从全部已抓取资讯中挑选 · ${digestData.day}</span></h2>
      <ul class="list">${rows}</ul>
      <div class="row" style="margin-top:8px">
        <button class="btn ghost sm" id="digestRegen">🔄 重新生成</button>
      </div>
    </div>`;
  }

  function renderShell(list, loading, counts) {
    const c = CATS.find((x) => x.k === cat) || CATS[0];
    const tabs = CATS.map(
      (x) => `<span class="tab ${x.k === cat ? "on" : ""}" data-cat="${x.k}">${x.icon} ${x.label}${counts && counts[x.k] ? ` <b class="tab-cnt">${counts[x.k]}</b>` : ""}</span>`
    ).join("");

    const ranges = RANGES.map(
      (r) => `<span class="tab ${r.k === timeRange ? "on" : ""}" data-range="${r.k}">${r.label}</span>`
    ).join("");

    const manage = manageOpen
      ? `<div class="card">
          <h2>管理「${c.label}」资讯源<span class="count">${list.length} 个</span></h2>
          <ul class="list">
            ${
              list.length
                ? list
                    .map(
                      (f) => `<li class="item" data-id="${f.id}">
                        <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${c.color};flex-shrink:0"></span>
                        <span class="txt">${esc(f.name)} <span class="meta">${f.type === "video" ? "视频 · " : ""}${esc(f.url)}</span></span>
                        <button class="icon-btn" data-act="del" title="删除">${WB.icon("del")}</button>
                      </li>`
                    )
                    .join("")
                : '<div class="empty">该分类还没有资讯源，在下方添加</div>'
            }
          </ul>
          <div class="row" style="margin-top:12px">
            <input id="fName" placeholder="源名称，如：财新网" style="width:160px" maxlength="20" />
            <input class="grow" id="fUrl" placeholder="RSS 或站点地址 https://…" maxlength="500" />
            <select id="fType">
              <option value="article">文字</option>
              <option value="video">视频</option>
            </select>
            <button class="btn" id="fAdd">添加到「${c.label}」</button>
          </div>
        </div>`
      : "";

    const content = loading
      ? '<div class="card" id="newsBody"><div class="empty">正在获取最新资讯…（跨域受限的源将自动降级为直达）</div></div>'
      : `<div class="card" id="newsBody">${list.length ? list.map(sourceBlock).join("") : '<div class="empty">该分类暂无资讯源，点「＋ 管理源」添加</div>'}</div>`;

    const online = !!(window.WB && window.WB.USE_API);
    const offlineBanner = online
      ? ""
      : '<div class="offline-banner">当前处于本地模式（未连服务器），资讯抓取和 AI 精选依赖后端代理，暂不可用。已缓存的资讯仍可翻阅。</div>';
    const digestBtnAttrs = online ? "" : ' disabled title="离线中，AI 不可用" class="btn ghost sm offline-disabled"';
    const digestBtnClass = online ? "btn ghost sm" : "btn ghost sm offline-disabled";
    const refreshBtnAttrs = online ? "" : ' disabled title="离线中，无法刷新"';
    const refreshBtnClass = online ? "btn sm" : "btn sm offline-disabled";

    return `
      ${offlineBanner}
      <div class="card">
        <div class="row" style="align-items:center">
          <div class="tabs grow">${tabs}</div>
          <button class="${digestBtnClass}" id="digestBtn"${digestBtnAttrs}>✨ 今日精选</button>
          <button class="btn ghost sm" id="mgBtn">${manageOpen ? "收起管理" : "＋ 管理源"}</button>
          <button class="${refreshBtnClass}" id="refreshBtn"${refreshBtnAttrs}>🔄 刷新本类</button>
        </div>
        <div class="row news-filter" style="align-items:center">
          <span class="news-filter-lab">时间：</span>
          <div class="tabs">${ranges}</div>
          <label class="news-unread-tg"><input type="checkbox" id="unreadOnly" ${unreadOnly ? "checked" : ""} /> 只看未读</label>
        </div>
        <div class="row news-filter" style="align-items:center">
          <span class="news-filter-lab">关注词：</span>
          <input id="newsKw" class="grow" placeholder="关键词用逗号分隔，如：国考, 陕西, AI —— 命中标题的条目会置顶并高亮" maxlength="120" value="${esc(keywords.join(", "))}" />
        </div>
        <div class="news-note">资讯由服务端代理抓取（RSS 源效果最好）；点开过的条目自动置为已读灰化，点 ☆ 可收藏到「沉淀 · 链接收藏」。</div>
      </div>
      ${digestHtml()}
      ${manage}
      ${content}`;
  }

  /** 生成今日精选：候选取全部已抓取条目（未读优先，上限 80 条控制 prompt 体积），智谱挑 10 条带理由 */
  async function generateDigest() {
    const all = await feedRepo.list();
    const pool = [];
    all.forEach((f) => {
      if (!(f.cache && f.cache.ok && f.cache.items)) return;
      const c = CATS.find((x) => x.k === f.category);
      f.cache.items.forEach((it) => {
        if (it.title && it.link) pool.push({ title: it.title, link: it.link, src: f.name, cat: c ? c.label : f.category, read: !!readMap[it.link] });
      });
    });
    if (pool.length < 10) throw new Error("已抓取的资讯不足 10 条，先到各分类点「刷新本类」抓取一些");
    // 未读优先进候选，同态内保持原抓取顺序（越新越靠前）
    const cand = pool.filter((p) => !p.read).concat(pool.filter((p) => p.read)).slice(0, 80);
    const listing = cand.map((p, i) => `${i}. [${p.cat}/${p.src}] ${p.title}`).join("\n");
    const text = await WB.ai.chat(
      "你是资讯主编。只输出 JSON 数组，不要任何解释。",
      '从下面的资讯标题列表中挑选最值得阅读的 10 条（兼顾不同分类，避免同质化）。输出 JSON：[{"i": 序号, "reason": "15字以内推荐理由"}]\n\n' + listing,
      0.4
    );
    const arr = WB.ai.parseJson(text);
    if (!Array.isArray(arr) || !arr.length) throw new Error("模型返回格式异常，请重试");
    const items = arr
      .map((x) => ({ pick: cand[Number(x.i)], reason: String(x.reason || "") }))
      .filter((x) => x.pick)
      .slice(0, 10)
      .map((x) => ({ title: x.pick.title, link: x.pick.link, src: x.pick.cat + " · " + x.pick.src, reason: x.reason }));
    if (!items.length) throw new Error("模型未返回有效序号，请重试");
    digestData = { key: "newsDigest", day: todayStr(), items };
    await repo("settings").put(digestData);
  }

  function bindShell(el) {
    el.querySelectorAll("[data-cat]").forEach((t) =>
      t.addEventListener("click", () => {
        cat = t.dataset.cat;
        routes.news.render(el);
      })
    );
    // 时间范围 / 只看未读：纯前端过滤缓存，不重新抓取
    el.querySelectorAll("[data-range]").forEach((t) =>
      t.addEventListener("click", () => {
        timeRange = t.dataset.range;
        routes.news.render(el);
      })
    );
    const uo = el.querySelector("#unreadOnly");
    if (uo) uo.addEventListener("change", () => { unreadOnly = uo.checked; routes.news.render(el); });

    // 关注关键词：回车/失焦保存后重渲染（逗号分隔，中英文逗号都认）
    const kwInput = el.querySelector("#newsKw");
    if (kwInput)
      kwInput.addEventListener("change", async () => {
        keywords = kwInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
        await repo("settings").put({ key: "newsKeywords", words: keywords });
        routes.news.render(el);
      });

    // 资讯卡片区域事件委托：点 ☆ 收藏入库（阻止跳转）；点卡片记已读（不阻止默认跳转）
    const body = el.querySelector("#newsBody");
    if (body)
      body.addEventListener("click", async (e) => {
        const fav = e.target.closest("[data-fav]");
        if (fav) {
          e.preventDefault();
          e.stopPropagation();
          const link = fav.dataset.fav;
          if (savedSet.has(link)) return;
          await repo("bookmarks").put({
            id: uid(),
            url: link,
            title: fav.dataset.title,
            note: "资讯收藏 · " + fav.dataset.src,
            tags: fav.dataset.tag ? [fav.dataset.tag] : [],
            createdAt: new Date().toISOString(),
          });
          savedSet.add(link);
          fav.classList.add("on");
          fav.textContent = "★";
          fav.title = "已收藏";
          return;
        }
        const card = e.target.closest(".news-card");
        if (card && card.dataset.link && !readMap[card.dataset.link]) {
          card.classList.add("read"); // 即时灰化，落盘异步进行不阻塞新标签打开
          markRead(card.dataset.link);
        }
      });

    const mg = el.querySelector("#mgBtn");
    if (mg) mg.addEventListener("click", () => { manageOpen = !manageOpen; routes.news.render(el); });

    // 今日精选：当天已有缓存则直接展开/收起，没有才调模型生成
    const dg = el.querySelector("#digestBtn");
    if (dg)
      dg.addEventListener("click", async () => {
        if (!window.WB.USE_API) return alert("离线中，AI 精选不可用");
        if (digestOpen) { digestOpen = false; return routes.news.render(el); }
        if (digestData && digestData.day === todayStr()) { digestOpen = true; return routes.news.render(el); }
        const st = await WB.ai.status();
        if (!st.configured) return alert("未配置智谱 API Key：设环境变量 ZHIPU_API_KEY 或在项目根创建 zhipu.key 文件后重启服务");
        dg.disabled = true;
        dg.textContent = "✨ 挑选中…";
        try {
          await generateDigest();
          if (!stillOnNews()) return; // AI 生成期间已切走路由，放弃重渲染
          digestOpen = true;
          routes.news.render(el);
        } catch (err) {
          dg.disabled = false;
          dg.textContent = "✨ 今日精选";
          alert("今日精选生成失败：" + err.message);
        }
      });

    // 精选面板：重新生成 + 点链接记已读（不阻止默认跳转）
    const dp = el.querySelector("#digestPanel");
    if (dp) {
      dp.querySelector("#digestRegen").addEventListener("click", async (e) => {
        const b = e.target;
        b.disabled = true;
        b.textContent = "🔄 生成中…";
        try {
          await generateDigest();
          if (!stillOnNews()) return; // AI 生成期间已切走路由，放弃重渲染
          routes.news.render(el);
        } catch (err) {
          b.disabled = false;
          b.textContent = "🔄 重新生成";
          alert("今日精选生成失败：" + err.message);
        }
      });
      dp.addEventListener("click", (e) => {
        const a = e.target.closest("[data-dlink]");
        if (a && !readMap[a.dataset.dlink]) markRead(a.dataset.dlink);
      });
    }

    const rf = el.querySelector("#refreshBtn");
    if (rf)
      rf.addEventListener("click", async () => {
        if (!window.WB.USE_API) return alert("离线中，无法从服务器抓取资讯");
        rf.disabled = true;
        rf.textContent = "刷新中…";
        const all = await feedRepo.list();
        const list = all.filter((f) => f.category === cat);
        await refresh(list);
        if (!stillOnNews()) return; // 刷新期间已切走路由，放弃重渲染
        routes.news.render(el);
      });

    const add = el.querySelector("#fAdd");
    if (add)
      add.addEventListener("click", async () => {
        const name = el.querySelector("#fName").value.trim();
        const url = el.querySelector("#fUrl").value.trim();
        if (!name || !url) return alert("名称和地址都要填写");
        if (!/^https?:\/\//i.test(url)) return alert("地址需以 http:// 或 https:// 开头");
        const all = await feedRepo.list();
        const maxSort = all.reduce((m, f) => Math.max(m, f.sort || 0), 0);
        await feedRepo.put({
          id: uid(),
          name,
          url,
          category: cat,
          type: el.querySelector("#fType").value,
          sort: maxSort + 1,
          cache: null,
        });
        routes.news.render(el);
      });

    const delList = el.querySelector(".list");
    if (delList)
      delList.addEventListener("click", async (e) => {
        const b = e.target.closest('[data-act="del"]');
        if (!b) return;
        const id = b.closest("[data-id]").dataset.id;
        if (!confirm("删除这个资讯源？")) return;
        // 若删的是预置源，记入 settings 防止增量补种时被加回
        const f = await feedRepo.get(id);
        if (f && DEFAULTS.some((d) => d.url === f.url)) {
          const removed = (await repo("settings").get("newsRemovedUrls")) || { key: "newsRemovedUrls", urls: [] };
          if (removed.urls.indexOf(f.url) === -1) removed.urls.push(f.url);
          await repo("settings").put(removed);
        }
        await feedRepo.delete(id);
        routes.news.render(el);
      });
  }
})();
