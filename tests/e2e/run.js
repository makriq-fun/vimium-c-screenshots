/**
 * Real-browser end-to-end tests for Vimium C Screenshots.
 *
 * Run after `npm run chrome`:
 *   xvfb-run -a node tests/e2e/run.js
 *
 * The script loads the unpacked MV3 build in Chromium, presses real keys and reads the PNG which
 * the extension copied to the system clipboard. It is intentionally dependency-free except
 * Playwright, which CI installs separately (it is not part of the extension's dependencies).
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const EXT_PATH = path.resolve(process.env.EXT_PATH || "dist");
const OUT_DIR = path.resolve(process.env.OUT_DIR || "tests/e2e/out");

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Screenshot test page</title>
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font: 16px/1.4 sans-serif; }
  #fixed { position: fixed; top: 0; left: 0; width: 100%; height: 40px; background: rgb(220, 0, 0); z-index: 50; }
  #before { height: 260px; background: rgb(245, 245, 245); }
  #elem { width: 500px; height: 1500px; margin: 0 0 0 60px; padding: 0; background: rgb(0, 128, 255);
    border: 4px solid rgb(0, 0, 0); box-sizing: border-box; position: relative; }
  #elemTop { height: 30px; background: rgb(250, 220, 0); }
  #elemBottom { position: absolute; left: 0; right: 0; bottom: 0; height: 30px; background: rgb(0, 200, 120); }
  #wide { width: 2600px; height: 140px; background: linear-gradient(to right, rgb(0, 200, 0), rgb(200, 0, 200)); }
  #footer { width: 2600px; height: 600px; background: rgb(0, 180, 90); }
</style></head>
<body>
  <div id="fixed"></div>
  <div id="before"><p>Text before the target.</p><div>Some card with a background and a border</div></div>
  <article id="elem" aria-label="target">
    <div id="elemTop"></div>
    <p style="padding: 20px">A tall element which is larger than the viewport. It must be captured completely.</p>
    <p style="padding: 20px">middle</p>
    <div id="elemBottom"></div>
  </article>
  <div id="wide"></div>
  <div id="footer"></div>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(origin, deviceScaleFactor = 1) {
  const userDataDir = fs.mkdtempSync("/tmp/vcs-e2e-");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    deviceScaleFactor,
    viewport: { width: 1200, height: 800 },
    acceptDownloads: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = context.pages()[0] || await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning" || msg.text().includes("screenshot")) {
      console.log("[page]", msg.type(), msg.text());
    }
  });
  page.on("pageerror", (err) => console.log("[pageerror]", err && err.message || err));
  await page.goto(origin + "/?vcs-test=1", { waitUntil: "load" });
  await page.bringToFront();
  return { context, page, userDataDir };
}

async function pressSequence(page, keys, gap = 60) {
  for (const key of keys) {
    await page.keyboard.press(key);
    await delay(gap);
  }
}

async function uiState(page) {
  return page.evaluate(() => {
    const host = document.getElementById("vimium-c-screenshot-ui");
    const root = host && host.shadowRoot;
    return {
      present: !!host,
      markers: root ? Array.from(root.querySelectorAll(".marker")).map((el) => ({
        label: el.getAttribute("data-vcs-label") || "",
        rect: (el.getAttribute("data-vcs-rect") || "").split(",").map(Number),
      })) : [],
      selected: !!(root && root.querySelector(".hl")),
    };
  });
}

async function waitForUI(page, predicate) {
  await page.waitForFunction((kind) => {
    const host = document.getElementById("vimium-c-screenshot-ui");
    const root = host && host.shadowRoot;
    if (kind === "gone") { return !host; }
    if (!root) { return false; }
    if (kind === "markers") { return root.querySelectorAll(".marker").length > 0; }
    return !!root.querySelector(".hl");
  }, predicate, { timeout: 8000 });
}

async function clearClipboard(page) {
  await page.evaluate(async () => {
    try { await navigator.clipboard.writeText(""); } catch { /* ignore */ }
  });
  await delay(120);
}

async function readClipboard(page) {
  return page.evaluate(async () => {
    let items;
    try { items = await navigator.clipboard.read(); } catch { return null; }
    for (const item of items) {
      if (!item.types.includes("image/png")) { continue; }
      const blob = await item.getType("image/png");
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const pixel = (x, y) => Array.from(ctx.getImageData(Math.max(0, Math.round(x)),
          Math.max(0, Math.round(y)), 1, 1).data);
      const redRows = [];
      const step = Math.max(1, Math.round(bitmap.height / 400));
      for (let y = 0; y < Math.min(bitmap.height, 240); y += step) {
        let red = 0;
        for (let x = 0; x < Math.min(bitmap.width, 600); x += Math.max(1, Math.round(bitmap.width / 120))) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          if (d[0] > 180 && d[1] < 90 && d[2] < 90) { red++; }
        }
        if (red > 20) { redRows.push(y); }
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        type: blob.type,
        redRows,
        topLeft: pixel(12, 12),
        topBand: pixel(20, 14),
        middle: pixel(bitmap.width / 2, bitmap.height / 2),
        bottom: pixel(bitmap.width / 2, bitmap.height - 16),
        rightBottom: pixel(bitmap.width - 20, bitmap.height - 20),
      };
    }
    return null;
  });
}

async function waitForClipboardImage(page, previous) {
  for (let i = 0; i < 300; i++) {
    await page.bringToFront().catch(() => {});
    const image = await readClipboard(page);
    if (image && (!previous || image.width !== previous.width || image.height !== previous.height)) {
      return image;
    }
    await delay(100);
  }
  throw new Error("the extension did not copy an image to the clipboard");
}

const near = (actual, expected, tolerance, label) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
      `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`);
};

const colorNear = (actual, expected, tolerance, label) => {
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance,
        `${label}: expected rgb(${expected.join(",")}), got rgb(${actual.slice(0, 3).join(",")})`);
  }
};

async function elementInfo(page) {
  return page.evaluate(() => {
    const el = document.getElementById("elem");
    const r = el.getBoundingClientRect();
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      w: r.width,
      h: r.height,
      dpr: window.devicePixelRatio,
      docW: Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth),
      docH: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });
}

async function testElement(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await clearClipboard(page);
  await page.keyboard.press("s");
  await delay(80);
  await page.keyboard.press("s");
  await waitForUI(page, "markers");
  const info = await elementInfo(page);
  const state = await uiState(page);
  const target = state.markers.find((m) => m.rect.length === 4
      && Math.abs(m.rect[0] - info.x) <= 2 && Math.abs(m.rect[1] - info.y) <= 2
      && Math.abs(m.rect[2] - info.w) <= 2 && Math.abs(m.rect[3] - info.h) <= 2);
  assert.ok(target, "the target element has a hint label");
  await pressSequence(page, target.label.split(""), 70);
  await waitForUI(page, "selected");
  await page.keyboard.press("s");
  for (let i = 0; i < 100; i++) {
    const state = await page.evaluate(() => document.documentElement.getAttribute("data-vcs-state"));
    if (state && state !== "capturing:element") { console.log("   capture state:", state); break; }
    await delay(100);
  }
  const image = await waitForClipboardImage(page, null);
  const scale = image.width / info.w;
  near(image.width, info.w * info.dpr, 3, "element width");
  near(image.height, info.h * info.dpr, 3, "element height");
  colorNear(image.topBand, [250, 220, 0], 30, "element top band");
  colorNear(image.middle, [0, 128, 255], 25, "element middle");
  colorNear(image.bottom, [0, 200, 120], 30, "element bottom band");
  near(scale, info.dpr, 0.05, "element scale");
  await waitForUI(page, "gone");
  return { image, info };
}

async function testViewport(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await clearClipboard(page);
  await page.keyboard.press("s");
  await delay(80);
  await page.keyboard.press("v");
  const image = await waitForClipboardImage(page, null);
  const info = await elementInfo(page);
  near(image.width, info.vw * info.dpr, 25, "viewport width");
  near(image.height, info.vh * info.dpr, 25, "viewport height");
  return image;
}

async function testFullPage(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await clearClipboard(page);
  await page.keyboard.press("s");
  await delay(80);
  await page.keyboard.press("a");
  const image = await waitForClipboardImage(page, null);
  const info = await elementInfo(page);
  near(image.width, info.docW * info.dpr, 4, "full page width");
  near(image.height, info.docH * info.dpr, 4, "full page height");
  colorNear(image.bottom, [0, 180, 90], 20, "full page footer");
  colorNear(image.rightBottom, [0, 180, 90], 20, "full page right footer");
  assert.ok(image.redRows.length > 0, "the fixed header is captured once at the top");
  assert.ok(Math.max(...image.redRows) < 60 * info.dpr, "the fixed header is not repeated down the page");
  return image;
}

async function testEscape(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await clearClipboard(page);
  await pressSequence(page, ["s", "s"], 70);
  await waitForUI(page, "markers");
  await page.keyboard.press("Escape");
  await waitForUI(page, "gone");
  await delay(600);
  assert.equal(await readClipboard(page), null, "Esc during hint selection does not copy anything");

  await pressSequence(page, ["s", "s"], 70);
  await waitForUI(page, "markers");
  const state = await uiState(page);
  assert.ok(state.markers.length > 2, "hint labels are shown");
  await pressSequence(page, state.markers[1].label.split(""), 70);
  await waitForUI(page, "selected");
  await page.keyboard.press("Escape");
  await waitForUI(page, "gone");
  await delay(600);
  assert.equal(await readClipboard(page), null, "Esc after selecting does not copy anything");
}

async function testNormalMode(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.keyboard.press("s");
  await delay(80);
  await page.keyboard.press("Escape");
  await page.keyboard.press("j");
  await delay(500);
  const y = await page.evaluate(() => window.scrollY);
  assert.ok(y > 0, "j still scrolls after a cancelled s prefix");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await delay(300);
  assert.equal(await page.evaluate(() => window.scrollY), 0, "gg still scrolls to the top");
}

async function testZoom(page, context) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.setZoom(tab.id, 1.5);
  });
  await delay(700);
  await clearClipboard(page);
  await page.keyboard.press("s");
  await delay(80);
  await page.keyboard.press("v");
  const image = await waitForClipboardImage(page, null);
  const info = await elementInfo(page);
  near(image.width, info.vw * info.dpr, 40, "zoomed viewport width");
  near(image.height, info.vh * info.dpr, 40, "zoomed viewport height");
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.setZoom(tab.id, 1);
  });
  await delay(500);
  return image;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log("serving", origin, "extension:", EXT_PATH);

  let browser = await launch(origin, 1);
  try {
    const { page, context } = browser;
    await delay(500);
    console.log("1. element screenshot (ss -> label -> s)");
    const elementShot = await testElement(page);
    console.log("   ", elementShot.image.width, "x", elementShot.image.height);

    console.log("2. viewport screenshot (sv)");
    const viewportShot = await testViewport(page);
    console.log("   ", viewportShot.width, "x", viewportShot.height);

    console.log("3. full page screenshot (sa)");
    const fullShot = await testFullPage(page);
    console.log("   ", fullShot.width, "x", fullShot.height);

    console.log("4. Esc cancels both phases");
    await testEscape(page);

    console.log("5. normal Vimium keys keep working");
    await testNormalMode(page);

    console.log("6. page zoom");
    const zoomShot = await testZoom(page, context);
    console.log("   ", zoomShot.width, "x", zoomShot.height);
  } catch (err) {
    const pages = browser.context.pages();
    if (pages[0]) {
      await pages[0].screenshot({ path: path.join(OUT_DIR, "failure.png") }).catch(() => {});
    }
    throw err;
  } finally {
    await browser.context.close();
  }

  console.log("7. high-DPI (deviceScaleFactor=2)");
  browser = await launch(origin, 2);
  try {
    await delay(500);
    const shot = await testElement(browser.page);
    near(shot.image.width, shot.info.w * 2, 3, "high-DPI element width");
    near(shot.image.height, shot.info.h * 2, 3, "high-DPI element height");
    console.log("   ", shot.image.width, "x", shot.image.height);
  } finally {
    await browser.context.close();
  }

  server.close();
  console.log("all screenshot E2E checks passed");
}

main().catch((err) => {
  console.error(err && err.stack || err);
  server.close();
  process.exitCode = 1;
});
