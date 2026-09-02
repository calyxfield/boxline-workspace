const BASE_NODE_WIDTH = 184;
const BASE_NODE_HEIGHT = 64;
const BASE_LAYER_GAP = 168;
const BASE_ROW_GAP = 76;
const BASE_MARGIN = 64;
const BASE_FORWARD_LANE_SPACING = 16;
const BASE_PARALLEL_SPACING = 14;

const CLASS_COLUMN_PALETTE = Object.freeze([
  Object.freeze({ band: "#f6eddb", header: "#d7a84f", ink: "#5d4519" }),
  Object.freeze({ band: "#e3eef1", header: "#79a4b0", ink: "#234d5d" }),
  Object.freeze({ band: "#e8eddc", header: "#8fa85e", ink: "#3e5120" }),
  Object.freeze({ band: "#eee4ed", header: "#a77ba0", ink: "#593452" }),
  Object.freeze({ band: "#eee8dc", header: "#ab9065", ink: "#594522" }),
]);

export const DEFAULT_LAYOUT_OPTIONS = Object.freeze({
  size: 1,
  shape: 0,
  compression: 1,
  buffer: 32,
});

export const GRAPH_TYPES = Object.freeze(["directed", "optimized", "classified"]);

function clamp(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
}

export function normalizeLayoutOptions(options = {}) {
  return {
    size: clamp(options.size, 0.5, 2, DEFAULT_LAYOUT_OPTIONS.size),
    shape: clamp(options.shape, -1, 1, DEFAULT_LAYOUT_OPTIONS.shape),
    compression: clamp(options.compression, 0.5, 1.75, DEFAULT_LAYOUT_OPTIONS.compression),
    buffer: clamp(options.buffer, 8, 96, DEFAULT_LAYOUT_OPTIONS.buffer),
  };
}

function layoutGeometry(options) {
  const normalized = normalizeLayoutOptions(options);
  const horizontalShape = 16 ** normalized.shape;
  const verticalShape = 16 ** -normalized.shape;
  return {
    options: normalized,
    scale: normalized.size,
    horizontalShape,
    verticalShape,
    nodeWidth: BASE_NODE_WIDTH * normalized.size,
    nodeHeight: BASE_NODE_HEIGHT * normalized.size,
    layerGap: BASE_LAYER_GAP * normalized.size * normalized.compression * horizontalShape,
    rowGap: BASE_ROW_GAP * normalized.size * normalized.compression * verticalShape,
    margin: Math.max(BASE_MARGIN, normalized.buffer + 32) * normalized.size,
    forwardLaneSpacing: BASE_FORWARD_LANE_SPACING * normalized.size,
    parallelSpacing: BASE_PARALLEL_SPACING * normalized.size,
    buffer: normalized.buffer * normalized.size,
  };
}

export const EXAMPLE_SOURCE = `graph directed

# A state box begins with "state Name:"
# Each indented line becomes a labeled arrow.

state Pump:
  pressure high -> Relief valve
  pressure stable -> Process

state Relief valve:
  vent complete -> Pump

state Process:
  batch complete -> Tank
  fault -> Relief valve

state Tank:
  reset -> Pump`;

function issue(line, message) {
  return { line, message };
}

export function parseGraph(source) {
  const nodes = [];
  const pendingEdges = [];
  const errors = [];
  const classes = [];
  const names = new Map();
  let current = null;
  let type = null;
  let columnsLine = null;

  const lines = source.split(/\r?\n/);
  const firstContentIndex = lines.findIndex((raw) => {
    const trimmed = raw.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  const firstContent = firstContentIndex >= 0 ? lines[firstContentIndex].trim() : "";
  const typeDeclaration = firstContent.match(/^graph\s+([a-z][a-z0-9_-]*)\s*$/i);
  if (!typeDeclaration) {
    errors.push(issue(firstContentIndex + 1 || 1, "Expected a `graph directed`, `graph optimized`, or `graph classified` declaration"));
    return { type, classes, nodes, edges: [], errors };
  }
  type = typeDeclaration[1].toLowerCase();
  if (!GRAPH_TYPES.includes(type)) {
    errors.push(issue(firstContentIndex + 1, `Graph type "${type}" is not supported`));
    return { type, classes, nodes, edges: [], errors };
  }

  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (index === firstContentIndex) return;

    const columnsDeclaration = trimmed.match(/^columns(?:\s+(.+?))?\s*$/i);
    if (columnsDeclaration) {
      if (type !== "classified") {
        errors.push(issue(line, "A `columns` declaration is only valid in a classified graph"));
        return;
      }
      if (columnsLine !== null) {
        errors.push(issue(line, `Columns were already declared on line ${columnsLine}`));
        return;
      }
      if (nodes.length) {
        errors.push(issue(line, "The columns declaration must appear before the first state"));
        current = null;
        return;
      }
      columnsLine = line;
      const declared = (columnsDeclaration[1] || "").trim().split(/\s+/).filter(Boolean);
      if (declared.length < 2) {
        errors.push(issue(line, "A classified graph needs at least two column classes"));
        return;
      }
      const normalized = declared.map((name) => name.toLowerCase());
      const invalid = declared.find((name) => !/^[a-z][a-z0-9_-]*$/i.test(name));
      if (invalid) {
        errors.push(issue(line, `Column class "${invalid}" must use letters, numbers, hyphens, or underscores`));
        return;
      }
      if (new Set(normalized).size !== normalized.length) {
        errors.push(issue(line, "Column classes must be unique"));
        return;
      }
      classes.push(...normalized);
      return;
    }

    const declaration = type === "classified"
      ? trimmed.match(/^state\s+(.+?)\s+\[([a-z][a-z0-9_-]*)\]\s*:\s*$/i)
      : trimmed.match(/^state\s+(.+?)\s*:\s*$/i);
    if (declaration) {
      const name = declaration[1].trim();
      const className = type === "classified" ? declaration[2].toLowerCase() : null;
      if (!name || name.includes("->")) {
        errors.push(issue(line, "State names cannot be empty or contain ->"));
        current = null;
        return;
      }
      if (names.has(name)) {
        errors.push(issue(line, `State "${name}" was already declared on line ${names.get(name).line}`));
        current = names.get(name);
        return;
      }
      current = { id: name, name, className, line, order: nodes.length };
      names.set(name, current);
      nodes.push(current);
      return;
    }

    if (type === "classified" && /^state\b/i.test(trimmed)) {
      errors.push(issue(line, "Classified states use `state Name [class]:`"));
      current = null;
      return;
    }

    const edge = trimmed.match(/^(.+?)\s*->\s*(.+?)\s*$/);
    if (edge) {
      if (!current) {
        errors.push(issue(line, "An arrow must appear below a state declaration"));
        return;
      }
      const label = edge[1].trim();
      const target = edge[2].trim();
      if (!label || !target) {
        errors.push(issue(line, "Arrows need both a label and a target state"));
        return;
      }
      pendingEdges.push({
        id: `edge-${pendingEdges.length}`,
        source: current.id,
        target,
        label,
        line,
        order: pendingEdges.length,
      });
      return;
    }

    errors.push(issue(line, type === "classified"
      ? 'Expected `state Name [class]:` or `label -> Target state`'
      : 'Expected `state Name:` or `label -> Target state`'));
  });

  if (type === "classified" && columnsLine === null) {
    errors.push(issue(firstContentIndex + 1, "A classified graph needs a columns declaration such as `columns class-a class-b`"));
  }
  if (type === "classified" && classes.length) {
    for (const node of nodes) {
      if (!classes.includes(node.className)) {
        errors.push(issue(node.line, `State class "${node.className}" is not listed in the columns declaration`));
      }
    }
  }

  const edges = pendingEdges.filter((edge) => {
    if (names.has(edge.target)) return true;
    errors.push(issue(edge.line, `Target state "${edge.target}" has no declaration`));
    return false;
  });

  errors.sort((left, right) => left.line - right.line);
  return { type, classes, nodes, edges, errors };
}

export function setGraphType(source, type) {
  if (!GRAPH_TYPES.includes(type)) throw new RangeError(`Unsupported graph type: ${type}`);
  const lines = String(source).split(/\r?\n/);
  const firstContentIndex = lines.findIndex((raw) => {
    const trimmed = raw.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  const currentType = firstContentIndex >= 0
    ? lines[firstContentIndex].trim().match(/^graph\s+([a-z][a-z0-9_-]*)\s*$/i)?.[1]?.toLowerCase()
    : null;

  if (currentType === "classified" && type !== "classified") {
    const withoutClasses = lines
      .filter((raw, index) => index === firstContentIndex || !/^\s*columns(?:\s|$)/i.test(raw))
      .map((raw) => raw.replace(/^(\s*state\s+)(.+?)\s+\[[a-z][a-z0-9_-]*\]\s*:\s*$/i, "$1$2:"));
    withoutClasses[firstContentIndex] = `graph ${type}`;
    return withoutClasses.join("\n");
  }

  if (type === "classified" && currentType !== "classified") {
    const graph = parseGraph(String(source));
    const layers = graph.errors.length ? new Map() : naturalLayers(graph);
    for (const node of graph.nodes) {
      const className = (layers.get(node.id) ?? node.order) % 2 === 0 ? "class-a" : "class-b";
      lines[node.line - 1] = lines[node.line - 1].replace(/:\s*$/, ` [${className}]:`);
    }
    if (firstContentIndex >= 0 && /^graph\s+\S+/i.test(lines[firstContentIndex].trim())) {
      lines[firstContentIndex] = "graph classified";
      lines.splice(firstContentIndex + 1, 0, "columns class-a class-b");
      return lines.join("\n");
    }
    return ["graph classified", "columns class-a class-b", "", ...lines].join("\n");
  }

  if (firstContentIndex >= 0 && /^graph\s+\S+/i.test(lines[firstContentIndex].trim())) {
    lines[firstContentIndex] = `graph ${type}`;
    return lines.join("\n");
  }
  return [`graph ${type}`, "", ...lines].join("\n");
}

function graphTopology(graph) {
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!outgoing.get(edge.source).includes(edge.target)) {
      outgoing.get(edge.source).push(edge.target);
      if (edge.source !== edge.target) indegree.set(edge.target, indegree.get(edge.target) + 1);
    }
  }
  return { outgoing, indegree };
}

function naturalLayers(graph) {
  const { outgoing, indegree } = graphTopology(graph);
  return longestDagLayers(graph.nodes, outgoing, indegree)
    ?? breadthFirstLayers(graph.nodes, outgoing, indegree);
}

export function layoutGraph(graph, options = DEFAULT_LAYOUT_OPTIONS) {
  const geometry = layoutGeometry(options);
  if (!graph.nodes.length) {
    return {
      nodes: new Map(),
      edges: [],
      width: 720 * geometry.scale * geometry.horizontalShape,
      height: 460 * geometry.scale * geometry.verticalShape,
      scale: geometry.scale,
      options: geometry.options,
      optimization: null,
      columnHeaders: [],
      columnBands: [],
    };
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const { outgoing, indegree } = graphTopology(graph);
  const natural = longestDagLayers(graph.nodes, outgoing, indegree)
    ?? breadthFirstLayers(graph.nodes, outgoing, indegree);
  const layer = graph.type === "classified" && graph.classes?.length
    ? classifiedLayers(graph, outgoing, indegree, natural)
    : natural;

  const columns = [];
  graph.nodes.forEach((node) => {
    const column = layer.get(node.id);
    if (!columns[column]) columns[column] = [];
    columns[column].push(node.id);
  });

  const optimization = graph.type === "optimized" || graph.type === "classified"
    ? optimizeLayerOrder(graph, layer, columns)
    : null;

  const maximumRows = Math.max(...Array.from(columns, (column) => column?.length ?? 0));
  const rowGap = Math.max(geometry.rowGap, geometry.buffer * 2 + 16 * geometry.scale);
  const contentHeight = maximumRows * geometry.nodeHeight + Math.max(0, maximumRows - 1) * rowGap;
  const backwardCount = graph.edges.filter((edge) => layer.get(edge.target) < layer.get(edge.source)).length;
  const longForwardCount = graph.edges.filter((edge) => layer.get(edge.target) - layer.get(edge.source) > 1).length;
  const topRouteBand = backwardCount
    ? geometry.buffer + (22 + (backwardCount - 1) * 26) * geometry.scale
    : 0;
  const bottomRouteBand = longForwardCount ? (34 + (longForwardCount - 1) * 26) * geometry.scale : 0;
  const headerBand = graph.type === "classified" && graph.classes?.length ? 54 * geometry.scale : 0;
  const contentDrawingHeight = Math.max(420 * geometry.scale * geometry.verticalShape, contentHeight + (2 * geometry.margin));
  const drawingHeight = contentDrawingHeight + headerBand;
  const height = drawingHeight + topRouteBand + bottomRouteBand;
  const positions = new Map();
  const maximumLayer = Math.max(...layer.values());
  const columnGaps = Array.from({ length: maximumLayer }, () => geometry.layerGap);
  const forwardCounts = Array.from({ length: maximumLayer }, () => 0);
  for (const edge of graph.edges) {
    const sourceLayer = layer.get(edge.source);
    const targetLayer = layer.get(edge.target);
    if (targetLayer === sourceLayer + 1) {
      forwardCounts[sourceLayer] += 1;
      columnGaps[sourceLayer] = Math.max(columnGaps[sourceLayer], labelWidth(edge.label, geometry.scale) + 24 * geometry.scale);
    }
  }
  forwardCounts.forEach((count, index) => {
    columnGaps[index] = Math.max(
      columnGaps[index],
      geometry.buffer * 2
        + Math.max(0, count - 1) * geometry.parallelSpacing
        + 2 * geometry.forwardLaneSpacing,
    );
  });
  const columnX = [geometry.margin];
  for (let index = 1; index <= maximumLayer; index += 1) {
    columnX[index] = columnX[index - 1] + geometry.nodeWidth + columnGaps[index - 1];
  }

  columns.forEach((column, columnIndex) => {
    if (!column) return;
    const columnHeight = column.length * geometry.nodeHeight + Math.max(0, column.length - 1) * rowGap;
    const top = topRouteBand + headerBand + (contentDrawingHeight - columnHeight) / 2;
    column.forEach((id, rowIndex) => {
      positions.set(id, {
        id,
        name: nodeById.get(id).name,
        className: nodeById.get(id).className,
        x: columnX[columnIndex],
        y: top + rowIndex * (geometry.nodeHeight + rowGap),
        width: geometry.nodeWidth,
        height: geometry.nodeHeight,
      });
    });
  });

  const width = Math.max(720 * geometry.scale * geometry.horizontalShape, columnX[maximumLayer] + geometry.nodeWidth + geometry.margin);
  const columnHeaders = graph.type === "classified" && graph.classes?.length
    ? columnX.map((x, index) => {
      const classIndex = index % graph.classes.length;
      return {
        className: graph.classes[classIndex],
        classIndex,
        x,
        y: topRouteBand + 10 * geometry.scale,
        width: geometry.nodeWidth,
        height: 30 * geometry.scale,
        ...CLASS_COLUMN_PALETTE[classIndex % CLASS_COLUMN_PALETTE.length],
      };
    })
    : [];
  const columnBands = columnHeaders.map((header, index) => {
    const previousEnd = index ? columnX[index - 1] + geometry.nodeWidth : 0;
    const nextStart = index < columnX.length - 1 ? columnX[index + 1] : width;
    const left = index ? (previousEnd + columnX[index]) / 2 : 0;
    const right = index < columnX.length - 1
      ? (columnX[index] + geometry.nodeWidth + nextStart) / 2
      : width;
    return {
      className: header.className,
      classIndex: header.classIndex,
      x: left,
      y: topRouteBand + headerBand,
      width: right - left,
      height: contentDrawingHeight,
      color: header.band,
    };
  });
  const parallelCount = new Map();
  const ports = assignPorts(graph.edges, positions, layer, geometry);
  const backwardLanes = new Map(
    graph.edges
      .filter((edge) => positions.get(edge.target).x < positions.get(edge.source).x)
      .sort((left, right) => {
        const leftSpan = positions.get(left.source).x - positions.get(left.target).x;
        const rightSpan = positions.get(right.source).x - positions.get(right.target).x;
        return rightSpan - leftSpan || left.order - right.order;
      })
      .map((edge, index) => [edge.id, index]),
  );
  const longForwardLanes = new Map(
    graph.edges
      .filter((edge) => layer.get(edge.target) - layer.get(edge.source) > 1)
      .sort((left, right) => {
        const leftSpan = positions.get(left.target).x - positions.get(left.source).x;
        const rightSpan = positions.get(right.target).x - positions.get(right.source).x;
        return rightSpan - leftSpan || left.order - right.order;
      })
      .map((edge, index) => [edge.id, index]),
  );
  const forwardLanes = new Map();
  const forwardGroups = new Map();
  for (const edge of graph.edges) {
    const sourceLayer = layer.get(edge.source);
    const targetLayer = layer.get(edge.target);
    if (targetLayer !== sourceLayer + 1) continue;
    if (!forwardGroups.has(sourceLayer)) forwardGroups.set(sourceLayer, []);
    forwardGroups.get(sourceLayer).push(edge);
  }
  for (const edges of forwardGroups.values()) {
    edges.sort((left, right) => {
      const leftMiddle = positions.get(left.source).y + positions.get(left.target).y;
      const rightMiddle = positions.get(right.source).y + positions.get(right.target).y;
      return leftMiddle - rightMiddle || left.order - right.order;
    });
    edges.forEach((edge, index) => forwardLanes.set(edge.id, { index, count: edges.length }));
  }
  const routeLanes = new Map();
  const nextLane = (key) => {
    const lane = routeLanes.get(key) ?? 0;
    routeLanes.set(key, lane + 1);
    return lane;
  };
  const routeSpecs = new Map();
  for (const edge of graph.edges) {
    const key = `${edge.source}\u0000${edge.target}`;
    const count = parallelCount.get(key) ?? 0;
    parallelCount.set(key, count + 1);
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    const sourceLayer = layer.get(edge.source);
    const targetLayer = layer.get(edge.target);
    const route = targetLayer < sourceLayer
      ? { kind: "backward", lane: backwardLanes.get(edge.id) }
      : targetLayer > sourceLayer + 1
        ? { kind: "long-forward", lane: longForwardLanes.get(edge.id) }
        : targetLayer > sourceLayer
          ? { kind: "forward", lane: forwardLanes.get(edge.id) }
          : target.id === source.id
            ? { kind: "self", lane: nextLane(`self\u0000${source.id}`) }
            : { kind: "vertical", lane: nextLane(`vertical\u0000${source.x}`) };
    routeSpecs.set(edge.id, { ...route, parallelIndex: count });
  }

  const routedById = new Map();
  const occupiedSegments = [];
  for (const edge of graph.edges) {
    const route = routeSpecs.get(edge.id);
    if (route.kind === "long-forward") continue;
    const routed = routeEdge(
      edge,
      positions.get(edge.source),
      positions.get(edge.target),
      route.parallelIndex,
      ports.get(`${edge.id}:start`),
      ports.get(`${edge.id}:end`),
      route,
      geometry,
      occupiedSegments,
    );
    routedById.set(edge.id, routed);
    occupiedSegments.push(...routeSegments(routed));
  }

  const longForwardEdges = graph.edges
    .filter((edge) => routeSpecs.get(edge.id).kind === "long-forward")
    .sort((left, right) => {
      const leftSpan = layer.get(left.target) - layer.get(left.source);
      const rightSpan = layer.get(right.target) - layer.get(right.source);
      return rightSpan - leftSpan || left.order - right.order;
    });
  for (const edge of longForwardEdges) {
    const routed = routeLongForwardEdge(
      edge,
      positions.get(edge.source),
      positions.get(edge.target),
      ports.get(`${edge.id}:start`),
      ports.get(`${edge.id}:end`),
      routeSpecs.get(edge.id),
      positions,
      occupiedSegments,
      height,
      geometry,
    );
    routedById.set(edge.id, routed);
    occupiedSegments.push(...routeSegments(routed));
  }
  const routedEdges = graph.edges.map((edge) => routedById.get(edge.id));

  return {
    nodes: positions,
    edges: routedEdges,
    width,
    height,
    scale: geometry.scale,
    options: geometry.options,
    optimization,
    columnHeaders,
    columnBands,
  };
}

function layerOrderScore(graph, layers, columns) {
  const ranks = new Map();
  columns.forEach((column, columnIndex) => {
    (column || []).forEach((id, rowIndex) => ranks.set(id, { column: columnIndex, row: rowIndex }));
  });

  const forward = graph.edges.filter((edge) => layers.get(edge.target) > layers.get(edge.source));
  let crossings = 0;
  for (let leftIndex = 0; leftIndex < forward.length; leftIndex += 1) {
    const left = forward[leftIndex];
    const leftSource = ranks.get(left.source);
    const leftTarget = ranks.get(left.target);
    for (let rightIndex = leftIndex + 1; rightIndex < forward.length; rightIndex += 1) {
      const right = forward[rightIndex];
      const rightSource = ranks.get(right.source);
      const rightTarget = ranks.get(right.target);
      if (leftSource.column !== rightSource.column || leftTarget.column !== rightTarget.column) continue;
      if (left.source === right.source || left.target === right.target) continue;
      if ((leftSource.row - rightSource.row) * (leftTarget.row - rightTarget.row) < 0) crossings += 1;
    }
  }

  let distance = 0;
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    const source = ranks.get(edge.source);
    const target = ranks.get(edge.target);
    const sourceRows = Math.max(1, columns[source.column].length - 1);
    const targetRows = Math.max(1, columns[target.column].length - 1);
    distance += Math.abs(source.row / sourceRows - target.row / targetRows);
  }
  return { crossings, distance };
}

function compareLayerScores(left, right) {
  if (left.crossings !== right.crossings) return left.crossings - right.crossings;
  if (Math.abs(left.distance - right.distance) > 1e-9) return left.distance - right.distance;
  return 0;
}

function optimizeLayerOrder(graph, layers, columns) {
  const before = layerOrderScore(graph, layers, columns);
  let current = before;
  let attempts = 0;
  let accepted = 0;
  let passes = 0;
  const maximumPasses = Math.max(2, Math.min(24, graph.nodes.length));

  for (; passes < maximumPasses; passes += 1) {
    let changed = false;
    const reverse = passes % 2 === 1;
    const columnIndexes = Array.from(columns, (_, index) => index);
    if (reverse) columnIndexes.reverse();
    for (const columnIndex of columnIndexes) {
      const column = columns[columnIndex];
      if (!column || column.length < 2) continue;
      const pairIndexes = Array.from({ length: column.length - 1 }, (_, index) => index);
      if (reverse) pairIndexes.reverse();
      for (const rowIndex of pairIndexes) {
        attempts += 1;
        [column[rowIndex], column[rowIndex + 1]] = [column[rowIndex + 1], column[rowIndex]];
        const candidate = layerOrderScore(graph, layers, columns);
        if (compareLayerScores(candidate, current) < 0) {
          current = candidate;
          accepted += 1;
          changed = true;
        } else {
          [column[rowIndex], column[rowIndex + 1]] = [column[rowIndex + 1], column[rowIndex]];
        }
      }
    }
    if (!changed) {
      passes += 1;
      break;
    }
  }

  return { passes, attempts, accepted, before, after: current };
}

function longestDagLayers(nodes, outgoing, indegree) {
  const remaining = new Map(indegree);
  const queue = nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  let cursor = 0;
  let visited = 0;

  while (cursor < queue.length) {
    const source = queue[cursor];
    cursor += 1;
    visited += 1;
    for (const target of outgoing.get(source)) {
      if (target === source) return null;
      remaining.set(target, remaining.get(target) - 1);
      if (remaining.get(target) === 0) queue.push(target);
    }
  }

  if (visited !== nodes.length) return null;

  const distanceToSink = new Map();
  for (const source of [...queue].reverse()) {
    const distances = outgoing.get(source).map((target) => distanceToSink.get(target) + 1);
    distanceToSink.set(source, distances.length ? Math.max(...distances) : 0);
  }

  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) {
    for (const target of outgoing.get(node.id)) incoming.get(target).push(node.id);
  }

  const layer = new Map();
  const assigned = new Set();
  for (const node of nodes) {
    if (assigned.has(node.id)) continue;
    const members = [];
    const stack = [node.id];
    assigned.add(node.id);
    while (stack.length) {
      const id = stack.pop();
      members.push(id);
      for (const neighbor of [...outgoing.get(id), ...incoming.get(id)]) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        stack.push(neighbor);
      }
    }
    const depth = Math.max(...members.map((id) => distanceToSink.get(id)));
    for (const id of members) layer.set(id, depth - distanceToSink.get(id));
  }
  return layer;
}

function breadthFirstLayers(nodes, outgoing, indegree) {
  const layer = new Map();
  const roots = [
    ...nodes.filter((node) => indegree.get(node.id) === 0),
    ...nodes.filter((node) => indegree.get(node.id) !== 0),
  ];
  for (const root of roots) {
    if (layer.has(root.id)) continue;
    layer.set(root.id, 0);
    const queue = [root.id];
    let cursor = 0;
    while (cursor < queue.length) {
      const source = queue[cursor];
      cursor += 1;
      for (const target of outgoing.get(source)) {
        if (target === source || layer.has(target)) continue;
        layer.set(target, layer.get(source) + 1);
        queue.push(target);
      }
    }
  }
  return layer;
}

function classifiedLayers(graph, outgoing, indegree, fallback) {
  const classIndex = new Map(graph.classes.map((name, index) => [name, index]));
  const classCount = graph.classes.length;
  const alignedLayer = (minimum, className) => {
    const desired = classIndex.get(className);
    if (desired === undefined) return minimum;
    const remainder = ((minimum % classCount) + classCount) % classCount;
    return minimum + ((desired - remainder + classCount) % classCount);
  };

  const remaining = new Map(indegree);
  const queue = graph.nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  let cursor = 0;
  while (cursor < queue.length) {
    const source = queue[cursor];
    cursor += 1;
    for (const target of outgoing.get(source)) {
      if (target === source) continue;
      remaining.set(target, remaining.get(target) - 1);
      if (remaining.get(target) === 0) queue.push(target);
    }
  }

  if (queue.length !== graph.nodes.length) {
    return new Map(graph.nodes.map((node) => [
      node.id,
      alignedLayer(fallback.get(node.id) ?? 0, node.className),
    ]));
  }

  const incoming = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) {
    if (edge.source !== edge.target && !incoming.get(edge.target).includes(edge.source)) {
      incoming.get(edge.target).push(edge.source);
    }
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const layers = new Map();
  for (const id of queue) {
    const predecessorLayers = incoming.get(id).map((source) => layers.get(source) + 1);
    const minimum = predecessorLayers.length ? Math.max(...predecessorLayers) : 0;
    layers.set(id, alignedLayer(minimum, nodeById.get(id).className));
  }
  return layers;
}

function assignPorts(edges, positions, layers, geometry) {
  const groups = new Map();
  const descriptors = [];

  for (const edge of edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (source.id === target.id) continue;
    let startSide;
    let endSide;
    let portOrder = edge.order;
    const sourceLayer = layers.get(edge.source);
    const targetLayer = layers.get(edge.target);
    if (targetLayer < sourceLayer) {
      startSide = "top";
      endSide = "top";
      portOrder = -(sourceLayer - targetLayer);
    } else if (targetLayer > sourceLayer) {
      startSide = "right";
      endSide = "left";
    } else if (target.y > source.y) {
      startSide = "bottom";
      endSide = "top";
    } else {
      startSide = "top";
      endSide = "bottom";
    }
    descriptors.push(
      { key: `${edge.id}:start`, node: source, side: startSide, order: portOrder, tie: edge.order },
      { key: `${edge.id}:end`, node: target, side: endSide, order: portOrder, tie: edge.order },
    );
  }

  for (const descriptor of descriptors) {
    const key = `${descriptor.node.id}\u0000${descriptor.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(descriptor);
  }

  const ports = new Map();
  for (const group of groups.values()) {
    group.sort((left, right) => left.order - right.order || left.tie - right.tie || left.key.localeCompare(right.key));
    group.forEach((descriptor, index) => {
      const spacing = descriptor.side === "left" || descriptor.side === "right"
        ? geometry.parallelSpacing
        : 22 * geometry.scale;
      ports.set(descriptor.key, {
        side: descriptor.side,
        offset: (index - (group.length - 1) / 2) * spacing,
      });
    });
  }
  return ports;
}

function portPoint(node, port) {
  if (port.side === "left") return { x: node.x, y: node.y + node.height / 2 + port.offset };
  if (port.side === "right") return { x: node.x + node.width, y: node.y + node.height / 2 + port.offset };
  if (port.side === "top") return { x: node.x + node.width / 2 + port.offset, y: node.y };
  return { x: node.x + node.width / 2 + port.offset, y: node.y + node.height };
}

function alternatingOffset(index, spacing) {
  if (index === 0) return 0;
  const magnitude = Math.ceil(index / 2) * spacing;
  return index % 2 ? magnitude : -magnitude;
}

function routeSegments(edge) {
  const segments = [];
  for (let index = 1; index < edge.points.length; index += 1) {
    const start = edge.points[index - 1];
    const end = edge.points[index];
    if (start.x === end.x && start.y === end.y) continue;
    segments.push({
      edge: edge.id,
      start,
      end,
      horizontal: start.y === end.y,
    });
  }
  return segments;
}

function parallelSegmentsTooClose(left, right, clearance) {
  if (left.horizontal !== right.horizontal) return false;
  const leftLine = left.horizontal ? left.start.y : left.start.x;
  const rightLine = right.horizontal ? right.start.y : right.start.x;
  if (Math.abs(leftLine - rightLine) >= clearance - 1e-6) return false;
  const leftRange = left.horizontal
    ? [Math.min(left.start.x, left.end.x), Math.max(left.start.x, left.end.x)]
    : [Math.min(left.start.y, left.end.y), Math.max(left.start.y, left.end.y)];
  const rightRange = right.horizontal
    ? [Math.min(right.start.x, right.end.x), Math.max(right.start.x, right.end.x)]
    : [Math.min(right.start.y, right.end.y), Math.max(right.start.y, right.end.y)];
  return Math.min(leftRange[1], rightRange[1]) - Math.max(leftRange[0], rightRange[0]) > 1e-6;
}

function segmentsCross(left, right) {
  if (left.horizontal === right.horizontal) return false;
  const horizontal = left.horizontal ? left : right;
  const vertical = left.horizontal ? right : left;
  const horizontalRange = [
    Math.min(horizontal.start.x, horizontal.end.x),
    Math.max(horizontal.start.x, horizontal.end.x),
  ];
  const verticalRange = [
    Math.min(vertical.start.y, vertical.end.y),
    Math.max(vertical.start.y, vertical.end.y),
  ];
  return vertical.start.x > horizontalRange[0] + 1e-6
    && vertical.start.x < horizontalRange[1] - 1e-6
    && horizontal.start.y > verticalRange[0] + 1e-6
    && horizontal.start.y < verticalRange[1] - 1e-6;
}

function availableHorizontalGaps(positions, sourceId, targetId, left, right, height, clearance, unit) {
  const blocked = [];
  for (const node of positions.values()) {
    if (node.id === sourceId || node.id === targetId) continue;
    const overlapsSpan = Math.max(left, node.x - clearance) < Math.min(right, node.x + node.width + clearance);
    if (!overlapsSpan) continue;
    blocked.push([
      Math.max(0, node.y - clearance),
      Math.min(height, node.y + node.height + clearance),
    ]);
  }
  blocked.sort((leftInterval, rightInterval) => leftInterval[0] - rightInterval[0]);
  const merged = [];
  for (const interval of blocked) {
    const previous = merged.at(-1);
    if (!previous || interval[0] > previous[1]) merged.push([...interval]);
    else previous[1] = Math.max(previous[1], interval[1]);
  }

  const gaps = [];
  let cursor = 8 * unit;
  const limit = height - 8 * unit;
  for (const interval of merged) {
    if (interval[0] > cursor) gaps.push([cursor, Math.min(interval[0], limit)]);
    cursor = Math.max(cursor, interval[1]);
    if (cursor >= limit) break;
  }
  if (cursor < limit) gaps.push([cursor, limit]);
  return gaps.filter(([start, end]) => end - start > unit);
}

function routeLongForwardEdge(edge, source, target, startPort, endPort, route, positions, occupiedSegments, layoutHeight, geometry) {
  const unit = geometry.scale;
  const start = portPoint(source, startPort);
  const end = portPoint(target, endPort);
  const stubDistance = geometry.buffer + route.lane * geometry.parallelSpacing;
  const chooseUnusedVertical = (initial, minimum, maximum, leadPoint, leadFromPort) => {
    for (let index = 0; index < 24; index += 1) {
      const candidate = initial + alternatingOffset(index, geometry.parallelSpacing);
      if (candidate <= minimum || candidate >= maximum) continue;
      const verticalOccupied = occupiedSegments.some((segment) => (
        !segment.horizontal && Math.abs(segment.start.x - candidate) < geometry.parallelSpacing - 1e-6
      ));
      if (verticalOccupied) continue;
      const lead = {
        horizontal: true,
        start: leadFromPort ? leadPoint : { x: candidate, y: leadPoint.y },
        end: leadFromPort ? { x: candidate, y: leadPoint.y } : leadPoint,
      };
      const leadOccupied = occupiedSegments.some((segment) => (
        parallelSegmentsTooClose(lead, segment, geometry.parallelSpacing)
      ));
      if (!leadOccupied) return candidate;
    }
    return initial;
  };
  const middleX = (start.x + end.x) / 2;
  const exitX = chooseUnusedVertical(
    start.x + stubDistance,
    start.x + geometry.buffer - unit,
    middleX - 3 * unit,
    start,
    true,
  );
  const entryX = chooseUnusedVertical(
    end.x - stubDistance,
    middleX + 3 * unit,
    end.x - geometry.buffer + unit,
    end,
    false,
  );
  const left = Math.min(exitX, entryX);
  const right = Math.max(exitX, entryX);
  const clearance = 16 * unit;
  const preferredY = (start.y + end.y) / 2;
  const gaps = availableHorizontalGaps(
    positions,
    edge.source,
    edge.target,
    left,
    right,
    layoutHeight,
    clearance,
    unit,
  );
  const candidateYs = new Set();
  for (const [gapStart, gapEnd] of gaps) {
    const minimum = gapStart + unit;
    const maximum = gapEnd - unit;
    if (maximum < minimum) continue;
    candidateYs.add(Math.max(minimum, Math.min(maximum, preferredY)));
    candidateYs.add((minimum + maximum) / 2);
    for (let candidate = minimum; candidate <= maximum; candidate += geometry.parallelSpacing) {
      candidateYs.add(candidate);
    }
    candidateYs.add(maximum);
  }

  let best = null;
  for (const laneY of candidateYs) {
    const points = [
      start,
      { x: exitX, y: start.y },
      { x: exitX, y: laneY },
      { x: entryX, y: laneY },
      { x: entryX, y: end.y },
      end,
    ].filter((point, index, list) => index === 0 || point.x !== list[index - 1].x || point.y !== list[index - 1].y);
    const candidate = { id: edge.id, points };
    const segments = routeSegments(candidate);
    if (segments.some((segment) => occupiedSegments.some((occupied) => (
      parallelSegmentsTooClose(segment, occupied, geometry.parallelSpacing)
    )))) continue;
    const crossings = segments.reduce((total, segment) => (
      total + occupiedSegments.filter((occupied) => segmentsCross(segment, occupied)).length
    ), 0);
    const length = segments.reduce((total, segment) => (
      total + Math.abs(segment.end.x - segment.start.x) + Math.abs(segment.end.y - segment.start.y)
    ), 0);
    const score = length + crossings * 72 * unit;
    if (!best || score < best.score || (score === best.score && Math.abs(laneY - preferredY) < Math.abs(best.laneY - preferredY))) {
      best = { laneY, points, score };
    }
  }

  if (!best) {
    const laneY = layoutHeight - (18 + route.lane * 18) * unit;
    best = {
      laneY,
      points: [
        start,
        { x: exitX, y: start.y },
        { x: exitX, y: laneY },
        { x: entryX, y: laneY },
        { x: entryX, y: end.y },
        end,
      ],
    };
  }

  const points = best.points.filter((point, index) => index === 0 || point.x !== best.points[index - 1].x || point.y !== best.points[index - 1].y);
  const labelPoint = { x: (exitX + entryX) / 2, y: best.laneY };
  const arrow = arrowHead(points.at(-2), points.at(-1), unit);
  return { ...edge, points, start: points[0], end: points.at(-1), labelPoint, arrow };
}

function routeEdge(edge, source, target, parallelIndex, startPort, endPort, route, geometry, occupiedSegments = []) {
  const unit = geometry.scale;
  const offset = parallelIndex * 18 * unit;
  let points;
  let labelPoint;

  if (route.kind === "self") {
    const start = { x: source.x + source.width, y: source.y + 19 * unit };
    const end = { x: source.x + source.width, y: source.y + source.height - 19 * unit };
    const laneX = start.x + geometry.buffer + route.lane * 22 * unit + offset;
    points = [start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end];
    labelPoint = { x: laneX, y: (start.y + end.y) / 2 };
  } else if (route.kind === "forward") {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const laneLeft = start.x + geometry.buffer + geometry.forwardLaneSpacing;
    const laneRight = end.x - geometry.buffer - geometry.forwardLaneSpacing;
    const preferredLaneX = laneLeft + (laneRight - laneLeft) * ((route.lane.index + 1) / (route.lane.count + 1));
    const laneXs = [];
    for (let laneX = laneLeft; laneX <= laneRight; laneX += geometry.parallelSpacing) laneXs.push(laneX);
    laneXs.push(laneRight, preferredLaneX);
    laneXs.sort((left, right) => Math.abs(left - preferredLaneX) - Math.abs(right - preferredLaneX));
    let laneX = preferredLaneX;
    let bestScore = Infinity;
    for (const candidateX of laneXs) {
      const candidate = {
        id: edge.id,
        points: [
          start,
          { x: candidateX, y: start.y },
          { x: candidateX, y: end.y },
          end,
        ],
      };
      const segments = routeSegments(candidate);
      if (segments.some((segment) => occupiedSegments.some((occupied) => (
        parallelSegmentsTooClose(segment, occupied, geometry.parallelSpacing)
      )))) continue;
      const crossings = segments.reduce((total, segment) => (
        total + occupiedSegments.filter((occupied) => segmentsCross(segment, occupied)).length
      ), 0);
      const score = crossings * 72 * unit + Math.abs(candidateX - preferredLaneX);
      if (score >= bestScore) continue;
      laneX = candidateX;
      bestScore = score;
    }
    points = [
      start,
      { x: laneX, y: start.y },
      { x: laneX, y: end.y },
      end,
    ];
    labelPoint = Math.abs(start.y - end.y) > 22 * unit
      ? { x: laneX, y: (start.y + end.y) / 2 }
      : { x: (start.x + end.x) / 2, y: start.y };
  } else if (route.kind === "backward") {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const laneY = (24 + route.lane * 26) * unit;
    const startTrackY = start.y - geometry.buffer - route.lane * geometry.parallelSpacing;
    const endTrackY = end.y - geometry.buffer - route.lane * geometry.parallelSpacing;
    const exitX = start.x - 12 * unit - route.lane * geometry.parallelSpacing;
    const entryX = end.x - 12 * unit - route.lane * geometry.parallelSpacing;
    points = [
      start,
      { x: start.x, y: startTrackY },
      { x: exitX, y: startTrackY },
      { x: exitX, y: laneY },
      { x: entryX, y: laneY },
      { x: entryX, y: endTrackY },
      { x: end.x, y: endTrackY },
      end,
    ];
    labelPoint = { x: (start.x + end.x) / 2, y: laneY };
  } else {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const downward = target.y > source.y;
    const laneX = source.x - 38 * unit - route.lane * 22 * unit - offset;
    const startY = start.y + (downward ? geometry.buffer : -geometry.buffer);
    const endY = end.y + (downward ? -geometry.buffer : geometry.buffer);
    points = [
      start,
      { x: start.x, y: startY },
      { x: laneX, y: startY },
      { x: laneX, y: endY },
      { x: end.x, y: endY },
      end,
    ];
    labelPoint = { x: laneX, y: (startY + endY) / 2 };
  }

  points = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  const start = points[0];
  const end = points.at(-1);
  const arrow = arrowHead(points.at(-2), end, unit);
  return { ...edge, points, start, end, labelPoint, arrow };
}

function arrowHead(previous, end, scale = 1) {
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
  const length = 11 * scale;
  const spread = 5.5 * scale;
  return [
    end,
    {
      x: end.x - length * Math.cos(angle) + spread * Math.sin(angle),
      y: end.y - length * Math.sin(angle) - spread * Math.cos(angle),
    },
    {
      x: end.x - length * Math.cos(angle) - spread * Math.sin(angle),
      y: end.y - length * Math.sin(angle) + spread * Math.cos(angle),
    },
  ];
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function labelWidth(label, scale = 1) {
  return Math.max(38, label.length * 7.8 + 16) * scale;
}

function nodeLabelLines(name, nodeWidth = BASE_NODE_WIDTH) {
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || name.length * 7.6 <= nodeWidth - 24) return [name];
  let best = null;
  for (let index = 1; index < words.length; index += 1) {
    const lines = [words.slice(0, index).join(" "), words.slice(index).join(" ")];
    const score = Math.max(...lines.map((line) => line.length));
    if (!best || score < best.score) best = { lines, score };
  }
  return best.lines;
}

export function renderSvg(graph, layout) {
  const scale = layout.scale || 1;
  const bands = (layout.columnBands || []).map((band) => `<rect class="column-band" data-class="${escapeXml(band.className)}" x="${band.x}" y="${band.y}" width="${band.width}" height="${band.height}" fill="${band.color}" />`).join("\n");
  const headers = (layout.columnHeaders || []).map((header) => {
    const centerX = header.x + header.width / 2;
    const bottom = header.y + header.height;
    return `<g class="column-header" data-class="${escapeXml(header.className)}">
      <rect x="${header.x}" y="${header.y}" width="${header.width}" height="${header.height}" fill="${header.header}" />
      <text x="${centerX}" y="${header.y + 20 * scale}">${escapeXml(header.className.toUpperCase())}</text>
      <line x1="${header.x}" y1="${bottom}" x2="${header.x + header.width}" y2="${bottom}" stroke="${header.ink}" />
    </g>`;
  }).join("\n");
  const edges = layout.edges.map((edge) => {
    const width = labelWidth(edge.label, scale);
    const path = edge.points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");
    const arrow = edge.arrow.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    return `<g class="edge">
      <path d="${path}" />
      <polygon points="${arrow}" />
      <rect x="${edge.labelPoint.x - width / 2}" y="${edge.labelPoint.y - 12 * scale}" width="${width}" height="${24 * scale}" />
      <text x="${edge.labelPoint.x}" y="${edge.labelPoint.y + 4 * scale}">${escapeXml(edge.label)}</text>
    </g>`;
  }).join("\n");

  const nodes = [...layout.nodes.values()].map((node) => {
    const lines = nodeLabelLines(node.name, node.width / scale);
    const longest = Math.max(...lines.map((line) => line.length));
    const fontSize = Math.max(13 * scale, Math.min(14 * scale, (node.width - 24 * scale) / (longest * 0.58)));
    const centerX = node.x + node.width / 2;
    const firstY = node.y + node.height / 2 + 5 * scale - (lines.length - 1) * 8 * scale;
    const text = lines.map((line, index) => `<tspan x="${centerX}"${index ? ` dy="${17 * scale}"` : ""}>${escapeXml(line)}</tspan>`).join("");
    return `<g class="node">
      <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" />
      <text x="${centerX}" y="${firstY}" style="font-size:${fontSize.toFixed(2)}px">${text}</text>
    </g>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img" aria-label="Compiled state diagram">
    <style>
      .edge path { fill: none; stroke: #111; stroke-width: ${1.6 * scale}; stroke-linecap: square; stroke-linejoin: round; }
      .edge polygon { fill: #111; }
      .edge rect { fill: #fff; }
      .edge text { fill: #111; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${13 * scale}px; text-anchor: middle; }
      .column-header text { fill: #111; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${12 * scale}px; font-weight: 800; letter-spacing: ${1.2 * scale}px; text-anchor: middle; }
      .column-header line { stroke-width: ${1 * scale}; }
      .node rect { fill: #fff; stroke: #111; stroke-width: ${2 * scale}; }
      .node text { fill: #111; font-family: Inter, Arial, sans-serif; font-size: ${14 * scale}px; font-weight: 600; text-anchor: middle; }
    </style>
    <rect width="100%" height="100%" fill="#fff" />
    ${bands}
    ${headers}
    ${edges}
    ${nodes}
  </svg>`;
}

function pdfEscape(value) {
  return String(value)
    .replace(/[^\x20-\x7e]/g, "?")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function pdfDocument(objects) {
  let document = "%PDF-1.4\n%BOXLINE\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = document.length;
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = document.length;
  document += `xref\n0 ${objects.length + 1}\n`;
  document += "0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    document += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(document);
}

export function buildPdf(graph, layout) {
  const pageWidth = 792;
  const pageHeight = 612;
  const pageMargin = 34;
  const scale = Math.min(
    (pageWidth - 2 * pageMargin) / layout.width,
    (pageHeight - 2 * pageMargin) / layout.height,
    1.35,
  );
  const offsetX = (pageWidth - layout.width * scale) / 2;
  const offsetY = (pageHeight - layout.height * scale) / 2;
  const point = ({ x, y }) => ({
    x: offsetX + x * scale,
    y: pageHeight - (offsetY + y * scale),
  });
  const commands = ["1 J", "1 j", "0 0 0 RG", "0 0 0 rg"];

  const pdfColor = (hex) => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((channel) => parseInt(channel, 16) / 255);
    return channels.map((channel) => channel.toFixed(3)).join(" ");
  };

  for (const band of layout.columnBands || []) {
    const topLeft = point({ x: band.x, y: band.y });
    const bottomRight = point({ x: band.x + band.width, y: band.y + band.height });
    commands.push(`${pdfColor(band.color)} rg ${topLeft.x.toFixed(3)} ${bottomRight.y.toFixed(3)} ${(band.width * scale).toFixed(3)} ${(band.height * scale).toFixed(3)} re f`);
  }

  for (const header of layout.columnHeaders || []) {
    const topLeft = point({ x: header.x, y: header.y });
    const bottomRight = point({ x: header.x + header.width, y: header.y + header.height });
    const start = point({ x: header.x, y: header.y + header.height });
    const end = point({ x: header.x + header.width, y: header.y + header.height });
    const center = point({ x: header.x + header.width / 2, y: header.y + header.height / 2 });
    const label = header.className.toUpperCase();
    const fontSize = Math.max(7, Math.min(9, 10 * scale));
    commands.push(`${pdfColor(header.header)} rg ${topLeft.x.toFixed(3)} ${bottomRight.y.toFixed(3)} ${(header.width * scale).toFixed(3)} ${(header.height * scale).toFixed(3)} re f`);
    commands.push(`${pdfColor(header.ink)} RG`);
    commands.push(`${Math.max(0.6, scale).toFixed(3)} w ${start.x.toFixed(3)} ${start.y.toFixed(3)} m ${end.x.toFixed(3)} ${end.y.toFixed(3)} l S`);
    commands.push("0.27 0.27 0.25 rg");
    commands.push(`BT /F2 ${fontSize.toFixed(3)} Tf ${(center.x - label.length * fontSize * 0.29).toFixed(3)} ${(center.y - fontSize * 0.34).toFixed(3)} Td (${pdfEscape(label)}) Tj ET`);
    commands.push("0 0 0 RG", "0 0 0 rg");
  }

  for (const edge of layout.edges) {
    const path = edge.points.map(point);
    commands.push(`${Math.max(0.8, 1.4 * scale).toFixed(3)} w`);
    commands.push(`${path[0].x.toFixed(3)} ${path[0].y.toFixed(3)} m ${path.slice(1).map((pathPoint) => `${pathPoint.x.toFixed(3)} ${pathPoint.y.toFixed(3)} l`).join(" ")} S`);

    const arrow = edge.arrow.map(point);
    commands.push(`${arrow[0].x.toFixed(3)} ${arrow[0].y.toFixed(3)} m ${arrow[1].x.toFixed(3)} ${arrow[1].y.toFixed(3)} l ${arrow[2].x.toFixed(3)} ${arrow[2].y.toFixed(3)} l h f`);

    const label = point(edge.labelPoint);
    const fontSize = Math.max(7, Math.min(10, 12 * scale));
    const width = Math.max(24, edge.label.length * fontSize * 0.58 + 10);
    const height = fontSize + 7;
    commands.push(`1 1 1 rg ${(label.x - width / 2).toFixed(3)} ${(label.y - height / 2).toFixed(3)} ${width.toFixed(3)} ${height.toFixed(3)} re f`);
    commands.push("0 0 0 rg");
    commands.push(`BT /F1 ${fontSize.toFixed(3)} Tf ${(label.x - edge.label.length * fontSize * 0.29).toFixed(3)} ${(label.y - fontSize * 0.33).toFixed(3)} Td (${pdfEscape(edge.label)}) Tj ET`);
  }

  for (const node of layout.nodes.values()) {
    const bottomLeft = point({ x: node.x, y: node.y + node.height });
    commands.push(`${Math.max(1, 1.8 * scale).toFixed(3)} w`);
    commands.push(`${bottomLeft.x.toFixed(3)} ${bottomLeft.y.toFixed(3)} ${(node.width * scale).toFixed(3)} ${(node.height * scale).toFixed(3)} re S`);
    const center = point({ x: node.x + node.width / 2, y: node.y + node.height / 2 });
    const fontSize = Math.max(8, Math.min(12, 14 * scale));
    commands.push(`BT /F2 ${fontSize.toFixed(3)} Tf ${(center.x - node.name.length * fontSize * 0.29).toFixed(3)} ${(center.y - fontSize * 0.34).toFixed(3)} Td (${pdfEscape(node.name)}) Tj ET`);
  }

  const stream = `${commands.join("\n")}\n`;
  return pdfDocument([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ]);
}

export const dimensions = {
  nodeWidth: BASE_NODE_WIDTH,
  nodeHeight: BASE_NODE_HEIGHT,
};
