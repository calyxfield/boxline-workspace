import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
const playwrightImport = await import(playwrightModule ? pathToFileURL(playwrightModule) : "playwright");
const { chromium } = playwrightImport.default || playwrightImport;
const artifacts = new URL("../artifacts/", import.meta.url);
await mkdir(artifacts, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

async function visibleTextBelowFloor(page, floor = 13) {
  return page.evaluate((minimum) => [...document.querySelectorAll("body *")]
    .filter((element) => {
      if (["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName)) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      if (!element.getClientRects().length) return false;
      return [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    })
    .map((element) => ({
      tag: element.tagName,
      className: typeof element.className === "string" ? element.className : element.getAttribute("class") ?? "",
      text: element.textContent.trim().replace(/\s+/g, " ").slice(0, 80),
      size: Number.parseFloat(getComputedStyle(element).fontSize),
    }))
    .filter((entry) => entry.size < minimum - 0.01), floor);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.BOXLINE_WORKSPACE_URL ?? "http://127.0.0.1:4173", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  assert.equal(await page.locator('[data-window="editor"]').isVisible(), true);
  assert.equal(await page.locator('[data-window="graph"]').count(), 0);
  assert.equal(await page.locator('[data-window="files"]').count(), 0);
  assert.match(await page.locator('[data-window="editor"] .window-title').textContent(), /PUMP CONTROL\.boxline \/ EDITOR/);
  assert.equal(await page.locator('[data-window="editor"] .cm-lineNumbers').isVisible(), true);

  await page.locator('[data-editor-action="open-graph"]').click();
  assert.equal(await page.locator('[data-window="graph"]').isVisible(), true);
  assert.equal(await page.locator("[data-graph-status]").textContent(), "4 STATES · 6 ARROWS");
  assert.equal(await page.locator("[data-graph-preview] .node").count(), 4);
  assert.equal(await page.locator("[data-graph-type]").inputValue(), "directed");
  assert.match(await page.locator("[data-graph-layout-mode]").textContent(), /^DIRECTED LAYOUT/);

  await page.locator("[data-graph-type]").selectOption("optimized");
  assert.match(await page.evaluate(() => window.boxlineEditor.getSource()), /^graph optimized/);
  assert.match(await page.locator("[data-graph-layout-mode]").textContent(), /^OPTIMIZED · \d+ SWAPS? · \d+ (?:PASS|PASSES)$/);
  assert.equal((await page.evaluate(() => window.__boxlineWorkspace.getState().compiled)).type, "optimized");

  await page.locator("[data-graph-type]").selectOption("classified");
  assert.match(await page.evaluate(() => window.boxlineEditor.getSource()), /^graph classified\ncolumns class-a class-b/);
  assert.equal(await page.locator("[data-graph-preview] .column-header").count(), 3);
  assert.match(await page.locator("[data-graph-layout-mode]").textContent(), /^CLASSIFIED · \d+ SWAPS? · \d+ (?:PASS|PASSES)$/);
  assert.equal((await page.evaluate(() => window.__boxlineWorkspace.getState().compiled)).type, "classified");
  await page.locator("[data-graph-type]").selectOption("optimized");
  assert.doesNotMatch(await page.evaluate(() => window.boxlineEditor.getSource()), /^columns /m);

  const zoomWidthBefore = await page.locator("[data-graph-preview] svg").evaluate((svg) => svg.getBoundingClientRect().width);
  await page.locator('[data-graph-action="zoom-in"]').click();
  assert.equal(await page.locator('[data-graph-action="zoom-reset"]').textContent(), "110%");
  const zoomWidthAfter = await page.locator("[data-graph-preview] svg").evaluate((svg) => svg.getBoundingClientRect().width);
  assert.equal(zoomWidthAfter > zoomWidthBefore, true);
  await page.locator('[data-graph-action="zoom-reset"]').click();
  assert.equal(await page.locator('[data-graph-action="zoom-reset"]').textContent(), "100%");

  assert.equal(await page.locator('[data-window="layout"]').count(), 0);
  await page.locator('[data-graph-action="open-layout"]').click();
  assert.equal(await page.locator('[data-window="layout"]').isVisible(), true);
  const naturalLayout = await page.locator("[data-graph-preview] svg").evaluate((svg) => ({
    width: Number(svg.getAttribute("width")),
    height: Number(svg.getAttribute("height")),
  }));
  await page.locator('[data-graph-layout="shape"]').evaluate((input) => {
    input.value = "-50";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const tallLayout = await page.locator("[data-graph-preview] svg").evaluate((svg) => ({
    width: Number(svg.getAttribute("width")),
    height: Number(svg.getAttribute("height")),
  }));
  assert.ok(tallLayout.width / tallLayout.height < naturalLayout.width / naturalLayout.height);
  await page.locator('[data-graph-layout="size"]').evaluate((input) => {
    input.value = "125";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const largerLayout = await page.locator("[data-graph-preview] svg").evaluate((svg) => ({
    width: Number(svg.getAttribute("width")),
    height: Number(svg.getAttribute("height")),
  }));
  assert.ok(largerLayout.width > tallLayout.width && largerLayout.height > tallLayout.height);
  await page.locator('[data-graph-layout="compression"]').evaluate((input) => {
    input.value = "70";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-graph-layout="buffer"]').evaluate((input) => {
    input.value = "64";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await page.locator('[data-graph-layout-value="shape"]').textContent(), "TALL 50%");
  assert.equal(await page.locator('[data-graph-layout-value="size"]').textContent(), "125%");
  assert.equal(await page.locator('[data-graph-layout-value="compression"]').textContent(), "70%");
  assert.equal(await page.locator('[data-graph-layout-value="buffer"]').textContent(), "64 PX");
  assert.match(await page.locator("[data-graph-layout-dimensions]").textContent(), /^[\d,]+ × [\d,]+$/);
  await page.locator('[data-window="layout"] [data-window-action="close"]').click();
  assert.equal(await page.locator('[data-window="layout"]').count(), 0);

  const wheelZoom = await page.locator("[data-graph-preview]").evaluate((preview) => {
    const rect = preview.getBoundingClientRect();
    const svg = preview.querySelector("svg");
    const widthBefore = svg.getBoundingClientRect().width;
    preview.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
      clientX: rect.left + 80,
      clientY: rect.top + 80,
    }));
    return {
      widthBefore,
      widthAfter: svg.getBoundingClientRect().width,
      readout: preview.closest(".graph-app").querySelector('[data-graph-action="zoom-reset"]').textContent,
    };
  });
  assert.equal(wheelZoom.widthAfter > wheelZoom.widthBefore, true);

  const intrinsicBefore = await page.locator("[data-graph-preview] svg").evaluate((svg) => ({
    width: svg.getAttribute("width"),
    height: svg.getAttribute("height"),
    renderedWidth: svg.getBoundingClientRect().width,
    renderedHeight: svg.getBoundingClientRect().height,
  }));
  await page.evaluate(() => window.__boxlineWorkspace.setRect("graph", { x: 850, y: 50, w: 430, h: 380 }));
  const intrinsicAfter = await page.locator("[data-graph-preview] svg").evaluate((svg) => ({
    width: svg.getAttribute("width"),
    height: svg.getAttribute("height"),
    renderedWidth: svg.getBoundingClientRect().width,
    renderedHeight: svg.getBoundingClientRect().height,
  }));
  assert.deepEqual(intrinsicAfter, intrinsicBefore);
  assert.equal(await page.locator("[data-graph-preview]").evaluate((node) => node.scrollWidth > node.clientWidth), true);

  const source = "graph optimized\n\nstate Input:\n  complete -> Output\nstate Output:";
  await page.evaluate((value) => window.boxlineEditor.setSource(value), source);
  assert.equal(await page.locator("[data-graph-status]").textContent(), "2 STATES · 1 ARROW");
  assert.equal(await page.locator("[data-graph-preview] .node").count(), 2);

  await page.locator('.launch-button[data-app="files"]').click();
  assert.equal(await page.locator('[data-window="files"]').isVisible(), true);
  await page.locator('.file-item[data-node-id="folder-examples"]').dblclick();
  assert.equal(await page.locator('.file-item[data-node-id="file-firs-temperate"]').count(), 1);
  assert.equal(await page.locator('.file-item[data-node-id="file-firs-steeltown"]').count(), 1);
  await page.locator('.file-item[data-node-id="file-firs-temperate"]').dblclick();
  assert.match(await page.locator('[data-window="editor"] .window-title').textContent(), /FIRS 4 TEMPERATE\.boxline/);
  assert.equal(await page.locator("[data-graph-status]").textContent(), "31 STATES · 35 ARROWS");
  assert.equal(await page.locator("[data-graph-type]").inputValue(), "classified");
  assert.ok(await page.locator("[data-graph-preview] .column-header").count() >= 2);
  await page.locator('[data-files-action="new-diagram"]').click();
  await page.locator("[data-file-name]").fill("DEPENDENCY TEST");
  await page.locator("[data-file-create]").evaluate((form) => form.requestSubmit());
  const newFile = page.locator('.file-item[data-type="file"]', { hasText: "DEPENDENCY TEST.boxline" });
  assert.equal(await newFile.count(), 1);
  await newFile.dblclick();
  assert.match(await page.locator('[data-window="editor"] .window-title').textContent(), /DEPENDENCY TEST\.boxline/);
  assert.match(await page.evaluate(() => window.boxlineEditor.getSource()), /^graph directed\n\nstate DEPENDENCY TEST:/);
  await page.evaluate((value) => window.boxlineEditor.setSource(value), source);

  await page.evaluate(() => window.__boxlineWorkspace.minimize("graph"));
  assert.equal(await page.locator('[data-window="graph"]').isVisible(), false);
  await page.locator('[data-editor-action="open-graph"]').click();
  assert.equal(await page.locator('[data-window="graph"]').isVisible(), true);

  await page.waitForTimeout(250);
  await page.reload({ waitUntil: "networkidle" });
  assert.match(await page.locator('[data-window="editor"] .window-title').textContent(), /DEPENDENCY TEST\.boxline/);
  assert.equal(await page.evaluate(() => window.boxlineEditor.getSource()), source);
  assert.equal(await page.locator("[data-graph-status]").textContent(), "2 STATES · 1 ARROW");
  assert.equal(await page.locator('[data-graph-action="zoom-reset"]').textContent(), wheelZoom.readout);
  assert.deepEqual(await page.evaluate(() => window.__boxlineWorkspace.getState().windows.graph.layout), {
    size: 1.25,
    shape: -0.5,
    compression: 0.7,
    buffer: 64,
  });

  const downloadPromise = page.waitForEvent("download");
  await page.locator('[data-graph-action="export-pdf"]').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "DEPENDENCY TEST.pdf");
  const pdfPath = join(artifacts.pathname, "dependency-test.pdf");
  await download.saveAs(pdfPath);
  const pdf = await readFile(pdfPath);
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");

  await page.waitForTimeout(200);
  await page.screenshot({ path: join(artifacts.pathname, "desktop.png") });
  await page.locator('[data-graph-action="open-layout"]').click();
  assert.deepEqual(await visibleTextBelowFloor(page), []);
  await page.screenshot({ path: join(artifacts.pathname, "layout-window-desktop.png") });
  await page.locator('[data-window="layout"] [data-window-action="close"]').click();
  assert.deepEqual(errors, []);

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await mobileContext.newPage();
  await mobile.goto(process.env.BOXLINE_WORKSPACE_URL ?? "http://127.0.0.1:4173", { waitUntil: "networkidle" });
  await mobile.evaluate(() => localStorage.clear());
  await mobile.reload({ waitUntil: "networkidle" });
  assert.equal(await mobile.locator('[data-window="editor"]').isVisible(), true);
  assert.equal(await mobile.locator('[data-window="editor"]').evaluate((node) => node.getBoundingClientRect().right <= document.querySelector("#desktop").getBoundingClientRect().right + 1), true);
  await mobile.locator('[data-editor-action="open-graph"]').click();
  assert.equal(await mobile.locator('[data-window="graph"]').isVisible(), true);
  assert.equal(await mobile.locator('[data-window="graph"] .graph-toolbar').evaluate((toolbar) => toolbar.scrollWidth <= toolbar.clientWidth), true);
  await mobile.screenshot({ path: join(artifacts.pathname, "mobile.png") });
  await mobile.locator('[data-graph-action="open-layout"]').click();
  assert.equal(await mobile.locator('[data-window="layout"]').isVisible(), true);
  assert.equal(await mobile.locator('[data-window="layout"]').evaluate((node) => node.getBoundingClientRect().right <= document.querySelector("#desktop").getBoundingClientRect().right + 1), true);
  assert.equal(await mobile.locator(".layout-controls").evaluate((controls) => controls.scrollWidth <= controls.clientWidth), true);
  assert.deepEqual(await visibleTextBelowFloor(mobile), []);
  await mobile.screenshot({ path: join(artifacts.pathname, "layout-window-mobile.png") });
  await mobileContext.close();

  console.log(JSON.stringify({
    editorFirst: true,
    separateGraph: true,
    intrinsicGraph: intrinsicAfter,
    persistedFile: "DEPENDENCY TEST.boxline",
    screenshots: [
      "artifacts/desktop.png",
      "artifacts/layout-window-desktop.png",
      "artifacts/mobile.png",
      "artifacts/layout-window-mobile.png",
    ],
  }));
} finally {
  await browser.close();
}
