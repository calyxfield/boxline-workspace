import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultFiles,
  createDiagram,
  createFolder,
  findNode,
  folderTrail,
  moveNode,
  normalizeFiles,
  uniqueName,
} from "../workspace-model.mjs";

test("default workspace contains editable Boxline examples", () => {
  const root = createDefaultFiles("state Pump:", "state Rubylith:");
  assert.equal(root.type, "folder");
  assert.equal(findNode(root, "file-pump").content, "state Pump:");
  assert.equal(findNode(root, "file-rubylith").content, "state Rubylith:");
  assert.deepEqual(folderTrail(root, "folder-examples").map((node) => node.id), ["root", "folder-examples"]);
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
