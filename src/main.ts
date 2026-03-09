import {Notice, Plugin, TFile, TFolder} from 'obsidian';
import {DEFAULT_SETTINGS, ImageAutoResizerSettings, ImageAutoResizerSettingTab} from "./settings";

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);

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

	private async handleNewImage(file: TFile): Promise<void> {
		const ext = file.extension.toLowerCase();
		if (!IMAGE_EXTENSIONS.has(ext)) return;

		if (this.processing.has(file.path)) return;
		this.processing.add(file.path);

		try {
			const data = await this.app.vault.readBinary(file);
			const blob = new Blob([data], {type: `image/${ext === 'jpg' ? 'jpeg' : ext}`});

			const img = await this.loadImage(blob);
			const {width, height} = img;
			const {maxWidth, maxHeight, jpegQuality} = this.settings;

			// Skip if already JPEG and within size limits
			if ((ext === 'jpg' || ext === 'jpeg') && width <= maxWidth && height <= maxHeight) {
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

			const arrayBuffer = await this.compressToJpeg(img, newWidth, newHeight, jpegQuality);
			this.cleanupImage(img);

			// Determine the new file path (change extension to .jpg)
			const newPath = file.path.replace(/\.[^.]+$/, '.jpg');

			if (newPath === file.path) {
				await this.app.vault.modifyBinary(file, arrayBuffer);
			} else {
				const folder = file.parent;
				if (folder && folder.path !== '/') {
					await this.ensureFolder(folder.path);
				}
				this.processing.add(newPath);
				await this.app.vault.createBinary(newPath, arrayBuffer);
				await this.app.vault.delete(file);
			}

			const saved = data.byteLength - arrayBuffer.byteLength;
			if (saved > 0) {
				new Notice(`Image resized: saved ${Math.round(saved / 1024)}KB`);
			} else {
				new Notice(`Image converted to JPG (${newWidth}x${newHeight})`);
			}
		} catch (e) {
			console.error('Image Auto Resizer: failed to process image', e);
		} finally {
			this.processing.delete(file.path);
			const jpgPath = file.path.replace(/\.[^.]+$/, '.jpg');
			this.processing.delete(jpgPath);
		}
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

	private async compressToJpeg(
		img: HTMLImageElement | ImageBitmap,
		width: number,
		height: number,
		quality: number
	): Promise<ArrayBuffer> {
		// Prefer OffscreenCanvas when available (faster, no DOM needed)
		if (typeof OffscreenCanvas !== 'undefined') {
			const canvas = new OffscreenCanvas(width, height);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Failed to get 2d context');
			ctx.drawImage(img, 0, 0, width, height);
			const blob = await canvas.convertToBlob({type: 'image/jpeg', quality});
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
				'image/jpeg',
				quality
			);
		});
	}

	private async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;
		await this.app.vault.createFolder(path);
	}
}
