Obsidian plugin that automatically converts and resizes images added to the vault.

Based on the sample plugin template: https://github.com/obsidianmd/obsidian-sample-plugin

## Key details

* MIT License
* Automatically converts images to WebP (default) or JPEG, resizing to max 1200px with 0.8 quality. Max size, quality, and output format are configurable in settings.
* Supported input formats: PNG, JPEG, WebP, BMP, HEIC/HEIF (via heic2any), TIFF/TIF (via utif2)
* Respects Obsidian's configured attachment folder location
* Performance optimized: uses OffscreenCanvas and createImageBitmap with DOM canvas fallbacks

## Architecture

* `src/main.ts` — core plugin logic, image processing pipeline
* `src/settings.ts` — settings interface, defaults, and settings tab UI
* Native formats (PNG, JPEG, WebP, BMP) are decoded directly by the browser
* HEIC/HEIF and TIFF require JS decoder libraries before canvas processing
* Build: `npm run build` (tsc + esbuild)
