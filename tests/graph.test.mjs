import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  layoutGraph,
  normalizeLayoutOptions,
  parseGraph,
} from "../graph.mjs";

function orthogonalSegments(layout) {
  const segments = [];
  for (const edge of layout.edges) {
    for (let index = 1; index < edge.points.length; index += 1) {
      const start = edge.points[index - 1];
      const end = edge.points[index];
      if (start.x === end.x && start.y !== end.y) {
        segments.push({ edge: edge.id, axis: "vertical", line: start.x, start: Math.min(start.y, end.y), end: Math.max(start.y, end.y) });
      } else if (start.y === end.y && start.x !== end.x) {
        segments.push({ edge: edge.id, axis: "horizontal", line: start.y, start: Math.min(start.x, end.x), end: Math.max(start.x, end.x) });
      }
    }
  }
  return segments;
}

function collinearOverlaps(layout) {
  const segments = orthogonalSegments(layout);
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const left = segments[leftIndex];
      const right = segments[rightIndex];
      if (left.edge === right.edge || left.axis !== right.axis || Math.abs(left.line - right.line) > 1e-6) continue;
      const length = Math.min(left.end, right.end) - Math.max(left.start, right.start);
      if (length > 1e-6) overlaps.push({ left, right, length });
    }
  }
  return overlaps;
}

test("Rubylith routes approach every target from outside and never share a directed track", async () => {
  const source = await readFile(new URL("../benchmarks/rubylith-bill-of-materials.boxline", import.meta.url), "utf8");
  const graph = parseGraph(source);
  const layout = layoutGraph(graph);
  assert.equal(graph.errors.length, 0);
  assert.equal(collinearOverlaps(layout).length, 0);

  for (const edge of layout.edges) {
    const previous = edge.points.at(-2);
    const target = layout.nodes.get(edge.target);
    const outside = previous.x <= target.x
      || previous.x >= target.x + target.width
      || previous.y <= target.y
      || previous.y >= target.y + target.height;
    assert.equal(outside, true, `${edge.id} must approach ${edge.target} from outside its box`);
  }
});

test("layout controls change intrinsic geometry independently", () => {
  const graph = parseGraph("state Input:\n  next -> Output\nstate Output:");
  const natural = layoutGraph(graph);
  const tall = layoutGraph(graph, { shape: -1 });
  const wide = layoutGraph(graph, { shape: 1 });
  const large = layoutGraph(graph, { size: 1.5 });
  const compressed = layoutGraph(graph, { compression: 0.5 });

  assert.ok(tall.width / tall.height < natural.width / natural.height);
  assert.ok(wide.width / wide.height > natural.width / natural.height);
  assert.ok(large.width > natural.width && large.height > natural.height);
  assert.ok(compressed.width <= natural.width && compressed.height <= natural.height);
  assert.deepEqual(normalizeLayoutOptions({ size: 9, shape: -9, compression: 0 }), {
    size: 2,
    shape: -1,
    compression: 0.5,
  });
});
