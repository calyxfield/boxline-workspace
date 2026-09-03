# Boxline Workspace

A local-first windowed shell that reuses the Files and window interactions from the HCW workspace prototype and makes Boxline its sole tool.

The editor opens first. Every file begins with `graph directed`, `graph optimized`, `graph classified`, `graph timeline`, or `graph nested`. Directed and optimized graphs use `state Name:` with `label -> Target` arrows. Classified graphs add a declared class cycle and annotate every state:

```text
graph classified
columns industry cargo

state Coal Mine [industry]:
  makes -> COAL
state COAL [cargo]:
```

`OPEN GRAPH` creates or focuses a separate live graph window for the same `.boxline` file, where the type dropdown rewrites that declaration. Directed mode preserves source order. Optimized mode repeatedly swaps neighboring boxes whenever doing so reduces crossings or vertical travel, then reports the passes and accepted swaps when it converges. Classified mode repeats its declared classes across successive columns, labels those columns, and applies the same row-order optimization inside them. Switching an existing graph to classified mode gives its states provisional `class-a` and `class-b` annotations that can be renamed in the source.

Timeline mode treats every declared row as its own directed graph. It follows arrows outward from a named base in the first row, lays each higher-row graph out from left to right, then uses cross-row arrows to align the layers. Compatible links line up exactly while conflicting links preserve the row's internal topology. Row categories color the boxes rather than the page, and `text:` adds a body independent of the state name:

```text
graph timeline
rows timeline context detail
base Discovery

state Discovery [timeline]:
  text:
    Interview users and name the assumption most likely to kill the project.
  next -> Prototype
```

Nested graphs keep a directed graph inside any outer state. Outer arrows use one indentation level, inner state declarations use two, and inner arrows use three. A two-level `Outer -> Inner` mapping continues that outer state's incoming arrow through the container boundary:

```text
graph nested

state Intake:
    ready -> Processing
state Processing:
    complete -> Shipping
        state Validate:
            valid -> Assemble
        state Assemble:
        Intake -> Validate
state Shipping:
```

Use the visible `−`, percentage, and `+` controls or hold Ctrl/Command while scrolling to zoom around the cursor. `LAYOUT` opens persistent controls for the compiled graph's intrinsic size, wide-to-tall shape, and spacing density. Long links choose the shortest clear horizontal corridor around boxes instead of detouring through the graph margin, while distinct arrows never share a positive-length track. Files, source, open windows, graph zoom, layout geometry, and window geometry persist in browser storage.

The examples folder includes a nested release flow, a product timeline, and official FIRS 4.15.1 Temperate and Steeltown cargo flows imported as classified Boxline graphs with alternating industry and cargo columns. Run `npm run import:firs` to regenerate the FIRS sources from the published `.dot` diagrams.

Run it locally with:

```sh
npm run serve
```

Then open `http://127.0.0.1:4173`.
