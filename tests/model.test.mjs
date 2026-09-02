import assert from "node:assert/strict";
import test from "node:test";
import {
  addMissingBundledExamples,
  clampGraphZoom,
  createDefaultFiles,
  createDiagram,
  createFolder,
  findNode,
  folderTrail,
  moveNode,
  normalizeFiles,
  updateBundledExamples,
  uniqueName,
  zoomedScrollOffset,
} from "../workspace-model.mjs";

test("default workspace contains editable Boxline examples", () => {
  const root = createDefaultFiles("state Pump:", "state Rubylith:", [{
    id: "file-firs-temperate",
    name: "FIRS 4 TEMPERATE.boxline",
    content: "state FIRS:",
  }]);
  assert.equal(root.type, "folder");
  assert.equal(findNode(root, "file-pump").content, "state Pump:");
  assert.equal(findNode(root, "file-rubylith").content, "state Rubylith:");
  assert.equal(findNode(root, "file-firs-temperate").content, "state FIRS:");
  assert.deepEqual(folderTrail(root, "folder-examples").map((node) => node.id), ["root", "folder-examples"]);
});

test("new bundled examples are added once to an existing workspace", () => {
  const existing = createDefaultFiles("state Pump:");
  const examples = [{
    id: "file-firs-temperate",
    name: "FIRS 4 TEMPERATE.boxline",
    content: "state FIRS:",
  }];
  assert.equal(addMissingBundledExamples(existing, examples), 1);
  assert.equal(findNode(existing, "file-firs-temperate").content, "state FIRS:");
  assert.equal(addMissingBundledExamples(existing, examples), 0);
});

test("bundled examples can be refreshed without touching user files", () => {
  const existing = createDefaultFiles("state Pump:", "", [{
    id: "file-firs-temperate",
    name: "FIRS 4 TEMPERATE.boxline",
    content: "graph optimized\n\nstate Old:",
  }]);
  createDiagram(existing, "folder-examples", "PERSONAL.boxline", "graph directed\n\nstate Mine:");
  const updated = [{
    id: "file-firs-temperate",
    name: "FIRS 4 TEMPERATE.boxline",
    content: "graph classified\ncolumns industry cargo\n\nstate New [industry]:",
  }];

  assert.equal(updateBundledExamples(existing, updated), 1);
  assert.match(findNode(existing, "file-firs-temperate").content, /^graph classified/);
  assert.equal(findNode(existing, "folder-examples").children.at(-1).content, "graph directed\n\nstate Mine:");

  findNode(existing, "file-firs-temperate").content = "graph optimized\n\nstate Locally edited:";
  assert.equal(updateBundledExamples(existing, updated, (file) => !/Locally edited/.test(file.content)), 0);
  assert.match(findNode(existing, "file-firs-temperate").content, /Locally edited/);
});

test("folders and diagrams are created with collision-free names", () => {
  const root = createDefaultFiles("state Pump:");
  const folder = createFolder(root, "root", "PROCESS");
  assert.ok(folder);
  const first = createDiagram(root, folder.id, uniqueName(folder, "FLOW", ".boxline"), "state Flow:");
  const secondName = uniqueName(folder, "FLOW", ".boxline");
  const second = createDiagram(root, folder.id, secondName, "state Flow 2:");
  assert.equal(first.name, "FLOW.boxline");
  assert.equal(second.name, "FLOW 2.boxline");
});

test("moving prevents cycles and keeps file contents intact", () => {
  const root = createDefaultFiles("state Pump:");
  const target = createFolder(root, "root", "TARGET");
  assert.equal(moveNode(root, "file-pump", target.id), true);
  assert.equal(findNode(root, "file-pump").content, "state Pump:");
  assert.equal(moveNode(root, target.id, target.id), false);
  assert.equal(moveNode(root, target.id, "folder-examples"), true);
  assert.equal(moveNode(root, "folder-examples", target.id), false);
});

test("normalization rejects a malformed saved root", () => {
  const fallback = createDefaultFiles("state Safe:");
  assert.equal(normalizeFiles({ type: "file" }, fallback), fallback);
});

test("graph zoom is bounded and keeps the cursor on the same graph point", () => {
  assert.equal(clampGraphZoom(0.1), 0.25);
  assert.equal(clampGraphZoom(9), 4);
  assert.equal(clampGraphZoom("bad"), 1);
  const oldScroll = 140;
  const pointer = 90;
  const inset = 20;
  const next = zoomedScrollOffset(oldScroll, pointer, 1, 1.5, inset);
  const graphPointBefore = (oldScroll + pointer - inset) / 1;
  const graphPointAfter = (next + pointer - inset) / 1.5;
  assert.equal(graphPointAfter, graphPointBefore);
});
