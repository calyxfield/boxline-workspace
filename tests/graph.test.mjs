import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GRAPH_TYPES,
  layoutGraph,
  normalizeLayoutOptions,
  parseGraph,
  setGraphType,
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

function parallelClearanceViolations(layout, spacing = 14 * layout.scale) {
  const segments = orthogonalSegments(layout);
  const violations = [];
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const left = segments[leftIndex];
      const right = segments[rightIndex];
      if (left.edge === right.edge || left.axis !== right.axis) continue;
      const overlap = Math.min(left.end, right.end) - Math.max(left.start, right.start);
      const distance = Math.abs(left.line - right.line);
      if (overlap > 1e-6 && distance < spacing - 1e-6) {
        violations.push({ left, right, distance, overlap });
      }
    }
  }
  return violations;
}

function nodeIntersections(layout) {
  const intersections = [];
  for (const edge of layout.edges) {
    for (let index = 1; index < edge.points.length; index += 1) {
      const start = edge.points[index - 1];
      const end = edge.points[index];
      const horizontal = start.y === end.y;
      for (const node of layout.nodes.values()) {
        if (node.id === edge.source || node.id === edge.target) continue;
        const enters = horizontal
          ? start.y > node.y
            && start.y < node.y + node.height
            && Math.max(start.x, end.x) > node.x
            && Math.min(start.x, end.x) < node.x + node.width
          : start.x > node.x
            && start.x < node.x + node.width
            && Math.max(start.y, end.y) > node.y
            && Math.min(start.y, end.y) < node.y + node.height;
        if (enters) intersections.push({ edge: edge.id, node: node.id, index });
      }
    }
  }
  return intersections;
}

function routeLength(edge) {
  return edge.points.slice(1).reduce((total, point, index) => {
    const previous = edge.points[index];
    return total + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
  }, 0);
}

function bendCount(edge) {
  let previousAxis = null;
  let bends = 0;
  for (let index = 1; index < edge.points.length; index += 1) {
    const start = edge.points[index - 1];
    const end = edge.points[index];
    if (start.x === end.x && start.y === end.y) continue;
    const axis = start.y === end.y ? "horizontal" : "vertical";
    if (previousAxis && previousAxis !== axis) bends += 1;
    previousAxis = axis;
  }
  return bends;
}

test("graph type declaration is required and selects the layout engine", () => {
  const missing = parseGraph("state Input:");
  assert.equal(missing.type, null);
  assert.match(missing.errors[0].message, /graph directed/);

  const unsupported = parseGraph("graph radial\n\nstate Input:");
  assert.equal(unsupported.type, "radial");
  assert.match(unsupported.errors[0].message, /not supported/);

  for (const type of GRAPH_TYPES) {
    const graph = parseGraph(`graph ${type}\n\nstate Input:\n  next -> Output\nstate Output:`);
    assert.equal(graph.type, type);
    assert.equal(graph.errors.length, 0);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
  }
});

test("graph type can be changed without touching the shared grammar", () => {
  const directed = "graph directed\n\nstate Input:\n  next -> Output\nstate Output:";
  const optimized = setGraphType(directed, "optimized");
  assert.equal(optimized, directed.replace("graph directed", "graph optimized"));
  assert.equal(parseGraph(optimized).type, "optimized");
  assert.equal(setGraphType("state Input:", "directed"), "graph directed\n\nstate Input:");
  assert.throws(() => setGraphType(directed, "radial"), /Unsupported graph type/);
});

test("optimized layout iteratively removes a crossing and is deterministic", () => {
  const body = "state A:\n  to D -> D\nstate B:\n  to C -> C\nstate C:\nstate D:";
  const directed = layoutGraph(parseGraph(`graph directed\n\n${body}`));
  const optimized = layoutGraph(parseGraph(`graph optimized\n\n${body}`));
  const repeated = layoutGraph(parseGraph(`graph optimized\n\n${body}`));

  assert.equal(directed.optimization, null);
  assert.deepEqual(optimized.optimization.before, { crossings: 1, distance: 2 });
  assert.deepEqual(optimized.optimization.after, { crossings: 0, distance: 0 });
  assert.equal(optimized.optimization.accepted, 1);
  assert.ok(optimized.optimization.passes >= 2);
  assert.deepEqual([...optimized.nodes.entries()], [...repeated.nodes.entries()]);
  assert.deepEqual(optimized.edges, repeated.edges);
});

test("FIRS 4 cargo examples import as optimized graphs", async () => {
  for (const [name, expectedNodes, expectedEdges] of [
    ["firs-4-temperate.boxline", 31, 35],
    ["firs-4-steeltown.boxline", 72, 100],
  ]) {
    const source = await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8");
    const graph = parseGraph(source);
    assert.equal(graph.errors.length, 0);
    assert.equal(graph.type, "optimized");
    assert.equal(graph.nodes.length, expectedNodes);
    assert.equal(graph.edges.length, expectedEdges);
    const layout = layoutGraph(graph);
    assert.ok(layout.optimization.after.crossings <= layout.optimization.before.crossings);
  }
});

test("Rubylith routes stay clear, compact, and distinct", async () => {
  const source = await readFile(new URL("../benchmarks/rubylith-bill-of-materials.boxline", import.meta.url), "utf8");
  const graph = parseGraph(source);
  const layout = layoutGraph(graph);
  assert.equal(graph.errors.length, 0);
  assert.equal(collinearOverlaps(layout).length, 0);
  assert.deepEqual(parallelClearanceViolations(layout), []);
  assert.deepEqual(nodeIntersections(layout), []);

  const worstDetour = Math.max(...layout.edges.map((edge) => {
    const direct = Math.abs(edge.start.x - edge.end.x) + Math.abs(edge.start.y - edge.end.y);
    return routeLength(edge) / Math.max(1, direct);
  }));
  assert.ok(worstDetour <= 1.55, `worst route detour was ${worstDetour.toFixed(3)}×`);

  const compactRoutes = layout.edges.filter((edge) => bendCount(edge) <= 2);
  assert.ok(compactRoutes.length > layout.edges.length * 0.7, "most routes should turn at most twice");
  assert.ok(layout.edges.every((edge) => bendCount(edge) <= 4), "no route should turn more than four times");

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

test("Rubylith route safety survives the layout-control extremes", async () => {
  const source = await readFile(new URL("../benchmarks/rubylith-bill-of-materials.boxline", import.meta.url), "utf8");
  const graph = parseGraph(source);
  for (const options of [
    { size: 0.5, shape: -1, compression: 0.5 },
    { size: 2, shape: 1, compression: 1.75 },
  ]) {
    const layout = layoutGraph(graph, options);
    assert.deepEqual(nodeIntersections(layout), []);
    assert.equal(collinearOverlaps(layout).length, 0);
    assert.deepEqual(parallelClearanceViolations(layout), []);
  }
});

test("layout controls change intrinsic geometry independently", () => {
  const graph = parseGraph("graph directed\n\nstate Input:\n  next -> Output\nstate Output:");
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
    buffer: 32,
  });
});

test("box buffer sets the minimum straight lead at both ends of every arrow", async () => {
  const source = await readFile(new URL("../benchmarks/rubylith-bill-of-materials.boxline", import.meta.url), "utf8");
  const graph = parseGraph(source);
  for (const buffer of [8, 32, 96]) {
    const layout = layoutGraph(graph, { buffer });
    for (const edge of layout.edges) {
      const first = edge.points[0];
      const firstTurn = edge.points[1];
      const lastTurn = edge.points.at(-2);
      const last = edge.points.at(-1);
      const startLead = Math.abs(firstTurn.x - first.x) + Math.abs(firstTurn.y - first.y);
      const endLead = Math.abs(last.x - lastTurn.x) + Math.abs(last.y - lastTurn.y);
      assert.ok(startLead >= buffer - 1e-6, `${edge.id} starts with ${startLead}px at ${buffer}px buffer`);
      assert.ok(endLead >= buffer - 1e-6, `${edge.id} ends with ${endLead}px at ${buffer}px buffer`);
    }
    assert.deepEqual(nodeIntersections(layout), []);
    assert.equal(collinearOverlaps(layout).length, 0);
    assert.deepEqual(parallelClearanceViolations(layout), []);
  }
});
