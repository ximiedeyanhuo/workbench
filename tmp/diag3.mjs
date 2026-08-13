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
await page.waitForTimeout(2500);
const s1 = await page.evaluate(() => ({
  mask: (() => { const m = document.querySelector("#loginMask"); return m ? !m.hidden : "no-mask"; })(),
  viewLen: document.querySelector("#view")?.innerHTML.length || 0,
}));
console.log("before login:", JSON.stringify(s1));
const mask = page.locator("#loginMask");
if (await mask.isVisible().catch(() => false)) {
  await page.fill("#loginUser", "admin");
  await page.fill("#loginPwd", "admin123");
  await page.click("#loginBtn");
  await page.waitForTimeout(2500);
}
const s2 = await page.evaluate(() => ({
  mask: (() => { const m = document.querySelector("#loginMask"); return m ? !m.hidden : "no-mask"; })(),
  viewLen: document.querySelector("#view")?.innerHTML.length || 0,
  greet: document.querySelector(".hero-greet")?.textContent || null,
  dh: !!document.querySelector(".dh-cell"),
}));
console.log("after login:", JSON.stringify(s2));
await browser.close();
