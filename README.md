# Lightweight PDF Viewer

Client-side prepress PDF viewer. Everything runs in the browser; PDFs are never uploaded.

- `index.html`: the classic viewer, rendered with PDF.js.
- `mupdf.html`: **Separations (MuPDF beta)**. Renders every process and spot ink into its own
  plate with MuPDF (WebAssembly), including overprint, and composites the enabled plates.
  Use it whenever spot colours (Separation / DeviceN) matter. PDF.js converts spot colours to
  their alternate colour space while parsing, so it cannot show real spot plates.

Both pages need to be served over HTTP (for example GitHub Pages or
`python3 -m http.server`), not opened via `file://`. Local test files can go into
`samples/` (ignored by git) and be opened with `mupdf.html?file=samples/<name>.pdf`.

## License

This project is licensed under the **GNU Affero General Public License v3.0** (see `LICENSE`),
because it ships [MuPDF](https://mupdf.com/) by Artifex Software, which is AGPL-licensed.
In practice this means: the project stays free and open source, and anyone who hosts it
(also in modified form) must offer the complete source code to its users. The link in the
footer of `mupdf.html` points to this repository for that reason.

`vendor/mupdf/` contains a custom MuPDF.js 1.28.1 build with a small extension for spot colour
separations; see `vendor/mupdf/README.md` and `vendor/mupdf/build/` for the patch and how to
rebuild it.
