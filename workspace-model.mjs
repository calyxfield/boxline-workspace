let serial = 0;

export const MIN_GRAPH_ZOOM = 0.25;
export const MAX_GRAPH_ZOOM = 4;

export function clampGraphZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(MAX_GRAPH_ZOOM, Math.max(MIN_GRAPH_ZOOM, numeric));
}

export function zoomedScrollOffset(scrollOffset, pointerOffset, oldZoom, newZoom, fixedInset = 0) {
  const before = clampGraphZoom(oldZoom);
  const after = clampGraphZoom(newZoom);
  const scroll = Number(scrollOffset) || 0;
  const pointer = Number(pointerOffset) || 0;
  const inset = Number(fixedInset) || 0;
  return Math.max(0, inset + (scroll + pointer - inset) * (after / before) - pointer);
}

function makeId(prefix) {
  serial += 1;
  return `${prefix}-${Date.now().toString(36)}-${serial.toString(36)}`;
}

export function createDefaultFiles(exampleSource, rubylithSource = "", bundledExamples = []) {
  return {
    id: "root",
    type: "folder",
    name: "BOXLINE WORKSPACE",
    children: [
      {
        id: "folder-examples",
        type: "folder",
        name: "EXAMPLES",
        children: [
          {
            id: "file-pump",
            type: "file",
            name: "PUMP CONTROL.boxline",
            content: exampleSource,
          },
          ...(rubylithSource ? [{
            id: "file-rubylith",
            type: "file",
            name: "RUBYLITH BILL OF MATERIALS.boxline",
            content: rubylithSource,
          }] : []),
          ...bundledExamples.map((example) => ({
            id: String(example.id),
            type: "file",
            name: String(example.name),
            content: String(example.content),
          })),
        ],
      },
    ],
  };
}

export function addMissingBundledExamples(root, bundledExamples) {
  const folder = findNode(root, "folder-examples");
  if (!folder || folder.type !== "folder") return 0;
  let added = 0;
  for (const candidate of bundledExamples) {
    if (findNode(root, candidate.id)) continue;
    folder.children.push({
      id: String(candidate.id),
      type: "file",
      name: String(candidate.name),
      content: String(candidate.content),
    });
    added += 1;
  }
  return added;
}

export function updateBundledExamples(root, bundledExamples, shouldUpdate = () => true) {
  let updated = 0;
  for (const candidate of bundledExamples) {
    const existing = findNode(root, String(candidate.id));
    if (!existing || existing.type !== "file") continue;
    const content = String(candidate.content);
    if (existing.content === content || !shouldUpdate(existing, candidate)) continue;
    existing.content = content;
    updated += 1;
  }
  return updated;
}

export function normalizeFiles(root, fallback) {
  if (!root || root.type !== "folder" || !Array.isArray(root.children)) return fallback;
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return null;
    const type = node.type === "folder" ? "folder" : "file";
    const id = typeof node.id === "string" && node.id && !seen.has(node.id)
      ? node.id
      : makeId(type);
    seen.add(id);
    const name = String(node.name || (type === "folder" ? "UNTITLED FOLDER" : "UNTITLED.boxline"));
    if (type === "file") return { id, type, name, content: String(node.content || "") };
    return {
      id,
      type,
      name,
      children: (Array.isArray(node.children) ? node.children : []).map(visit).filter(Boolean),
    };
  };
  const normalized = visit(root);
  normalized.id = "root";
  return normalized;
}

export function findNode(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  if (root.type !== "folder") return null;
  for (const child of root.children) {
    const match = findNode(child, id);
    if (match) return match;
  }
  return null;
}

export function findParent(root, id) {
  if (!root || root.type !== "folder") return null;
  if (root.children.some((child) => child.id === id)) return root;
  for (const child of root.children) {
    const match = findParent(child, id);
    if (match) return match;
  }
  return null;
}

export function folderTrail(root, id) {
  const trail = [];
  const walk = (node) => {
    if (node.id === id) {
      trail.push(node);
      return true;
    }
    if (node.type !== "folder") return false;
    for (const child of node.children) {
      if (walk(child)) {
        trail.unshift(node);
        return true;
      }
    }
    return false;
  };
  walk(root);
  return trail;
}

export function createFolder(root, parentId, name) {
  const parent = findNode(root, parentId);
  if (!parent || parent.type !== "folder") return null;
  const node = { id: makeId("folder"), type: "folder", name, children: [] };
  parent.children.push(node);
  return node;
}

export function createDiagram(root, parentId, name, content = "") {
  const parent = findNode(root, parentId);
  if (!parent || parent.type !== "folder") return null;
  const cleanName = /\.boxline$/i.test(name) ? name : `${name}.boxline`;
  const node = { id: makeId("file"), type: "file", name: cleanName, content };
  parent.children.push(node);
  return node;
}

export function moveNode(root, nodeId, targetFolderId) {
  if (nodeId === "root" || nodeId === targetFolderId) return false;
  const sourceParent = findParent(root, nodeId);
  const target = findNode(root, targetFolderId);
  const node = findNode(root, nodeId);
  if (!sourceParent || !target || target.type !== "folder" || !node) return false;
  if (node.type === "folder" && findNode(node, targetFolderId)) return false;
  if (sourceParent.id === target.id) return false;
  sourceParent.children = sourceParent.children.filter((child) => child.id !== nodeId);
  target.children.push(node);
  return true;
}

export function uniqueName(folder, requested, suffix = "") {
  const taken = new Set(folder.children.map((child) => child.name.toLowerCase()));
  const raw = String(requested || "").trim() || (suffix ? "UNTITLED" : "NEW FOLDER");
  const hasSuffix = suffix && raw.toLowerCase().endsWith(suffix.toLowerCase());
  const stem = hasSuffix ? raw.slice(0, -suffix.length) : raw;
  let candidate = `${stem}${suffix}`;
  let index = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${stem} ${index}${suffix}`;
    index += 1;
  }
  return candidate;
}
