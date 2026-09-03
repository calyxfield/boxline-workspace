import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GRAPH_TYPES,
  buildPdf,
  layoutGraph,
  normalizeLayoutOptions,
  parseGraph,
  renderSvg,
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
    const body = type === "classified"
      ? "columns source result\n\nstate Input [source]:\n  next -> Output\nstate Output [result]:"
      : type === "timeline"
        ? "rows timeline context\nbase Input\n\nstate Input [timeline]:\n  next -> Output\nstate Output [timeline]:"
      : "state Input:\n  next -> Output\nstate Output:";
    const graph = parseGraph(`graph ${type}\n\n${body}`);
    assert.equal(graph.type, type);
    assert.equal(graph.errors.length, 0);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
  }
});

test("timeline graphs require unique rows, a first-row base, and support independent text", () => {
  const source = `graph timeline
rows timeline context detail
base Start

state Start [timeline]:
  text:
    Begin with a deliberately long description that wraps independently of the state name.
    Keep its second source line too.
  next -> Review
state Review [timeline]:
  text: Make the decision visible.
state Background [context]:
  explains -> Review
state Approval [detail]:
  gates -> Start`;
  const graph = parseGraph(source);
  assert.equal(graph.errors.length, 0);
  assert.equal(graph.base, "Start");
  assert.deepEqual(graph.classes, ["timeline", "context", "detail"]);
  assert.match(graph.nodes[0].text, /wraps independently/);
  assert.match(graph.nodes[0].text, /second source line/);
  assert.equal(graph.nodes[1].text, "Make the decision visible.");

  assert.match(parseGraph("graph timeline\nbase Start\nstate Start [timeline]:").errors[0].message, /rows declaration/);
  assert.ok(parseGraph("graph timeline\nrows timeline context\nstate Start [timeline]:").errors.some((error) => /base declaration/.test(error.message)));
  assert.ok(parseGraph("graph timeline\nrows timeline timeline\nbase Start\nstate Start [timeline]:").errors.some((error) => /unique/.test(error.message)));
  assert.ok(parseGraph("graph timeline\nrows timeline context\nbase Note\nstate Start [timeline]:\nstate Note [context]:").errors.some((error) => /first row/.test(error.message)));
  assert.ok(parseGraph("graph timeline\nrows timeline context\nbase Missing\nstate Start [timeline]:").errors.some((error) => /has no declaration/.test(error.message)));
  assert.doesNotThrow(() => layoutGraph(parseGraph("graph timeline\nrows timeline context\nbase Start\nstate Start [timeline]:\n  next -> Note\nstate Note [unknown]:")));
});

test("timeline rows lay out their own graphs and align them across layers", () => {
  const graph = parseGraph(`graph timeline
rows timeline context detail
base Start

state Finish [timeline]:
state Start [timeline]:
  text: Establish the first event with enough body copy to grow the box.
  next -> Review
state Review [timeline]:
  next -> Finish
state Evidence [context]:
  explains -> Review
state Problem [context]:
  develops -> Evidence
  frames -> Start
state Approval [detail]:
  gates -> Finish
state Controls [detail]:
  next -> Approval
  informs -> Review`);
  const layout = layoutGraph(graph);
  const centerX = (id) => {
    const node = layout.nodes.get(id);
    return node.x + node.width / 2;
  };

  assert.ok(layout.nodes.get("Start").x < layout.nodes.get("Review").x);
  assert.ok(layout.nodes.get("Review").x < layout.nodes.get("Finish").x);
  assert.ok(layout.nodes.get("Problem").x < layout.nodes.get("Evidence").x);
  assert.ok(layout.nodes.get("Controls").x < layout.nodes.get("Approval").x);
  assert.equal(centerX("Problem"), centerX("Start"));
  assert.equal(centerX("Evidence"), centerX("Review"));
  assert.equal(centerX("Controls"), centerX("Review"));
  assert.equal(centerX("Approval"), centerX("Finish"));
  assert.ok(layout.nodes.get("Controls").y < layout.nodes.get("Problem").y);
  assert.ok(layout.nodes.get("Problem").y < layout.nodes.get("Start").y);
  assert.equal(layout.nodes.get("Start").isBase, true);
  assert.deepEqual(layout.rowHeaders.map((header) => header.className), ["timeline", "context", "detail"]);
  assert.equal(layout.columnBands.length, 0);
  assert.equal(new Set([...layout.nodes.values()].map((node) => node.fill)).size, 3);
  assert.deepEqual(nodeIntersections(layout), []);
  assert.equal(collinearOverlaps(layout).length, 0);

  const svg = renderSvg(graph, layout);
  assert.match(svg, /class="node timeline-node"/);
  assert.match(svg, /data-base="true"/);
  assert.match(svg, /Establish the first event/);
  assert.match(svg, /class="row-header"/);
  assert.equal(Buffer.from(buildPdf(graph, layout)).subarray(0, 8).toString(), "%PDF-1.4");
});

test("timeline row graphs stack branches inside their own layer", () => {
  const graph = parseGraph(`graph timeline
rows timeline context
base Start

state Start [timeline]:
  next -> Finish
state Finish [timeline]:
state Context [context]:
  option a -> First branch
  option b -> Second branch
  explains -> Start
state First branch [context]:
state Second branch [context]:`);
  const layout = layoutGraph(graph);
  const first = layout.nodes.get("First branch");
  const second = layout.nodes.get("Second branch");

  assert.ok(layout.nodes.get("Context").x < first.x);
  assert.equal(first.x, second.x);
  assert.notEqual(first.y, second.y);
  assert.ok(layout.rowHeaders[1].height > first.height);
});

test("classified graphs declare their column cycle and each state's class", () => {
  const source = `graph classified
columns industry cargo

state Coal Mine [industry]:
  makes -> COAL
state COAL [cargo]:
  used by -> Steel Mill
state Steel Mill [industry]:`;
  const graph = parseGraph(source);
  assert.deepEqual(graph.classes, ["industry", "cargo"]);
  assert.deepEqual(graph.nodes.map((node) => node.className), ["industry", "cargo", "industry"]);
  assert.equal(graph.errors.length, 0);

  const missingColumns = parseGraph("graph classified\n\nstate Input [source]:");
  assert.match(missingColumns.errors[0].message, /columns declaration/);
  const missingClass = parseGraph("graph classified\ncolumns source result\n\nstate Input:");
  assert.match(missingClass.errors[0].message, /state Name \[class\]/);
  const unknownClass = parseGraph("graph classified\ncolumns source result\n\nstate Input [other]:");
  assert.match(unknownClass.errors[0].message, /not listed/);
});

test("classified layout repeats class columns and optimizes within them", () => {
  const graph = parseGraph(`graph classified
columns industry cargo

state Mine [industry]:
  makes -> ORE
state ORE [cargo]:
  used by -> Mill
state Mill [industry]:
  makes -> METAL
state METAL [cargo]:`);
  const layout = layoutGraph(graph);
  const x = (name) => layout.nodes.get(name).x;

  assert.ok(x("Mine") < x("ORE"));
  assert.ok(x("ORE") < x("Mill"));
  assert.ok(x("Mill") < x("METAL"));
  assert.deepEqual(layout.columnHeaders.map((header) => header.className), ["industry", "cargo", "industry", "cargo"]);
  assert.deepEqual(layout.columnBands.map((band) => band.className), ["industry", "cargo", "industry", "cargo"]);
  assert.equal(new Set(layout.columnBands.map((band) => band.color)).size, 2);
  assert.ok(layout.columnBands.every((band) => band.y >= layout.columnHeaders[0].y + layout.columnHeaders[0].height));
  assert.ok(layout.optimization);
});

test("classified layout keeps empty columns when an edge repeats a class", () => {
  const graph = parseGraph(`graph classified
columns industry cargo

state First [industry]:
  next -> Second
state Second [industry]:`);
  const layout = layoutGraph(graph);
  assert.equal(Number.isFinite(layout.width), true);
  assert.ok(layout.nodes.get("First").x < layout.nodes.get("Second").x);
  assert.deepEqual(layout.columnHeaders.map((header) => header.className), ["industry", "cargo", "industry"]);
});

test("graph type can be changed without touching the shared grammar", () => {
  const directed = "graph directed\n\nstate Input:\n  next -> Output\nstate Output:";
  const optimized = setGraphType(directed, "optimized");
  assert.equal(optimized, directed.replace("graph directed", "graph optimized"));
  assert.equal(parseGraph(optimized).type, "optimized");
  const classified = setGraphType(directed, "classified");
  assert.match(classified, /^graph classified\ncolumns class-a class-b/m);
  assert.match(classified, /state Input \[class-a\]:/);
  assert.match(classified, /state Output \[class-b\]:/);
  assert.equal(parseGraph(classified).errors.length, 0);
  assert.equal(setGraphType(classified, "directed"), directed);
  const timeline = setGraphType(directed, "timeline");
  assert.match(timeline, /^graph timeline\nrows timeline context\nbase Input/m);
  assert.match(timeline, /state Input \[timeline\]:/);
  assert.match(timeline, /state Output \[timeline\]:/);
  assert.equal(parseGraph(timeline).errors.length, 0);
  assert.equal(setGraphType(timeline, "directed"), directed);
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

test("FIRS 4 cargo examples import as classified graphs", async () => {
  for (const [name, expectedNodes, expectedEdges] of [
    ["firs-4-temperate.boxline", 31, 35],
    ["firs-4-steeltown.boxline", 72, 100],
  ]) {
    const source = await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8");
    const graph = parseGraph(source);
    assert.equal(graph.errors.length, 0);
    assert.equal(graph.type, "classified");
    assert.deepEqual(graph.classes, ["industry", "cargo"]);
    assert.ok(graph.nodes.every((node) => ["industry", "cargo"].includes(node.className)));
    assert.equal(graph.nodes.length, expectedNodes);
    assert.equal(graph.edges.length, expectedEdges);
    const layout = layoutGraph(graph);
    assert.ok(layout.columnHeaders.length >= 2);
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
