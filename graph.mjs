const BASE_NODE_WIDTH = 184;
const BASE_NODE_HEIGHT = 64;
const BASE_LAYER_GAP = 168;
const BASE_ROW_GAP = 76;
const BASE_MARGIN = 64;
const BASE_FORWARD_LANE_SPACING = 16;

export const DEFAULT_LAYOUT_OPTIONS = Object.freeze({
  size: 1,
  shape: 0,
  compression: 1,
});

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
    margin: BASE_MARGIN * normalized.size,
    forwardLaneSpacing: BASE_FORWARD_LANE_SPACING * normalized.size,
  };
}

export const EXAMPLE_SOURCE = `# A state box begins with "state Name:"
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
  const names = new Map();
  let current = null;

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const declaration = trimmed.match(/^state\s+(.+?)\s*:\s*$/i);
    if (declaration) {
      const name = declaration[1].trim();
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
      current = { id: name, name, line, order: nodes.length };
      names.set(name, current);
      nodes.push(current);
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

    errors.push(issue(line, 'Expected `state Name:` or `label -> Target state`'));
  });

  const edges = pendingEdges.filter((edge) => {
    if (names.has(edge.target)) return true;
    errors.push(issue(edge.line, `Target state "${edge.target}" has no declaration`));
    return false;
  });

  errors.sort((left, right) => left.line - right.line);
  return { nodes, edges, errors };
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
    };
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!outgoing.get(edge.source).includes(edge.target)) {
      outgoing.get(edge.source).push(edge.target);
      if (edge.source !== edge.target) indegree.set(edge.target, indegree.get(edge.target) + 1);
    }
  }

  const layer = longestDagLayers(graph.nodes, outgoing, indegree)
    ?? breadthFirstLayers(graph.nodes, outgoing, indegree);

  const columns = [];
  graph.nodes.forEach((node) => {
    const column = layer.get(node.id);
    if (!columns[column]) columns[column] = [];
    columns[column].push(node.id);
  });

  const maximumRows = Math.max(...columns.map((column) => column?.length ?? 0));
  const contentHeight = maximumRows * geometry.nodeHeight + Math.max(0, maximumRows - 1) * geometry.rowGap;
  const backwardCount = graph.edges.filter((edge) => layer.get(edge.target) < layer.get(edge.source)).length;
  const longForwardCount = graph.edges.filter((edge) => layer.get(edge.target) - layer.get(edge.source) > 1).length;
  const topRouteBand = backwardCount ? (34 + (backwardCount - 1) * 26) * geometry.scale : 0;
  const bottomRouteBand = longForwardCount ? (34 + (longForwardCount - 1) * 26) * geometry.scale : 0;
  const drawingHeight = Math.max(420 * geometry.scale * geometry.verticalShape, contentHeight + (2 * geometry.margin));
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
    columnGaps[index] = Math.max(columnGaps[index], (count + 1) * geometry.forwardLaneSpacing);
  });
  const columnX = [geometry.margin];
  for (let index = 1; index <= maximumLayer; index += 1) {
    columnX[index] = columnX[index - 1] + geometry.nodeWidth + columnGaps[index - 1];
  }

  columns.forEach((column, columnIndex) => {
    if (!column) return;
    const columnHeight = column.length * geometry.nodeHeight + Math.max(0, column.length - 1) * geometry.rowGap;
    const top = topRouteBand + (drawingHeight - columnHeight) / 2;
    column.forEach((id, rowIndex) => {
      positions.set(id, {
        id,
        name: nodeById.get(id).name,
        x: columnX[columnIndex],
        y: top + rowIndex * (geometry.nodeHeight + geometry.rowGap),
        width: geometry.nodeWidth,
        height: geometry.nodeHeight,
      });
    });
  });

  const width = Math.max(720 * geometry.scale * geometry.horizontalShape, columnX[maximumLayer] + geometry.nodeWidth + geometry.margin);
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
  };
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
      const spacing = (descriptor.side === "left" || descriptor.side === "right" ? 14 : 22) * geometry.scale;
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

function segmentsOverlap(left, right) {
  if (left.horizontal !== right.horizontal) return false;
  const leftLine = left.horizontal ? left.start.y : left.start.x;
  const rightLine = right.horizontal ? right.start.y : right.start.x;
  if (Math.abs(leftLine - rightLine) > 1e-6) return false;
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
  const stubDistance = (14 + route.lane * 6) * unit;
  const chooseUnusedVertical = (initial, minimum, maximum) => {
    for (let index = 0; index < 24; index += 1) {
      const candidate = initial + alternatingOffset(index, 3 * unit);
      if (candidate <= minimum || candidate >= maximum) continue;
      const occupied = occupiedSegments.some((segment) => (
        !segment.horizontal && Math.abs(segment.start.x - candidate) <= 1e-6
      ));
      if (!occupied) return candidate;
    }
    return initial;
  };
  const middleX = (start.x + end.x) / 2;
  const exitX = chooseUnusedVertical(start.x + stubDistance, start.x + 3 * unit, middleX - 3 * unit);
  const entryX = chooseUnusedVertical(end.x - stubDistance, middleX + 3 * unit, end.x - 3 * unit);
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
    for (let candidate = minimum; candidate <= maximum; candidate += 8 * unit) {
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
    if (segments.some((segment) => occupiedSegments.some((occupied) => segmentsOverlap(segment, occupied)))) continue;
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

function routeEdge(edge, source, target, parallelIndex, startPort, endPort, route, geometry) {
  const unit = geometry.scale;
  const offset = parallelIndex * 18 * unit;
  let points;
  let labelPoint;

  if (route.kind === "self") {
    const start = { x: source.x + source.width, y: source.y + 19 * unit };
    const end = { x: source.x + source.width, y: source.y + source.height - 19 * unit };
    const laneX = start.x + 58 * unit + route.lane * 22 * unit + offset;
    points = [start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end];
    labelPoint = { x: laneX, y: (start.y + end.y) / 2 };
  } else if (route.kind === "forward") {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const laneX = start.x + (end.x - start.x) * ((route.lane.index + 1) / (route.lane.count + 1));
    const trackOffset = alternatingOffset(route.lane.index + 1, 5 * unit);
    const startTrackY = start.y + trackOffset;
    const endTrackY = end.y + trackOffset;
    const startStubX = start.x + (8 + route.lane.index * 3) * unit;
    const endStubX = end.x - (8 + route.lane.index * 3) * unit;
    points = [
      start,
      { x: startStubX, y: start.y },
      { x: startStubX, y: startTrackY },
      { x: laneX, y: startTrackY },
      { x: laneX, y: endTrackY },
      { x: endStubX, y: endTrackY },
      { x: endStubX, y: end.y },
      end,
    ];
    labelPoint = Math.abs(startTrackY - endTrackY) > 22 * unit
      ? { x: laneX, y: (startTrackY + endTrackY) / 2 }
      : { x: (start.x + end.x) / 2, y: startTrackY };
  } else if (route.kind === "backward") {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const laneY = (24 + route.lane * 26) * unit;
    const startTrackY = start.y - (12 + route.lane * 2) * unit;
    const endTrackY = end.y - (12 + route.lane * 2) * unit;
    const exitX = start.x - (12 + route.lane * 8) * unit;
    const entryX = end.x - (12 + route.lane * 8) * unit;
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
    const startY = start.y + (downward ? 22 : -22) * unit;
    const endY = end.y + (downward ? -22 : 22) * unit;
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
  return Math.max(38, label.length * 7.1 + 16) * scale;
}

function nodeLabelLines(name, nodeWidth = BASE_NODE_WIDTH) {
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || name.length * 7.2 <= nodeWidth - 24) return [name];
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
  const edges = layout.edges.map((edge) => {
    const width = labelWidth(edge.label, scale);
    const path = edge.points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");
    const arrow = edge.arrow.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    return `<g class="edge">
      <path d="${path}" />
      <polygon points="${arrow}" />
      <rect x="${edge.labelPoint.x - width / 2}" y="${edge.labelPoint.y - 11 * scale}" width="${width}" height="${22 * scale}" />
      <text x="${edge.labelPoint.x}" y="${edge.labelPoint.y + 4 * scale}">${escapeXml(edge.label)}</text>
    </g>`;
  }).join("\n");

  const nodes = [...layout.nodes.values()].map((node) => {
    const lines = nodeLabelLines(node.name, node.width / scale);
    const longest = Math.max(...lines.map((line) => line.length));
    const fontSize = Math.max(10 * scale, Math.min(14 * scale, (node.width - 24 * scale) / (longest * 0.58)));
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
      .edge text { fill: #111; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${12 * scale}px; text-anchor: middle; }
      .node rect { fill: #fff; stroke: #111; stroke-width: ${2 * scale}; }
      .node text { fill: #111; font-family: Inter, Arial, sans-serif; font-size: ${14 * scale}px; font-weight: 600; text-anchor: middle; }
    </style>
    <rect width="100%" height="100%" fill="#fff" />
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
