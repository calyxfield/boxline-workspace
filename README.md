# Boxline Workspace

A local-first windowed shell that reuses the Files and window interactions from the HCW workspace prototype and makes Boxline its sole tool.

The editor opens first. `OPEN GRAPH` creates or focuses a separate live graph window for the same `.boxline` file. Use the visible `−`, percentage, and `+` controls or hold Ctrl/Command while scrolling to zoom around the cursor. `LAYOUT` opens persistent controls for the compiled graph's intrinsic size, wide-to-tall shape, and spacing density. Files, source, open windows, graph zoom, layout geometry, and window geometry persist in browser storage.

Run it locally with:

```sh
npm run serve
```

Then open `http://127.0.0.1:4173`.
