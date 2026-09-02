import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIRS_VERSION = "4.15.1";
const SOURCE_ROOT = `https://grf.farm/firs/${FIRS_VERSION}/html`;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const economies = [
  {
    slug: "temperate_basic",
    title: "FIRS 4 Temperate",
    output: "examples/firs-4-temperate.boxline",
  },
  {
    slug: "steeltown",
    title: "FIRS 4 Steeltown",
    output: "examples/firs-4-steeltown.boxline",
  },
];

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function titleFromId(id) {
  return id
    .replace(/^[A-Z]_/, "")
    .split("_")
    .map((word) => word ? word[0].toUpperCase() + word.slice(1) : "")
    .join(" ");
}

function parseDotNodes(dot) {
  const nodes = new Map();
  const pattern = /^\s*([CIT]_[A-Za-z0-9_]+)\s+\[([\s\S]*?)\];/gm;
  for (const match of dot.matchAll(pattern)) {
    const [statement, id, attributes] = match;
    if (statement.includes("->")) continue;
    const quotedTooltip = attributes.match(/\btooltip="([^"]+)"/)?.[1];
    const bareTooltip = attributes.match(/\btooltip=([^,\]\n]+)/)?.[1]?.trim();
    const quotedLabel = attributes.match(/\blabel="([^"]+)"/)?.[1];
    const bareLabel = attributes.match(/\blabel=([^,<\]\n]+)/)?.[1]?.trim();
    const htmlLabel = attributes.match(/<tr><td>([^<]+)<\/td><\/tr>/)?.[1];
    const label = quotedTooltip || bareTooltip || quotedLabel || bareLabel || htmlLabel || titleFromId(id);
    nodes.set(id, decodeHtml(label));
  }
  return nodes;
}

function parseDotEdges(dot) {
  return [...dot.matchAll(/^\s*([CIT]_[A-Za-z0-9_]+)\s*->\s*([CIT]_[A-Za-z0-9_]+)/gm)]
    .map((match) => ({ source: match[1], target: match[2] }));
}

function boxlineName(id, labels) {
  if (id.startsWith("T_")) return "Towns";
  const label = labels.get(id) || titleFromId(id);
  return id.startsWith("C_") ? label.toUpperCase() : label;
}

function boxlineSource(economy, dot) {
  const labels = parseDotNodes(dot);
  const importedEdges = parseDotEdges(dot);
  const edges = [];
  const edgeKeys = new Set();
  const outgoing = new Map();

  for (const edge of importedEdges) {
    const source = boxlineName(edge.source, labels);
    const target = boxlineName(edge.target, labels);
    const label = edge.source.startsWith("I_") ? "makes" : "used by";
    const key = `${source}\u0000${label}\u0000${target}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ source, label, target });
    if (!outgoing.has(source)) outgoing.set(source, []);
    outgoing.get(source).push({ label, target });
  }

  const names = [...new Set(edges.flatMap((edge) => [edge.source, edge.target]))]
    .sort((left, right) => {
      const leftCargo = left === left.toUpperCase();
      const rightCargo = right === right.toUpperCase();
      return Number(leftCargo) - Number(rightCargo) || left.localeCompare(right);
    });

  const body = names.map((name) => {
    const arrows = outgoing.get(name) || [];
    const lines = [`state ${name}:`];
    for (const edge of arrows) lines.push(`  ${edge.label} -> ${edge.target}`);
    return lines.join("\n");
  }).join("\n\n");

  return `graph optimized

# ${economy.title} cargo flow
# Imported from the official FIRS ${FIRS_VERSION} economy graph.
# Source: ${SOURCE_ROOT}/${economy.slug}.dot
# Industry names use title case. Cargo names use capitals.
# "makes" points to a cargo; "used by" points to its recipient.

${body}
`;
}

for (const economy of economies) {
  const sourceUrl = `${SOURCE_ROOT}/${economy.slug}.dot`;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Could not fetch ${sourceUrl}: ${response.status}`);
  const source = boxlineSource(economy, await response.text());
  const outputPath = resolve(projectRoot, economy.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source);
  console.log(`${economy.output}: ${source.split("\n").filter((line) => line.startsWith("state ")).length} states`);
}
