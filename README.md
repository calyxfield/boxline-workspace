# Boxline Workspace

A local-first windowed shell that reuses the Files and window interactions from the HCW workspace prototype and makes Boxline its sole tool.

The editor opens first. Every file begins with `graph directed` or `graph optimized`; both types use the same `state Name:` and `label -> Target` grammar. `OPEN GRAPH` creates or focuses a separate live graph window for the same `.boxline` file, where the type dropdown rewrites that declaration. Directed mode preserves source order. Optimized mode repeatedly swaps neighboring boxes whenever doing so reduces crossings or vertical travel, then reports the passes and accepted swaps when it converges.

Use the visible `−`, percentage, and `+` controls or hold Ctrl/Command while scrolling to zoom around the cursor. `LAYOUT` opens persistent controls for the compiled graph's intrinsic size, wide-to-tall shape, and spacing density. Long links choose the shortest clear horizontal corridor around boxes instead of detouring through the graph margin, while distinct arrows never share a positive-length track. Files, source, open windows, graph zoom, layout geometry, and window geometry persist in browser storage.

The examples folder includes official FIRS 4.15.1 Temperate and Steeltown cargo flows, imported as optimized Boxline graphs. Run `npm run import:firs` to regenerate those source files from the published FIRS `.dot` diagrams.

Run it locally with:

```sh
npm run serve
```

Then open `http://127.0.0.1:4173`.
