# Boxline Workspace

A local-first windowed shell that reuses the Files and window interactions from the HCW workspace prototype and makes Boxline its sole tool.

The editor opens first. Every file begins with `graph directed`, `graph optimized`, `graph classified`, or `graph timeline`. Directed and optimized graphs use `state Name:` with `label -> Target` arrows. Classified graphs add a declared class cycle and annotate every state:

```text
graph classified
columns industry cargo

state Coal Mine [industry]:
  makes -> COAL
state COAL [cargo]:
```

`OPEN GRAPH` creates or focuses a separate live graph window for the same `.boxline` file, where the type dropdown rewrites that declaration. Directed mode preserves source order. Optimized mode repeatedly swaps neighboring boxes whenever doing so reduces crossings or vertical travel, then reports the passes and accepted swaps when it converges. Classified mode repeats its declared classes across successive columns, labels those columns, and applies the same row-order optimization inside them. Switching an existing graph to classified mode gives its states provisional `class-a` and `class-b` annotations that can be renamed in the source.

Timeline mode treats the first declared row as the main process, follows arrows outward from a named base to order that row, and places every later row above it. A higher-row state aligns directly over the main-row state it connects to when space permits. Row categories color the boxes rather than the page, and `text:` adds a body independent of the state name:

```text
graph timeline
rows timeline context detail
base Discovery

state Discovery [timeline]:
  text:
    Interview users and name the assumption most likely to kill the project.
  next -> Prototype
```

Use the visible `−`, percentage, and `+` controls or hold Ctrl/Command while scrolling to zoom around the cursor. `LAYOUT` opens persistent controls for the compiled graph's intrinsic size, wide-to-tall shape, and spacing density. Long links choose the shortest clear horizontal corridor around boxes instead of detouring through the graph margin, while distinct arrows never share a positive-length track. Files, source, open windows, graph zoom, layout geometry, and window geometry persist in browser storage.

The examples folder includes a product timeline plus official FIRS 4.15.1 Temperate and Steeltown cargo flows, imported as classified Boxline graphs with alternating industry and cargo columns. Run `npm run import:firs` to regenerate those source files from the published FIRS `.dot` diagrams.

Run it locally with:

```sh
npm run serve
```

Then open `http://127.0.0.1:4173`.
