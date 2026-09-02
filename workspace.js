import {
  DEFAULT_LAYOUT_OPTIONS,
  EXAMPLE_SOURCE,
  GRAPH_TYPES,
  buildPdf,
  layoutGraph,
  normalizeLayoutOptions,
  parseGraph,
  renderSvg,
  setGraphType,
} from "./graph.mjs";
import { createSourceEditor } from "./vendor/codemirror.js";
import {
  addMissingBundledExamples,
  clampGraphZoom,
  createDefaultFiles,
  createDiagram,
  createFolder,
  findNode,
  findParent,
  folderTrail,
  moveNode,
  normalizeFiles,
  updateBundledExamples,
  uniqueName,
  zoomedScrollOffset,
} from "./workspace-model.mjs";

const STORAGE_KEY = "boxline.workspace.v1";
const GRID = 9;
const desktop = document.querySelector("#desktop");
const minimizedTray = document.querySelector("#minimized-tray");
const minimizedList = document.querySelector("#minimized-list");
const snapPreview = document.querySelector("#snap-preview");
const toast = document.querySelector("#toast");
const saveIndicator = document.querySelector("#save-indicator");
const LEGACY_FIRS_FINGERPRINTS = Object.freeze({
  "file-firs-temperate": "fabca3fd",
  "file-firs-steeltown": "f3783bf8",
});

function sourceFingerprint(source) {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const APPS = Object.freeze({
  editor: Object.freeze({
    code: "BX",
    title: "BOXLINE EDITOR",
    template: "editor-template",
    minW: 430,
    minH: 340,
    x: 20,
    y: 18,
    w: 690,
    h: 690,
  }),
  graph: Object.freeze({
    code: "GR",
    title: "COMPILED GRAPH",
    template: "graph-template",
    minW: 420,
    minH: 300,
    x: 620,
    y: 38,
    w: 650,
    h: 610,
  }),
  layout: Object.freeze({
    code: "LY",
    title: "GRAPH LAYOUT",
    template: "layout-template",
    minW: 310,
    minH: 260,
    x: 520,
    y: 170,
    w: 430,
    h: 390,
  }),
  files: Object.freeze({
    code: "FL",
    title: "PROJECT FILES",
    template: "files-template",
    minW: 390,
    minH: 280,
    x: 730,
    y: 360,
    w: 520,
    h: 330,
  }),
});

const bundledSources = await Promise.all([
  ["file-rubylith", "RUBYLITH BILL OF MATERIALS.boxline", "./benchmarks/rubylith-bill-of-materials.boxline"],
  ["file-firs-temperate", "FIRS 4 TEMPERATE.boxline", "./examples/firs-4-temperate.boxline"],
  ["file-firs-steeltown", "FIRS 4 STEELTOWN.boxline", "./examples/firs-4-steeltown.boxline"],
].map(async ([id, name, url]) => {
  const content = await fetch(url)
    .then((response) => response.ok ? response.text() : "")
    .catch(() => "");
  return { id, name, content };
}));
const [rubylith, ...firsExamples] = bundledSources;
const defaultFiles = createDefaultFiles(EXAMPLE_SOURCE, rubylith.content, firsExamples.filter((file) => file.content));

let model = {
  files: defaultFiles,
  activeFileId: "file-pump",
  currentFolderId: "root",
  selectedFileId: null,
};
let windows = {};
let activeWindowId = null;
let zCounter = 10;
let sourceEditor = null;
let compiled = null;
let saveTimer = 0;
let toastTimer = 0;

function fileNode(id = model.activeFileId) {
  const node = findNode(model.files, id);
  return node?.type === "file" ? node : null;
}

function validActiveFile() {
  const current = fileNode();
  if (current) return current;
  const firstFile = (folder) => {
    for (const child of folder.children || []) {
      if (child.type === "file") return child;
      const nested = firstFile(child);
      if (nested) return nested;
    }
    return null;
  };
  const fallback = firstFile(model.files);
  if (fallback) model.activeFileId = fallback.id;
  return fallback;
}

function appWindow(id) {
  return document.querySelector(`[data-window="${id}"]`);
}

function windowTitle(id) {
  const app = APPS[id];
  const file = fileNode();
  if (["editor", "graph", "layout"].includes(id) && file) {
    const suffix = id === "editor" ? "EDITOR" : id === "graph" ? "GRAPH" : "LAYOUT";
    return `${file.name} / ${suffix}`;
  }
  return app.title;
}

function planeSize() {
  return { width: desktop.clientWidth, height: desktop.clientHeight };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function snap(value) {
  return Math.round(value / GRID) * GRID;
}

function clampRect(id, rect) {
  const size = planeSize();
  const app = APPS[id];
  const minW = Math.min(app.minW, size.width);
  const minH = Math.min(app.minH, size.height);
  const w = clamp(rect.w, minW, size.width);
  const h = clamp(rect.h, minH, size.height);
  return {
    x: clamp(rect.x, 0, size.width - w),
    y: clamp(rect.y, 0, size.height - h),
    w,
    h,
  };
}

function setRect(id, rect, options = {}) {
  const next = clampRect(id, rect);
  Object.assign(windows[id], next);
  const element = appWindow(id);
  if (element) {
    Object.assign(element.style, {
      left: `${next.x}px`,
      top: `${next.y}px`,
      width: `${next.w}px`,
      height: `${next.h}px`,
    });
  }
  if (!options.quiet) scheduleSave();
  return next;
}

function createWindowState(id) {
  const app = APPS[id];
  return {
    id,
    appId: id,
    open: false,
    minimized: false,
    pinned: false,
    x: app.x,
    y: app.y,
    w: app.w,
    h: app.h,
    z: 1,
    ...(id === "graph" ? { zoom: 1, layout: { ...DEFAULT_LAYOUT_OPTIONS } } : {}),
  };
}

function normalizeWindowState(saved = {}) {
  const result = {};
  for (const id of Object.keys(APPS)) {
    result[id] = { ...createWindowState(id), ...(saved[id] || {}), id, appId: id };
    if (id === "graph") result[id].layout = normalizeLayoutOptions(saved[id]?.layout);
  }
  return result;
}

function saveNow(announce = false) {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  const payload = {
    version: 4,
    savedAt: new Date().toISOString(),
    model,
    activeWindowId,
    zCounter,
    windows,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  saveIndicator.textContent = "LOCAL / SAVED";
  saveIndicator.dataset.state = "saved";
  if (announce) showToast("Workspace saved locally");
  return payload;
}

function scheduleSave() {
  saveIndicator.textContent = "LOCAL / SAVING";
  saveIndicator.dataset.state = "dirty";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveNow(false), 140);
}

function restore() {
  let payload = null;
  try {
    payload = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    payload = null;
  }
  if (!payload?.model) {
    windows = normalizeWindowState();
    return false;
  }
  model = {
    files: normalizeFiles(payload.model.files, defaultFiles),
    activeFileId: String(payload.model.activeFileId || "file-pump"),
    currentFolderId: String(payload.model.currentFolderId || "root"),
    selectedFileId: payload.model.selectedFileId ? String(payload.model.selectedFileId) : null,
  };
  if (Number(payload.version) < 2) {
    const migrateGraphSources = (node) => {
      if (node.type === "file") {
        node.content = setGraphType(node.content, "directed");
        return;
      }
      node.children.forEach(migrateGraphSources);
    };
    migrateGraphSources(model.files);
  }
  if (Number(payload.version) < 3) addMissingBundledExamples(model.files, firsExamples.filter((file) => file.content));
  if (Number(payload.version) < 4) {
    updateBundledExamples(
      model.files,
      firsExamples.filter((file) => file.content),
      (existing, candidate) => sourceFingerprint(existing.content) === LEGACY_FIRS_FINGERPRINTS[candidate.id],
    );
  }
  validActiveFile();
  if (findNode(model.files, model.currentFolderId)?.type !== "folder") model.currentFolderId = "root";
  windows = normalizeWindowState(payload.windows);
  zCounter = Math.max(10, Number(payload.zCounter) || 10);
  activeWindowId = payload.activeWindowId && windows[payload.activeWindowId] ? payload.activeWindowId : null;
  return true;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 1800);
}

function focusWindow(id) {
  if (!windows[id]?.open) return;
  if (windows[id].minimized) {
    windows[id].minimized = false;
    const element = appWindow(id);
    if (element) element.hidden = false;
  }
  zCounter += 1;
  windows[id].z = zCounter;
  activeWindowId = id;
  for (const element of desktop.querySelectorAll(".app-window")) {
    const active = element.dataset.window === id;
    element.classList.toggle("active", active);
    element.style.zIndex = String(windows[element.dataset.window]?.z || 1);
  }
  renderLaunchers();
  scheduleSave();
}

function updateWindowTitles() {
  for (const id of ["editor", "graph", "layout"]) {
    const element = appWindow(id);
    if (!element) continue;
    element.querySelector(".window-title").textContent = windowTitle(id);
    element.querySelector("[data-window-file]").textContent = fileNode()?.name || "NO FILE";
  }
}

function makeWindow(id) {
  const app = APPS[id];
  const element = document.createElement("section");
  element.className = "app-window";
  element.dataset.window = id;
  element.dataset.app = id;
  element.innerHTML = `
    <header class="titlebar">
      <span class="window-code">${app.code}</span>
      <div class="window-heading"><span class="window-title">${windowTitle(id)}</span></div>
      <div class="window-actions">
        <button class="window-action" data-window-action="pin" type="button" aria-label="Pin window" aria-pressed="${windows[id].pinned}">◆</button>
        <button class="window-action" data-window-action="minimize" type="button" aria-label="Minimize window">_</button>
        <button class="window-action" data-window-action="close" type="button" aria-label="Close window">×</button>
      </div>
    </header>
    <div class="window-body"></div>
    <footer class="window-status"><span>${app.code} / READY</span><span data-window-file>${fileNode()?.name || "LOCAL"}</span></footer>
    <span class="resize-handle" data-resize="e"></span>
    <span class="resize-handle" data-resize="w"></span>
    <span class="resize-handle" data-resize="s"></span>
    <span class="resize-handle" data-resize="se"></span>
    <span class="resize-handle" data-resize="sw"></span>
  `;
  const template = document.querySelector(`#${app.template}`);
  element.querySelector(".window-body").append(template.content.cloneNode(true));
  desktop.append(element);
  setRect(id, windows[id], { quiet: true });
  element.style.zIndex = String(windows[id].z);
  element.addEventListener("pointerdown", () => focusWindow(id));
  element.querySelector('[data-window-action="pin"]').addEventListener("click", () => togglePin(id));
  element.querySelector('[data-window-action="minimize"]').addEventListener("click", () => minimizeWindow(id));
  element.querySelector('[data-window-action="close"]').addEventListener("click", () => closeWindow(id));
  installDrag(id, element);
  installResize(id, element);
  if (id === "editor") setupEditor(element);
  if (id === "graph") setupGraph(element);
  if (id === "layout") setupLayout(element);
  if (id === "files") setupFiles(element);
  return element;
}

function openWindow(id) {
  if (!APPS[id]) return null;
  if (!windows[id]) windows[id] = createWindowState(id);
  let element = appWindow(id);
  if (!element) element = makeWindow(id);
  windows[id].open = true;
  windows[id].minimized = false;
  element.hidden = false;
  focusWindow(id);
  renderLaunchers();
  if (id === "editor") sourceEditor?.focus();
  return element;
}

function closeWindow(id) {
  const element = appWindow(id);
  if (!element) return;
  windows[id].open = false;
  windows[id].minimized = false;
  element.remove();
  if (id === "editor") sourceEditor = null;
  if (activeWindowId === id) activeWindowId = null;
  renderLaunchers();
  scheduleSave();
}

function minimizeWindow(id) {
  const element = appWindow(id);
  if (!element) return;
  windows[id].minimized = true;
  element.hidden = true;
  if (activeWindowId === id) {
    const next = Object.values(windows)
      .filter((item) => item.open && !item.minimized && item.id !== id)
      .sort((left, right) => right.z - left.z)[0];
    activeWindowId = null;
    if (next) focusWindow(next.id);
  }
  renderLaunchers();
  scheduleSave();
}

function togglePin(id) {
  windows[id].pinned = !windows[id].pinned;
  const button = appWindow(id)?.querySelector('[data-window-action="pin"]');
  button?.setAttribute("aria-pressed", String(windows[id].pinned));
  showToast(windows[id].pinned ? `${windowTitle(id)} pinned` : `${windowTitle(id)} unpinned`);
  scheduleSave();
}

function closeUnpinnedWindows() {
  const ids = Object.keys(windows).filter((id) => windows[id].open && !windows[id].pinned);
  ids.forEach(closeWindow);
  showToast(ids.length ? `${ids.length} unpinned window${ids.length === 1 ? "" : "s"} closed` : "All open windows are pinned");
}

function renderLaunchers() {
  for (const button of document.querySelectorAll(".launch-button")) {
    button.dataset.open = String(Boolean(windows[button.dataset.app]?.open));
  }
  minimizedList.replaceChildren();
  const minimized = Object.values(windows)
    .filter((item) => item.open && item.minimized)
    .sort((left, right) => right.z - left.z);
  minimizedTray.hidden = minimized.length === 0;
  for (const item of minimized) {
    const button = document.createElement("button");
    button.className = "minimized-button";
    button.type = "button";
    button.innerHTML = `<span class="minimized-icon">${APPS[item.id].code}</span><span class="minimized-name">${windowTitle(item.id)}</span>`;
    button.addEventListener("click", () => openWindow(item.id));
    minimizedList.append(button);
  }
}

function snapZone(clientX) {
  const rect = desktop.getBoundingClientRect();
  const x = clientX - rect.left;
  if (x <= 14) return "left";
  if (x >= rect.width - 14) return "right";
  return null;
}

function previewSnap(zone) {
  if (!zone) {
    snapPreview.classList.remove("visible");
    return;
  }
  const size = planeSize();
  const left = zone === "left" ? 5 : size.width / 2 + 3;
  Object.assign(snapPreview.style, {
    left: `${left}px`,
    top: "5px",
    width: `${size.width / 2 - 8}px`,
    height: `${size.height - 10}px`,
  });
  snapPreview.classList.add("visible");
}

function applySnap(id, zone) {
  const size = planeSize();
  setRect(id, {
    x: zone === "left" ? 0 : size.width / 2,
    y: 0,
    w: size.width / 2,
    h: size.height,
  });
}

function installDrag(id, element) {
  const titlebar = element.querySelector(".titlebar");
  titlebar.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    focusWindow(id);
    titlebar.setPointerCapture(event.pointerId);
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      x: windows[id].x,
      y: windows[id].y,
    };
    let zone = null;
    const move = (moveEvent) => {
      setRect(id, {
        ...windows[id],
        x: start.x + moveEvent.clientX - start.clientX,
        y: start.y + moveEvent.clientY - start.clientY,
      }, { quiet: true });
      zone = snapZone(moveEvent.clientX);
      previewSnap(zone);
    };
    const end = () => {
      titlebar.removeEventListener("pointermove", move);
      titlebar.removeEventListener("pointerup", end);
      titlebar.removeEventListener("pointercancel", end);
      previewSnap(null);
      if (zone) applySnap(id, zone);
      else setRect(id, { ...windows[id], x: snap(windows[id].x), y: snap(windows[id].y) });
    };
    titlebar.addEventListener("pointermove", move);
    titlebar.addEventListener("pointerup", end);
    titlebar.addEventListener("pointercancel", end);
  });
}

function installResize(id, element) {
  for (const handle of element.querySelectorAll(".resize-handle")) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      focusWindow(id);
      handle.setPointerCapture(event.pointerId);
      const direction = handle.dataset.resize;
      const start = {
        clientX: event.clientX,
        clientY: event.clientY,
        ...windows[id],
      };
      const move = (moveEvent) => {
        const dx = moveEvent.clientX - start.clientX;
        const dy = moveEvent.clientY - start.clientY;
        const next = { x: start.x, y: start.y, w: start.w, h: start.h };
        if (direction.includes("e")) next.w = snap(start.w + dx);
        if (direction.includes("s")) next.h = snap(start.h + dy);
        if (direction.includes("w")) {
          next.x = snap(start.x + dx);
          next.w = start.w - (next.x - start.x);
        }
        setRect(id, next, { quiet: true });
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        scheduleSave();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
  }
}

function arrangeDesktop(announce = true) {
  const size = planeSize();
  const margin = 14;
  const gap = 12;
  const visible = Object.values(windows).filter((item) => item.open);
  if (size.width < 720) {
    for (const item of visible) {
      item.minimized = item.id !== "editor";
      const element = appWindow(item.id);
      if (element) element.hidden = item.minimized;
    }
    if (windows.editor.open) setRect("editor", { x: 0, y: 0, w: size.width, h: size.height }, { quiet: true });
    focusWindow("editor");
  } else if (windows.editor.open && windows.graph.open) {
    const editorW = Math.round((size.width - margin * 2 - gap) * 0.43);
    const rightX = margin + editorW + gap;
    const rightW = size.width - rightX - margin;
    if (windows.files.open) {
      const graphH = Math.round((size.height - margin * 2 - gap) * 0.64);
      setRect("editor", { x: margin, y: margin, w: editorW, h: size.height - margin * 2 }, { quiet: true });
      setRect("graph", { x: rightX, y: margin, w: rightW, h: graphH }, { quiet: true });
      setRect("files", { x: rightX, y: margin + graphH + gap, w: rightW, h: size.height - margin * 2 - graphH - gap }, { quiet: true });
    } else {
      setRect("editor", { x: margin, y: margin, w: editorW, h: size.height - margin * 2 }, { quiet: true });
      setRect("graph", { x: rightX, y: margin, w: rightW, h: size.height - margin * 2 }, { quiet: true });
    }
  } else if (windows.editor.open && windows.files.open) {
    const editorW = Math.round((size.width - margin * 2 - gap) * 0.62);
    setRect("editor", { x: margin, y: margin, w: editorW, h: size.height - margin * 2 }, { quiet: true });
    setRect("files", { x: margin + editorW + gap, y: margin, w: size.width - margin * 2 - gap - editorW, h: size.height - margin * 2 }, { quiet: true });
  } else if (windows.editor.open) {
    setRect("editor", { x: margin, y: margin, w: Math.min(820, size.width - margin * 2), h: size.height - margin * 2 }, { quiet: true });
  }
  for (const item of visible) {
    if (size.width >= 720) {
      item.minimized = false;
      const element = appWindow(item.id);
      if (element) element.hidden = false;
    }
  }
  renderLaunchers();
  scheduleSave();
  if (announce) showToast("Windows arranged around the editor");
}

function updateCompilation(source) {
  const graph = parseGraph(source);
  const layout = layoutGraph(graph, graphLayoutOptions());
  compiled = { graph, layout };

  const editorWindow = appWindow("editor");
  if (editorWindow) {
    const issues = editorWindow.querySelector("[data-editor-issues]");
    const stateSyntax = editorWindow.querySelector("[data-editor-state-syntax]");
    const lines = source.split(/\r?\n/).length;
    editorWindow.querySelector("[data-editor-lines]").textContent = `${lines} LINE${lines === 1 ? "" : "S"}`;
    stateSyntax.textContent = graph.type === "classified" ? "state Name [class]:" : "state Name:";
    issues.replaceChildren();
    for (const error of graph.errors) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "issue";
      item.textContent = `L${error.line}  ${error.message}`;
      item.addEventListener("click", () => sourceEditor?.focusLine(error.line));
      issues.append(item);
    }
  }
  renderGraph();
  updateGraphLayoutControls();
}

function setupEditor(element) {
  const host = element.querySelector("[data-editor-host]");
  const file = validActiveFile();
  element.querySelector("[data-editor-filename]").textContent = file?.name || "NO FILE";
  sourceEditor = createSourceEditor({
    parent: host,
    doc: file?.content || "",
    onChange: (source) => {
      const target = fileNode();
      if (target) target.content = source;
      updateCompilation(source);
      scheduleSave();
    },
    onSave: () => downloadPdf(),
  });
  window.boxlineEditor = sourceEditor;
  element.querySelector('[data-editor-action="open-graph"]').addEventListener("click", openGraph);
  updateCompilation(sourceEditor.getSource());
}

function renderEditorMetadata() {
  const element = appWindow("editor");
  if (!element) return;
  const file = fileNode();
  element.querySelector("[data-editor-filename]").textContent = file?.name || "NO FILE";
  updateWindowTitles();
}

function openGraph() {
  const wasOpen = windows.graph.open;
  openWindow("graph");
  renderGraph();
  if (!wasOpen) arrangeDesktop(false);
  focusWindow("graph");
}

function graphLayoutOptions() {
  const options = normalizeLayoutOptions(windows.graph?.layout);
  if (windows.graph) windows.graph.layout = options;
  return options;
}

function graphShapeLabel(shape) {
  if (Math.abs(shape) < 0.02) return "NATURAL";
  return shape < 0 ? `TALL ${Math.round(Math.abs(shape) * 100)}%` : `WIDE ${Math.round(shape * 100)}%`;
}

function updateGraphLayoutControls(element = appWindow("layout")) {
  if (!element) return;
  const options = graphLayoutOptions();
  const values = {
    size: Math.round(options.size * 100),
    shape: Math.round(options.shape * 100),
    compression: Math.round(options.compression * 100),
    buffer: Math.round(options.buffer),
  };
  for (const [key, value] of Object.entries(values)) {
    const input = element.querySelector(`[data-graph-layout="${key}"]`);
    if (input) {
      input.value = String(value);
      input.disabled = !compiled?.graph.nodes.length;
    }
  }
  element.querySelector('[data-graph-layout-value="size"]').textContent = `${values.size}%`;
  element.querySelector('[data-graph-layout-value="shape"]').textContent = graphShapeLabel(options.shape);
  element.querySelector('[data-graph-layout-value="compression"]').textContent = `${values.compression}%`;
  element.querySelector('[data-graph-layout-value="buffer"]').textContent = `${values.buffer} PX`;
  const dimensions = element.querySelector("[data-graph-layout-dimensions]");
  const ratio = element.querySelector("[data-graph-layout-ratio]");
  if (compiled?.graph.nodes.length) {
    const width = Math.round(compiled.layout.width);
    const height = Math.round(compiled.layout.height);
    dimensions.textContent = `${width.toLocaleString()} × ${height.toLocaleString()}`;
    ratio.textContent = `${(width / height).toFixed(2)}:1`;
  } else {
    dimensions.textContent = "NO GRAPH";
    ratio.textContent = "—";
  }
}

function setGraphLayoutOption(key, value) {
  if (!compiled || !windows.graph) return;
  const element = appWindow("graph");
  const preview = element?.querySelector("[data-graph-preview]");
  const centerX = preview?.scrollWidth ? (preview.scrollLeft + preview.clientWidth / 2) / preview.scrollWidth : 0.5;
  const centerY = preview?.scrollHeight ? (preview.scrollTop + preview.clientHeight / 2) / preview.scrollHeight : 0.5;
  windows.graph.layout = normalizeLayoutOptions({ ...graphLayoutOptions(), [key]: value });
  compiled.layout = layoutGraph(compiled.graph, windows.graph.layout);
  renderGraph();
  if (preview) {
    preview.scrollLeft = Math.max(0, centerX * preview.scrollWidth - preview.clientWidth / 2);
    preview.scrollTop = Math.max(0, centerY * preview.scrollHeight - preview.clientHeight / 2);
  }
  scheduleSave();
}

function setupGraph(element) {
  const preview = element.querySelector("[data-graph-preview]");
  element.querySelector("[data-graph-type]").addEventListener("change", (event) => {
    const type = event.currentTarget.value;
    if (!GRAPH_TYPES.includes(type)) return;
    const file = fileNode();
    if (!file) return;
    const source = setGraphType(sourceEditor?.getSource() ?? file.content, type);
    file.content = source;
    if (sourceEditor) sourceEditor.setSource(source);
    else updateCompilation(source);
    scheduleSave();
  });
  element.querySelector('[data-graph-action="open-layout"]').addEventListener("click", () => {
    openWindow("layout");
    updateGraphLayoutControls();
  });
  element.querySelector('[data-graph-action="zoom-out"]').addEventListener("click", () => {
    setGraphZoom(graphZoom() - 0.1);
  });
  element.querySelector('[data-graph-action="zoom-reset"]').addEventListener("click", () => {
    setGraphZoom(1);
  });
  element.querySelector('[data-graph-action="zoom-in"]').addEventListener("click", () => {
    setGraphZoom(graphZoom() + 0.1);
  });
  preview.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    setGraphZoom(graphZoom() * factor, { clientX: event.clientX, clientY: event.clientY });
  }, { passive: false });
  preview.addEventListener("scroll", () => syncGraphColumnStrip(element), { passive: true });
  element.querySelector('[data-graph-action="export-pdf"]').addEventListener("click", downloadPdf);
  element.querySelector('[data-graph-action="export-png"]').addEventListener("click", () => {
    downloadPng().catch((error) => {
      const status = element.querySelector("[data-graph-status]");
      status.textContent = error.message.toUpperCase();
      status.dataset.state = "error";
    });
  });
  renderGraph();
}

function setupLayout(element) {
  element.querySelectorAll("[data-graph-layout]").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.graphLayout;
      const value = key === "buffer" ? Number(input.value) : Number(input.value) / 100;
      setGraphLayoutOption(key, value);
    });
  });
  element.querySelector('[data-graph-action="layout-reset"]').addEventListener("click", () => {
    windows.graph.layout = { ...DEFAULT_LAYOUT_OPTIONS };
    compiled.layout = layoutGraph(compiled.graph, windows.graph.layout);
    renderGraph();
    updateGraphLayoutControls(element);
    scheduleSave();
  });
  updateGraphLayoutControls(element);
}

function graphZoom() {
  return clampGraphZoom(windows.graph?.zoom ?? 1);
}

function updateGraphZoomControls(element = appWindow("graph")) {
  if (!element) return;
  const zoom = graphZoom();
  const ready = Boolean(compiled?.graph.nodes.length);
  const readout = element.querySelector('[data-graph-action="zoom-reset"]');
  readout.textContent = `${Math.round(zoom * 100)}%`;
  readout.setAttribute("aria-label", `Reset zoom to 100 percent; current zoom ${Math.round(zoom * 100)} percent`);
  element.querySelector('[data-graph-action="zoom-out"]').disabled = !ready || zoom <= 0.25;
  element.querySelector('[data-graph-action="zoom-in"]').disabled = !ready || zoom >= 4;
  readout.disabled = !ready;
}

function syncGraphColumnStrip(element = appWindow("graph")) {
  if (!element) return;
  const preview = element.querySelector("[data-graph-preview]");
  const track = element.querySelector("[data-graph-column-strip-track]");
  if (!preview || !track) return;
  const inset = parseFloat(getComputedStyle(preview).paddingLeft) || 0;
  track.style.transform = `translateX(${inset - preview.scrollLeft}px)`;
}

function renderGraphColumnStrip(element = appWindow("graph")) {
  if (!element) return;
  const strip = element.querySelector("[data-graph-column-strip]");
  const track = element.querySelector("[data-graph-column-strip-track]");
  if (!strip || !track) return;
  const headers = compiled?.layout.columnHeaders || [];
  const bands = compiled?.layout.columnBands || [];
  if (!headers.length || !compiled?.graph.nodes.length) {
    strip.hidden = true;
    track.replaceChildren();
    return;
  }

  const zoom = graphZoom();
  track.replaceChildren();
  track.style.width = `${compiled.layout.width * zoom}px`;
  for (const band of bands) {
    const block = document.createElement("span");
    block.className = "graph-column-strip-band";
    block.dataset.class = band.className;
    Object.assign(block.style, {
      left: `${band.x * zoom}px`,
      width: `${band.width * zoom}px`,
      backgroundColor: band.color,
    });
    track.append(block);
  }
  for (const header of headers) {
    const label = document.createElement("span");
    label.className = "graph-column-strip-label";
    label.dataset.class = header.className;
    label.textContent = header.className.toUpperCase();
    Object.assign(label.style, {
      left: `${(header.x + header.width / 2) * zoom}px`,
      borderBottomColor: header.header,
      color: header.ink,
    });
    track.append(label);
  }
  strip.hidden = false;
  syncGraphColumnStrip(element);
}

function applyGraphScale(element = appWindow("graph")) {
  const svg = element?.querySelector("[data-graph-preview] svg");
  if (!svg || !compiled) {
    renderGraphColumnStrip(element);
    updateGraphZoomControls(element);
    return;
  }
  const zoom = graphZoom();
  svg.style.width = `${compiled.layout.width * zoom}px`;
  svg.style.height = `${compiled.layout.height * zoom}px`;
  renderGraphColumnStrip(element);
  updateGraphZoomControls(element);
}

function setGraphZoom(value, anchor = {}) {
  const element = appWindow("graph");
  const preview = element?.querySelector("[data-graph-preview]");
  if (!preview || !compiled?.graph.nodes.length) return;
  const oldZoom = graphZoom();
  const newZoom = clampGraphZoom(value);
  const rect = preview.getBoundingClientRect();
  const pointerX = Number.isFinite(anchor.clientX) ? anchor.clientX - rect.left : preview.clientWidth / 2;
  const pointerY = Number.isFinite(anchor.clientY) ? anchor.clientY - rect.top : preview.clientHeight / 2;
  const style = getComputedStyle(preview);
  const insetX = parseFloat(style.paddingLeft) || 0;
  const insetY = parseFloat(style.paddingTop) || 0;
  const scrollLeft = zoomedScrollOffset(preview.scrollLeft, pointerX, oldZoom, newZoom, insetX);
  const scrollTop = zoomedScrollOffset(preview.scrollTop, pointerY, oldZoom, newZoom, insetY);
  windows.graph.zoom = newZoom;
  applyGraphScale(element);
  preview.scrollLeft = scrollLeft;
  preview.scrollTop = scrollTop;
  scheduleSave();
}

function renderGraph() {
  const element = appWindow("graph");
  if (!element || !compiled) return;
  const { graph, layout } = compiled;
  const preview = element.querySelector("[data-graph-preview]");
  const status = element.querySelector("[data-graph-status]");
  const pdf = element.querySelector('[data-graph-action="export-pdf"]');
  const png = element.querySelector('[data-graph-action="export-png"]');
  const type = element.querySelector("[data-graph-type]");
  const mode = element.querySelector("[data-graph-layout-mode]");
  element.querySelector("[data-graph-file]").textContent = fileNode()?.name || "NO FILE";
  type.value = GRAPH_TYPES.includes(graph.type) ? graph.type : "directed";
  if ((graph.type === "optimized" || graph.type === "classified") && layout.optimization) {
    const swaps = layout.optimization.accepted;
    const passes = layout.optimization.passes;
    mode.textContent = `${graph.type.toUpperCase()} · ${swaps} ${swaps === 1 ? "SWAP" : "SWAPS"} · ${passes} ${passes === 1 ? "PASS" : "PASSES"}`;
  } else {
    mode.textContent = "DIRECTED LAYOUT · CTRL+SCROLL ZOOM";
  }
  if (graph.errors.length) {
    status.textContent = `${graph.errors.length} ${graph.errors.length === 1 ? "ISSUE" : "ISSUES"}`;
    status.dataset.state = "error";
  } else if (!graph.nodes.length) {
    status.textContent = "WAITING FOR A STATE";
    status.dataset.state = "empty";
  } else {
    status.textContent = `${graph.nodes.length} ${graph.nodes.length === 1 ? "STATE" : "STATES"} · ${graph.edges.length} ${graph.edges.length === 1 ? "ARROW" : "ARROWS"}`;
    status.dataset.state = "ready";
  }
  if (graph.nodes.length) {
    preview.innerHTML = renderSvg(graph, layout);
    preview.classList.remove("empty");
  } else {
    preview.innerHTML = '<p class="empty-message">Write a state to compile the first box.</p>';
    preview.classList.add("empty");
  }
  const disabled = Boolean(graph.errors.length) || !graph.nodes.length;
  pdf.disabled = disabled;
  png.disabled = disabled;
  applyGraphScale(element);
  updateGraphLayoutControls();
  updateWindowTitles();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportName(extension) {
  const stem = (fileNode()?.name || "boxline-diagram").replace(/\.boxline$/i, "");
  return `${stem}.${extension}`;
}

function downloadPdf() {
  if (!compiled || compiled.graph.errors.length || !compiled.graph.nodes.length) return;
  const bytes = buildPdf(compiled.graph, compiled.layout);
  downloadBlob(new Blob([bytes], { type: "application/pdf" }), exportName("pdf"));
}

async function downloadPng() {
  if (!compiled || compiled.graph.errors.length || !compiled.graph.nodes.length) return;
  const svg = appWindow("graph")?.querySelector("[data-graph-preview] svg");
  if (!svg) return;
  const serialized = new XMLSerializer().serializeToString(svg);
  const sourceUrl = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = sourceUrl;
    await image.decode();
    const scale = Math.max(2, Math.min(4, 2400 / compiled.layout.width));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(compiled.layout.width * scale);
    canvas.height = Math.round(compiled.layout.height * scale);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG export failed")), "image/png");
    });
    downloadBlob(blob, exportName("png"));
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function openFile(id) {
  const file = fileNode(id);
  if (!file) return;
  model.activeFileId = id;
  model.selectedFileId = id;
  openWindow("editor");
  if (sourceEditor.getSource() !== file.content) sourceEditor.setSource(file.content);
  else updateCompilation(file.content);
  renderEditorMetadata();
  renderFiles();
  scheduleSave();
}

function setupFiles(element) {
  element.querySelector('[data-files-action="up"]').addEventListener("click", () => {
    const parent = findParent(model.files, model.currentFolderId);
    if (parent) {
      model.currentFolderId = parent.id;
      model.selectedFileId = null;
      renderFiles();
      scheduleSave();
    }
  });
  element.querySelector('[data-files-action="new-folder"]').addEventListener("click", () => showCreateForm("folder"));
  element.querySelector('[data-files-action="new-diagram"]').addEventListener("click", () => showCreateForm("diagram"));
  element.querySelector('[data-files-action="cancel-create"]').addEventListener("click", hideCreateForm);
  const form = element.querySelector("[data-file-create]");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const folder = findNode(model.files, model.currentFolderId);
    const input = form.querySelector("[data-file-name]");
    const mode = form.dataset.mode;
    if (!folder || folder.type !== "folder") return;
    if (mode === "folder") {
      const name = uniqueName(folder, input.value || "NEW FOLDER");
      createFolder(model.files, folder.id, name);
    } else {
      const name = uniqueName(folder, input.value || "UNTITLED", ".boxline");
      const stateName = name.replace(/\.boxline$/i, "").replace(/[^a-z0-9]+/gi, " ").trim() || "Untitled";
      const node = createDiagram(model.files, folder.id, name, `graph directed\n\nstate ${stateName}:\n`);
      model.selectedFileId = node.id;
    }
    hideCreateForm();
    renderFiles();
    scheduleSave();
  });
  renderFiles();
}

function showCreateForm(mode) {
  const element = appWindow("files");
  if (!element) return;
  const form = element.querySelector("[data-file-create]");
  const input = form.querySelector("[data-file-name]");
  form.hidden = false;
  form.dataset.mode = mode;
  input.placeholder = mode === "folder" ? "FOLDER NAME" : "DIAGRAM NAME";
  input.value = "";
  input.focus();
}

function hideCreateForm() {
  const form = appWindow("files")?.querySelector("[data-file-create]");
  if (form) form.hidden = true;
}

function renderFiles() {
  const element = appWindow("files");
  if (!element) return;
  const folder = findNode(model.files, model.currentFolderId);
  if (!folder || folder.type !== "folder") {
    model.currentFolderId = "root";
    return renderFiles();
  }
  const upButton = element.querySelector('[data-files-action="up"]');
  upButton.disabled = folder.id === "root";
  const path = element.querySelector("[data-files-path]");
  path.replaceChildren();
  const trail = folderTrail(model.files, folder.id);
  trail.forEach((item, index) => {
    if (index) {
      const slash = document.createElement("span");
      slash.className = "path-separator";
      slash.textContent = "/";
      path.append(slash);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "path-button";
    button.textContent = item.name;
    button.addEventListener("click", () => {
      model.currentFolderId = item.id;
      model.selectedFileId = null;
      renderFiles();
      scheduleSave();
    });
    installDropTarget(button, item.id);
    path.append(button);
  });

  const grid = element.querySelector("[data-file-grid]");
  grid.replaceChildren();
  const sorted = [...folder.children].sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const node of sorted) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.dataset.nodeId = node.id;
    item.dataset.type = node.type;
    item.dataset.active = String(node.id === model.activeFileId);
    item.classList.toggle("selected", node.id === model.selectedFileId);
    item.draggable = true;
    item.tabIndex = 0;
    item.setAttribute("role", "listitem");
    item.setAttribute("aria-label", `${node.type === "folder" ? "Folder" : "Diagram"} ${node.name}`);
    item.innerHTML = `<span class="file-icon">${node.type === "folder" ? "DIR" : "BOX"}</span><span class="file-name"></span>`;
    item.querySelector(".file-name").textContent = node.name;
    item.addEventListener("click", () => {
      model.selectedFileId = node.id;
      for (const candidate of grid.querySelectorAll(".file-item")) {
        candidate.classList.toggle("selected", candidate === item);
      }
      scheduleSave();
    });
    item.addEventListener("dblclick", () => {
      if (node.type === "folder") {
        model.currentFolderId = node.id;
        model.selectedFileId = null;
        renderFiles();
        scheduleSave();
      } else {
        openFile(node.id);
      }
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (node.type === "folder") {
        model.currentFolderId = node.id;
        model.selectedFileId = null;
        renderFiles();
        scheduleSave();
      } else openFile(node.id);
    });
    item.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", node.id);
      event.dataTransfer.effectAllowed = "move";
    });
    if (node.type === "folder") installDropTarget(item, node.id);
    grid.append(item);
  }
}

function installDropTarget(element, folderId) {
  element.addEventListener("dragover", (event) => {
    const nodeId = event.dataTransfer.types.includes("text/plain");
    if (!nodeId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    element.classList.add("drag-target");
  });
  element.addEventListener("dragleave", () => element.classList.remove("drag-target"));
  element.addEventListener("drop", (event) => {
    event.preventDefault();
    element.classList.remove("drag-target");
    const nodeId = event.dataTransfer.getData("text/plain");
    if (moveNode(model.files, nodeId, folderId)) {
      model.selectedFileId = null;
      renderFiles();
      scheduleSave();
      showToast("Item moved");
    }
  });
}

function handleResize() {
  const size = planeSize();
  const visible = Object.values(windows).filter((item) => item.open && !item.minimized);
  if (visible.some((item) => item.x + item.w > size.width || item.y + item.h > size.height)) {
    arrangeDesktop(false);
    return;
  }
  for (const item of visible) setRect(item.id, item, { quiet: true });
}

restore();
const initialFile = validActiveFile();
if (initialFile) {
  const graph = parseGraph(initialFile.content);
  compiled = { graph, layout: layoutGraph(graph, graphLayoutOptions()) };
}

for (const [id, item] of Object.entries(windows)) {
  if (!item.open) continue;
  const wasMinimized = Boolean(item.minimized);
  openWindow(id);
  item.minimized = wasMinimized;
  const element = appWindow(id);
  if (element) element.hidden = item.minimized;
}

if (!Object.values(windows).some((item) => item.open)) {
  openWindow("editor");
  arrangeDesktop(false);
} else if (activeWindowId && windows[activeWindowId]?.open && !windows[activeWindowId].minimized) {
  focusWindow(activeWindowId);
}

document.querySelectorAll(".launch-button").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.app;
    const wasOpen = windows[id]?.open;
    openWindow(id);
    if (id === "files" && !wasOpen) arrangeDesktop(false);
  });
});
document.querySelector("#arrange-button").addEventListener("click", () => arrangeDesktop(true));
document.querySelector("#save-button").addEventListener("click", () => saveNow(true));
document.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing = target instanceof HTMLElement && (target.matches("input, textarea") || target.isContentEditable || target.closest(".cm-editor"));
  if (event.key === "Delete" && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    closeUnpinnedWindows();
  }
});
window.addEventListener("resize", handleResize);

function updateClock() {
  document.querySelector("#clock").textContent = new Date().toLocaleTimeString("en-GB");
}
updateClock();
window.setInterval(updateClock, 1000);
renderLaunchers();
saveNow(false);

window.__boxlineWorkspace = Object.freeze({
  open: openWindow,
  openGraph,
  openFile,
  close: closeWindow,
  minimize: minimizeWindow,
  arrange: arrangeDesktop,
  save: saveNow,
  setRect,
  getState: () => ({
    activeWindowId,
    zCounter,
    model: structuredClone(model),
    windows: structuredClone(windows),
    compiled: compiled ? {
      type: compiled.graph.type,
      nodes: compiled.graph.nodes.length,
      edges: compiled.graph.edges.length,
      errors: compiled.graph.errors.length,
      width: compiled.layout.width,
      height: compiled.layout.height,
      optimization: structuredClone(compiled.layout.optimization),
    } : null,
  }),
});
