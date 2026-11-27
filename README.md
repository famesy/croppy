# InstraCrop Studio

A lightweight standalone Electron desktop app for post-trip batch photo editing: manually crop each photo and pad it with white, black, or custom borders to fit Instagram's preferred aspect ratios.

## Features

- **Fast Batch Queue**: Add individual photos, import an entire folder, or drag & drop photos/folders straight into the window.
- **Interactive Manual Cropping**: Drag corners, edges, or the crop box itself with a rule-of-thirds overlay, optional aspect-ratio locks, and 90° rotation.
- **Instagram Aspect Ratio Framing**:
  - **4:5 Portrait** (`1080 × 1350` or High-Res `2160 × 2700`)
  - **1:1 Square** (`1080 × 1080` or `2160 × 2160`)
  - **1.91:1 Landscape** (`1080 × 566` or `2160 × 1131`)
  - **9:16 Story / Reel** (`1080 × 1920` or `2160 × 3840`)
- **White / Black / Custom Borders**: One-click Pure White, Pure Black, Warm Paper, Charcoal, or any custom hex color, plus an **Extra Margin** slider (`0%–25%`).
- **One-Click Batch Consistency**: Apply your chosen ratio, border color, and margin to all loaded photos while preserving each photo's individual crop.
- **Direct Folder Export**: Export the current photo or batch-export all photos as JPEG (adjustable quality) or lossless PNG directly to a local folder.

## Run Locally

```bash
npm install
npm start
```

## Keyboard Shortcuts

- `←` / `→` — Previous / Next photo
- `Space` or `P` — Toggle Crop / Instagram Preview mode
- `C` — Switch to Crop mode
- `R` — Rotate 90° clockwise
