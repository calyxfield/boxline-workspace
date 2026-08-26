const NODE_WIDTH = 184;
const NODE_HEIGHT = 64;
const LAYER_GAP = 168;
const ROW_GAP = 76;
const MARGIN = 64;

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

export function layoutGraph(graph) {
  if (!graph.nodes.length) {
    return { nodes: new Map(), edges: [], width: 720, height: 460 };
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
  const contentHeight = maximumRows * NODE_HEIGHT + Math.max(0, maximumRows - 1) * ROW_GAP;
  const backwardCount = graph.edges.filter((edge) => layer.get(edge.target) < layer.get(edge.source)).length;
  const longForwardCount = graph.edges.filter((edge) => layer.get(edge.target) - layer.get(edge.source) > 1).length;
  const topRouteBand = backwardCount ? 34 + (backwardCount - 1) * 26 : 0;
  const bottomRouteBand = longForwardCount ? 34 + (longForwardCount - 1) * 26 : 0;
  const drawingHeight = Math.max(420, contentHeight + (2 * MARGIN));
  const height = drawingHeight + topRouteBand + bottomRouteBand;
  const positions = new Map();
  const maximumLayer = Math.max(...layer.values());
  const columnGaps = Array.from({ length: maximumLayer }, () => LAYER_GAP);
  for (const edge of graph.edges) {
    const sourceLayer = layer.get(edge.source);
    const targetLayer = layer.get(edge.target);
    if (targetLayer === sourceLayer + 1) {
      columnGaps[sourceLayer] = Math.max(columnGaps[sourceLayer], labelWidth(edge.label) + 24);
    }
  }
  const columnX = [MARGIN];
  for (let index = 1; index <= maximumLayer; index += 1) {
    columnX[index] = columnX[index - 1] + NODE_WIDTH + columnGaps[index - 1];
  }

  columns.forEach((column, columnIndex) => {
    if (!column) return;
    const columnHeight = column.length * NODE_HEIGHT + Math.max(0, column.length - 1) * ROW_GAP;
    const top = topRouteBand + (drawingHeight - columnHeight) / 2;
    column.forEach((id, rowIndex) => {
      positions.set(id, {
        id,
        name: nodeById.get(id).name,
        x: columnX[columnIndex],
        y: top + rowIndex * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  });

  const width = Math.max(720, columnX[maximumLayer] + NODE_WIDTH + MARGIN);
  const parallelCount = new Map();
  const ports = assignPorts(graph.edges, positions);
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
      .filter((edge) => positions.get(edge.target).x - positions.get(edge.source).x > NODE_WIDTH + LAYER_GAP)
      .sort((left, right) => {
        const leftSpan = positions.get(left.target).x - positions.get(left.source).x;
        const rightSpan = positions.get(right.target).x - positions.get(right.source).x;
        return rightSpan - leftSpan || left.order - right.order;
      })
      .map((edge, index) => [edge.id, index]),
  );
  const routeLanes = new Map();
  const nextLane = (key) => {
    const lane = routeLanes.get(key) ?? 0;
    routeLanes.set(key, lane + 1);
    return lane;
  };
  const routedEdges = graph.edges.map((edge) => {
    const key = `${edge.source}\u0000${edge.target}`;
    const count = parallelCount.get(key) ?? 0;
    parallelCount.set(key, count + 1);
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    const columnDistance = Math.round(Math.abs(target.x - source.x) / (NODE_WIDTH + LAYER_GAP));
    const route = target.x < source.x
      ? { kind: "backward", lane: backwardLanes.get(edge.id) }
      : target.x > source.x && columnDistance > 1
        ? { kind: "long-forward", lane: longForwardLanes.get(edge.id) }
        : target.x > source.x
          ? { kind: "forward", lane: nextLane(`forward\u0000${source.x}\u0000${target.x}`) }
          : target.id === source.id
            ? { kind: "self", lane: nextLane(`self\u0000${source.id}`) }
            : { kind: "vertical", lane: nextLane(`vertical\u0000${source.x}`) };
    return routeEdge(
      edge,
      source,
      target,
      count,
      ports.get(`${edge.id}:start`),
      ports.get(`${edge.id}:end`),
      route,
      height,
    );
  });

  return { nodes: positions, edges: routedEdges, width, height };
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

function assignPorts(edges, positions) {
  const groups = new Map();
  const descriptors = [];

  for (const edge of edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (source.id === target.id) continue;
    let startSide;
    let endSide;
    let portOrder = edge.order;
    if (target.x < source.x) {
      startSide = "top";
      endSide = "top";
      portOrder = -(source.x - target.x);
    } else if (target.x - source.x > NODE_WIDTH + LAYER_GAP) {
      startSide = "bottom";
      endSide = "bottom";
      portOrder = -(target.x - source.x);
    } else if (target.x > source.x) {
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
      const spacing = descriptor.side === "left" || descriptor.side === "right" ? 14 : 22;
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

function routeEdge(edge, source, target, parallelIndex, startPort, endPort, route, layoutHeight) {
  const offset = parallelIndex * 18;
  let points;
  let labelPoint;

  if (route.kind === "self") {
    const start = { x: source.x + source.width, y: source.y + 19 };
    const end = { x: source.x + source.width, y: source.y + source.height - 19 };
    const laneX = start.x + 58 + route.lane * 22 + offset;
    points = [start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end];
    labelPoint = { x: laneX, y: (start.y + end.y) / 2 };
  } else if (route.kind === "forward") {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const laneX = (start.x + end.x) / 2 + alternatingOffset(route.lane, 16) + offset;
    points = [start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end];
    labelPoint = Math.abs(start.y - end.y) > 22
      ? { x: laneX, y: (start.y + end.y) / 2 }
      : { x: (start.x + end.x) / 2, y: start.y };
  } else if (route.kind === "long-forward") {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const laneY = layoutHeight - 24 - route.lane * 26;
    points = [
      start,
      { x: start.x, y: laneY },
      { x: end.x, y: laneY },
      end,
    ];
    labelPoint = { x: (start.x + end.x) / 2, y: laneY };
  } else if (route.kind === "backward") {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const laneY = 24 + route.lane * 26;
    points = [
      start,
      { x: start.x, y: laneY },
      { x: end.x, y: laneY },
      end,
    ];
    labelPoint = { x: (start.x + end.x) / 2, y: laneY };
  } else {
    const start = portPoint(source, startPort);
    const end = portPoint(target, endPort);
    const downward = target.y > source.y;
    const laneX = source.x - 38 - route.lane * 22 - offset;
    const startY = start.y + (downward ? 22 : -22);
    const endY = end.y + (downward ? -22 : 22);
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
  const arrow = arrowHead(points.at(-2), end);
  return { ...edge, points, start, end, labelPoint, arrow };
}

function arrowHead(previous, end) {
  const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
  const length = 11;
  const spread = 5.5;
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

function labelWidth(label) {
  return Math.max(38, label.length * 7.1 + 16);
}

function nodeLabelLines(name) {
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || name.length * 7.2 <= NODE_WIDTH - 24) return [name];
  let best = null;
  for (let index = 1; index < words.length; index += 1) {
    const lines = [words.slice(0, index).join(" "), words.slice(index).join(" ")];
    const score = Math.max(...lines.map((line) => line.length));
    if (!best || score < best.score) best = { lines, score };
  }
  return best.lines;
}

export function renderSvg(graph, layout) {
  const edges = layout.edges.map((edge) => {
    const width = labelWidth(edge.label);
    const path = edge.points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");
    const arrow = edge.arrow.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    return `<g class="edge">
      <path d="${path}" />
      <polygon points="${arrow}" />
      <rect x="${edge.labelPoint.x - width / 2}" y="${edge.labelPoint.y - 11}" width="${width}" height="22" />
      <text x="${edge.labelPoint.x}" y="${edge.labelPoint.y + 4}">${escapeXml(edge.label)}</text>
    </g>`;
  }).join("\n");

  const nodes = [...layout.nodes.values()].map((node) => {
    const lines = nodeLabelLines(node.name);
    const longest = Math.max(...lines.map((line) => line.length));
    const fontSize = Math.max(10, Math.min(14, (node.width - 24) / (longest * 0.58)));
    const centerX = node.x + node.width / 2;
    const firstY = node.y + node.height / 2 + 5 - (lines.length - 1) * 8;
    const text = lines.map((line, index) => `<tspan x="${centerX}"${index ? ' dy="17"' : ""}>${escapeXml(line)}</tspan>`).join("");
    return `<g class="node">
      <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" />
      <text x="${centerX}" y="${firstY}" style="font-size:${fontSize.toFixed(2)}px">${text}</text>
    </g>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img" aria-label="Compiled state diagram">
    <style>
      .edge path { fill: none; stroke: #111; stroke-width: 1.6; stroke-linecap: square; stroke-linejoin: round; }
      .edge polygon { fill: #111; }
      .edge rect { fill: #fff; }
      .edge text { fill: #111; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; text-anchor: middle; }
      .node rect { fill: #fff; stroke: #111; stroke-width: 2; }
      .node text { fill: #111; font-family: Inter, Arial, sans-serif; font-size: 14px; font-weight: 600; text-anchor: middle; }
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
  nodeWidth: NODE_WIDTH,
  nodeHeight: NODE_HEIGHT,
};
