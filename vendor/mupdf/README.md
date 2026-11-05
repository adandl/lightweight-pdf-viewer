# MuPDF.js (custom build)

These files are a build of [MuPDF.js](https://mupdf.com/) 1.28.1 by Artifex Software,
licensed under the **GNU AGPL v3** (see `LICENSE`).

The stock npm package has no API for spot colour separations, so this build adds a few
functions (see `build/separations.patch`):

| JS method | What it does |
| --- | --- |
| `PDFPage.toSeparationsPixmap(matrix, usage, box)` | Renders the page into a DeviceCMYK pixmap with one extra channel per spot colour, with overprint simulated by MuPDF's draw device. `usage` is `"View"` or `"Print"` (optional-content intent). |
| `PDFPage.usesOverprint()` | `true` if the page sets overprint anywhere. |
| `Pixmap.getSeparations()` | Names of the spot channels plus their RGB and CMYK alternate equivalents. |

Channel layout of the separations pixmap: `C, M, Y, K, spot1, spot2, …`, one byte
per channel, 0 = no ink, 255 = 100 %.

To rebuild: `bash vendor/mupdf/build/build.sh`.
