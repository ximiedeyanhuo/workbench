import { createRequire } from "module";
const require = createRequire("C:/Users/fzd/node_modules/");
const { chromium } = require("playwright-core");
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 1560, height: 900 } });
const page = await ctx.newPage();
const ts = Date.now();
await page.goto(`http://127.0.0.1:8642/?nocache=${ts}`);
await page.evaluate(async () => {
  if (navigator.serviceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  }
  if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); }
});
await page.goto(`http://127.0.0.1:8642/#/`);
await page.waitForTimeout(2200);
// UI 登录
const mask = page.locator("#loginMask");
if (await mask.isVisible().catch(() => false)) {
  await page.fill("#loginUser", "admin");
  await page.fill("#loginPwd", "admin123");
  await page.click("#loginBtn");
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(1500);
// 计算 dh-cell 样式（亮色）
const dhLight = await page.evaluate(() => {
  const c = document.querySelector(".dh-cell");
  const s = getComputedStyle(c);
  return { bg: s.backgroundColor, border: s.borderColor };
});
// 暗色
await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
await page.waitForTimeout(600);
const dhDark = await page.evaluate(() => {
  const c = document.querySelector(".dh-cell");
  const s = getComputedStyle(c);
  return { bg: s.backgroundColor, border: s.borderColor };
});
// footnote 页面（设置页）
await page.goto("http://127.0.0.1:8642/#/settings");
await page.waitForTimeout(1500);
const fnDark = await page.evaluate(() => {
  const el = document.querySelector(".footnote");
  return el ? getComputedStyle(el).color : "no-footnote";
});
await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "light"); });
await page.waitForTimeout(400);
const fnLight = await page.evaluate(() => {
  const el = document.querySelector(".footnote");
  return el ? getComputedStyle(el).color : "no-footnote";
});
// fab 元素存在性（专注/快捷）
const fabs = await page.evaluate(() => ({
  focus: !!document.querySelector(".focus-fab"),
  quick: !!document.querySelector(".quick-fab"),
}));
console.log(JSON.stringify({ dhLight, dhDark, fnDark, fnLight, fabs }, null, 2));
await browser.close();
console.log("done");
