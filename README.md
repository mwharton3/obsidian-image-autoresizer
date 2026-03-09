# Image Auto Resizer

An Obsidian plugin that automatically converts and resizes images when they're added to your vault.

## Features

- **Automatic processing** — images are converted and resized the moment they're pasted or dropped into a note
- **Broad format support** — handles PNG, JPEG, WebP, BMP, HEIC/HEIF, and TIFF/TIF
- **Configurable output format** — choose between WebP (smaller files) or JPEG (wider compatibility)
- **Configurable dimensions** — set max width and height; aspect ratio is always preserved
- **Configurable quality** — compression quality from 0.0 to 1.0 (default: 0.8)
- **Respects Obsidian settings** — uses your configured attachment folder location
- **Performance optimized** — uses `OffscreenCanvas` and `createImageBitmap` when available

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Output format | WebP | WebP (recommended, smaller files) or JPEG |
| Max width | 1200 | Maximum width in pixels |
| Max height | 1200 | Maximum height in pixels |
| Quality | 0.8 | Compression quality (0.0–1.0) |

## Supported Input Formats

| Format | Notes |
|--------|-------|
| PNG | Native browser decoding |
| JPEG/JPG | Native browser decoding |
| WebP | Native browser decoding |
| BMP | Native browser decoding |
| HEIC/HEIF | Decoded via `heic2any` (common on iOS/macOS) |
| TIFF/TIF | Decoded via `utif2` |

## License

MIT
