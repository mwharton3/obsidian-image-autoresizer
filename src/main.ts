import {MarkdownView, Notice, Plugin, TFile, TFolder} from 'obsidian';
import {DEFAULT_SETTINGS, ImageAutoResizerSettings, ImageAutoResizerSettingTab, OutputFormat} from "./settings";
import heic2any from 'heic2any';
import * as UTIF from 'utif2';

// Formats natively decodable by the browser/canvas
const NATIVE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);
// Formats that need special decoding before canvas processing
const DECODE_IMAGE_EXTENSIONS = new Set(['heic', 'heif', 'tif', 'tiff']);

const ALL_IMAGE_EXTENSIONS = new Set([...NATIVE_IMAGE_EXTENSIONS, ...DECODE_IMAGE_EXTENSIONS]);

export default class ImageAutoResizerPlugin extends Plugin {
	settings: ImageAutoResizerSettings;
	private processing = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ImageAutoResizerSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile) {
					this.handleNewImage(file);
				}
			})
		);
	}

	onunload() {
		this.processing.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ImageAutoResizerSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private get outputMime(): string {
		return this.settings.outputFormat === 'webp' ? 'image/webp' : 'image/jpeg';
	}

	private get outputExt(): string {
		return this.settings.outputFormat === 'webp' ? 'webp' : 'jpg';
	}

	private async handleNewImage(file: TFile): Promise<void> {
		const ext = file.extension.toLowerCase();
		if (!ALL_IMAGE_EXTENSIONS.has(ext)) return;

		if (this.processing.has(file.path)) return;
		this.processing.add(file.path);

		let newPath = file.path;
		try {
			const data = await this.app.vault.readBinary(file);
			const {maxWidth, maxHeight, quality, outputFormat} = this.settings;

			let img: HTMLImageElement | ImageBitmap;

			if (DECODE_IMAGE_EXTENSIONS.has(ext)) {
				img = await this.decodeSpecialFormat(data, ext);
			} else {
				const blob = new Blob([data], {type: `image/${ext === 'jpg' ? 'jpeg' : ext}`});
				img = await this.loadImage(blob);
			}

			const {width, height} = img;

			// Skip if already in target format and within size limits
			const isTargetFormat = (outputFormat === 'jpeg' && (ext === 'jpg' || ext === 'jpeg'))
				|| (outputFormat === 'webp' && ext === 'webp');
			if (isTargetFormat && width <= maxWidth && height <= maxHeight) {
				this.cleanupImage(img);
				return;
			}

			// Calculate scaled dimensions maintaining aspect ratio
			let newWidth = width;
			let newHeight = height;
			if (width > maxWidth || height > maxHeight) {
				const ratio = Math.min(maxWidth / width, maxHeight / height);
				newWidth = Math.round(width * ratio);
				newHeight = Math.round(height * ratio);
			}

			const arrayBuffer = await this.compressToOutput(img, newWidth, newHeight, quality);
			this.cleanupImage(img);

			// Determine the new file path
			const basePath = file.path.replace(/\.[^.]+$/, '');
			newPath = `${basePath}.${this.outputExt}`;

			if (newPath === file.path) {
				await this.app.vault.modifyBinary(file, arrayBuffer);
			} else {
				const folder = file.parent;
				if (folder && folder.path !== '/') {
					await this.ensureFolder(folder.path);
				}

				// Handle name collisions by appending a counter
				let counter = 1;
				while (this.app.vault.getAbstractFileByPath(newPath)) {
					newPath = `${basePath}-${counter}.${this.outputExt}`;
					counter++;
				}

				this.processing.add(newPath);
				await this.app.vault.createBinary(newPath, arrayBuffer);

				// Update references in the active note before deleting the old file
				const oldName = file.name;
				const newName = newPath.split('/').pop()!;
				await this.updateReferences(oldName, newName);

				await this.app.vault.delete(file);
			}

			const saved = data.byteLength - arrayBuffer.byteLength;
			const formatLabel = this.outputExt.toUpperCase();
			if (saved > 0) {
				new Notice(`Image resized: saved ${Math.round(saved / 1024)}KB`);
			} else {
				new Notice(`Image converted to ${formatLabel} (${newWidth}x${newHeight})`);
			}
		} catch (e) {
			console.error('Image Auto Resizer: failed to process image', e);
		} finally {
			this.processing.delete(file.path);
			this.processing.delete(newPath);
		}
	}

	/**
	 * Decode HEIC/HEIF and TIFF formats into an ImageBitmap the canvas can draw.
	 */
	private async decodeSpecialFormat(data: ArrayBuffer, ext: string): Promise<HTMLImageElement | ImageBitmap> {
		if (ext === 'heic' || ext === 'heif') {
			const blob = new Blob([data], {type: 'image/heic'});
			const pngBlob = await heic2any({blob, toType: 'image/png'}) as Blob;
			return this.loadImage(pngBlob);
		}

		// TIFF decoding via UTIF2
		const ifds = UTIF.decode(data);
		const ifd = ifds[0];
		if (!ifd) throw new Error('Failed to decode TIFF: no image found');
		UTIF.decodeImage(data, ifd);
		const rgba = UTIF.toRGBA8(ifd);

		const imageData = new ImageData(
			new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength),
			ifd.width,
			ifd.height
		);

		if (typeof OffscreenCanvas !== 'undefined') {
			const canvas = new OffscreenCanvas(ifd.width, ifd.height);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Failed to get 2d context');
			ctx.putImageData(imageData, 0, 0);
			return canvas.transferToImageBitmap();
		}

		// Fallback: render to DOM canvas and create a blob to load
		const canvas = document.createElement('canvas');
		canvas.width = ifd.width;
		canvas.height = ifd.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Failed to get 2d context');
		ctx.putImageData(imageData, 0, 0);

		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (!blob) {
					reject(new Error('Failed to decode TIFF'));
					return;
				}
				this.loadImage(blob).then(resolve, reject);
			});
		});
	}

	private loadImage(blob: Blob): Promise<HTMLImageElement | ImageBitmap> {
		// Prefer createImageBitmap (fast, works off main thread) when available
		if (typeof createImageBitmap === 'function') {
			return createImageBitmap(blob);
		}
		// Fallback for environments without createImageBitmap
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				URL.revokeObjectURL(img.src);
				resolve(img);
			};
			img.onerror = () => {
				URL.revokeObjectURL(img.src);
				reject(new Error('Failed to load image'));
			};
			img.src = URL.createObjectURL(blob);
		});
	}

	private cleanupImage(img: HTMLImageElement | ImageBitmap): void {
		if ('close' in img) {
			img.close();
		}
	}

	private async compressToOutput(
		img: HTMLImageElement | ImageBitmap,
		width: number,
		height: number,
		quality: number
	): Promise<ArrayBuffer> {
		const mime = this.outputMime;

		// Prefer OffscreenCanvas when available (faster, no DOM needed)
		if (typeof OffscreenCanvas !== 'undefined') {
			const canvas = new OffscreenCanvas(width, height);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Failed to get 2d context');
			ctx.drawImage(img, 0, 0, width, height);
			const blob = await canvas.convertToBlob({type: mime, quality});
			return blob.arrayBuffer();
		}

		// Fallback to regular canvas (mobile)
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Failed to get 2d context');
		ctx.drawImage(img, 0, 0, width, height);

		return new Promise((resolve, reject) => {
			canvas.toBlob(
				(blob) => {
					if (!blob) {
						reject(new Error('Failed to compress image'));
						return;
					}
					blob.arrayBuffer().then(resolve, reject);
				},
				mime,
				quality
			);
		});
	}

	private async updateReferences(oldName: string, newName: string): Promise<void> {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!markdownView || markdownView.file?.extension !== 'md') return;

		const editor = markdownView.editor;
		const content = editor.getValue();
		const updated = content.split(oldName).join(newName);
		if (updated !== content) {
			editor.setValue(updated);
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;
		await this.app.vault.createFolder(path);
	}
}
