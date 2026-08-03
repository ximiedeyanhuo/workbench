/**
 * md.js — 轻量 Markdown 渲染器（零依赖、离线可用）
 * 安全策略：先整体 HTML 转义，再做 Markdown 格式化，链接仅放行 http/https。
 * 支持：标题、粗斜体、行内代码、代码块、链接、无序/有序列表、引用、分割线、段落。
 */
(function () {
  "use strict";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function safeHref(u) {
    const s = String(u || "").trim();
    return /^https?:\/\//i.test(s) ? s : "#";
  }

  /** 行内格式：代码、粗体、斜体、链接 */
  function inline(text) {
    let out = text;
    // 行内代码（先处理，内部不再解析其他格式）
    out = out.replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>");
    // 链接 [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      return '<a href="' + safeHref(u) + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
    });
    // 粗体 / 斜体
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return out;
  }

  function render(md) {
    const src = escapeHtml(md).replace(/\r\n?/g, "\n");
    const lines = src.split("\n");
    const html = [];
    let i = 0;
    let listType = null; // "ul" | "ol" | null
    let inQuote = false;

    const closeList = () => { if (listType) { html.push("</" + listType + ">"); listType = null; } };
    const closeQuote = () => { if (inQuote) { html.push("</blockquote>"); inQuote = false; } };

    while (i < lines.length) {
      const line = lines[i];

      // 代码块 ```
      if (/^```/.test(line)) {
        closeList(); closeQuote();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过结尾 ```
        html.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        closeList(); closeQuote();
        const lv = h[1].length;
        html.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">");
        i++; continue;
      }

      // 分割线
      if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
        closeList(); closeQuote();
        html.push("<hr />");
        i++; continue;
      }

      // 引用
      const q = line.match(/^&gt;\s?(.*)$/);
      if (q) {
        closeList();
        if (!inQuote) { html.push("<blockquote>"); inQuote = true; }
        html.push("<p>" + inline(q[1]) + "</p>");
        i++; continue;
      }
      closeQuote();

      // 无序列表
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      if (ul) {
        if (listType !== "ul") { closeList(); html.push("<ul>"); listType = "ul"; }
        html.push("<li>" + inline(ul[1]) + "</li>");
        i++; continue;
      }
      // 有序列表
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        if (listType !== "ol") { closeList(); html.push("<ol>"); listType = "ol"; }
        html.push("<li>" + inline(ol[1]) + "</li>");
        i++; continue;
      }
      closeList();

      // 空行
      if (/^\s*$/.test(line)) { i++; continue; }

      // 普通段落（合并连续行）
      const buf = [line];
      while (
        i + 1 < lines.length &&
        !/^\s*$/.test(lines[i + 1]) &&
        !/^(#{1,3}\s|```|&gt;|\s*[-*]\s|\s*\d+\.\s|-{3,}\s*$|\*{3,}\s*$)/.test(lines[i + 1])
      ) { i++; buf.push(lines[i]); }
      html.push("<p>" + inline(buf.join("<br />")) + "</p>");
      i++;
    }
    closeList(); closeQuote();
    return html.join("\n");
  }

  window.MD = { render };
})();
