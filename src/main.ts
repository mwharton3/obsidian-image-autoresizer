import {Editor, MarkdownView, Notice, Plugin, TFile, TFolder} from 'obsidian';
import {DEFAULT_SETTINGS, ImageAutoResizerSettings, ImageAutoResizerSettingTab, OutputFormat} from "./settings";
import heic2any from 'heic2any';
import * as UTIF from 'utif2';

// Formats natively decodable by the browser/canvas
const NATIVE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);
// Formats that need special decoding before canvas processing
const DECODE_IMAGE_EXTENSIONS = new Set(['heic', 'heif', 'tif', 'tiff']);

const ALL_IMAGE_EXTENSIONS = new Set([...NATIVE_IMAGE_EXTENSIONS, ...DECODE_IMAGE_EXTENSIONS]);

// Map MIME types to extensions for clipboard/drop files
const MIME_TO_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
	'image/heic': 'heic',
	'image/heif': 'heif',
	'image/tiff': 'tiff',
	'image/tif': 'tif',
};

export default class ImageAutoResizerPlugin extends Plugin {
	settings: ImageAutoResizerSettings;
	private processing = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ImageAutoResizerSettingTab(this.app, this));

		// Intercept paste events to handle images before Obsidian inserts the wrong link
		this.registerEvent(
			this.app.workspace.on('editor-paste', (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
				if (this.handleEditorImages(evt.clipboardData, editor, view)) {
					evt.preventDefault();
				}
			})
		);

		// Intercept drop events similarly
		this.registerEvent(
			this.app.workspace.on('editor-drop', (evt: DragEvent, editor: Editor, view: MarkdownView) => {
				if (this.handleEditorImages(evt.dataTransfer, editor, view)) {
					evt.preventDefault();
				}
			})
		);

		// Fallback for images added via other means (file manager, sync, etc.)
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

	/**
	 * Handle images from paste/drop events. Returns true if images were found
	 * (meaning the caller should preventDefault).
	 */
	private handleEditorImages(
		dataTransfer: DataTransfer | null,
		editor: Editor,
		view: MarkdownView
	): boolean {
		if (!dataTransfer) return false;

		const imageFiles: File[] = [];
		for (let i = 0; i < dataTransfer.files.length; i++) {
			const file = dataTransfer.files.item(i);
			if (file && file.type.startsWith('image/')) {
				imageFiles.push(file);
			}
		}

		if (imageFiles.length === 0) return false;

		// Process each image asynchronously
		for (const file of imageFiles) {
			this.processDroppedImage(file, editor, view);
		}

		return true;
	}

	/**
	 * Process a single image from paste/drop: convert, save with correct extension,
	 * and insert the correct embed link directly.
	 */
	private async processDroppedImage(file: File, editor: Editor, view: MarkdownView): Promise<void> {
		try {
			const data = await file.arrayBuffer();
			const ext = this.getExtFromFile(file);
			if (!ext || !ALL_IMAGE_EXTENSIONS.has(ext)) return;

			const processed = await this.processImageData(data, ext);

			// Generate a filename based on the original name or a timestamp.
			// On mobile (iOS), pasted images often arrive with a generic name
			// like "image.png" — replace these with a readable timestamp.
			const rawName = file.name ? file.name.replace(/\.[^.]+$/, '') : '';
			const baseName = this.isGenericImageName(rawName)
				? `Pasted image ${this.formatTimestamp()}`
				: rawName;

			// Use Obsidian's API to resolve the correct attachment path (handles
			// deduplication, folder creation, and respects user's attachment settings)
			const sourcePath = view.file?.path;
			const filePath = await this.app.fileManager.getAvailablePathForAttachment(
				`${baseName}.${this.outputExt}`,
				sourcePath
			);
			const fileName = filePath.split('/').pop()!;

			// Mark as processing so the create handler doesn't double-process
			this.processing.add(filePath);
			try {
				await this.app.vault.createBinary(filePath, processed.arrayBuffer);
			} finally {
				this.processing.delete(filePath);
			}

			// Insert the correct embed link at the cursor
			const linkText = `![[${fileName}]]\n`;
			editor.replaceSelection(linkText);

			const saved = data.byteLength - processed.arrayBuffer.byteLength;
			const formatLabel = this.outputExt.toUpperCase();
			if (saved > 0) {
				new Notice(`Image resized: saved ${Math.round(saved / 1024)}KB`);
			} else {
				new Notice(`Image converted to ${formatLabel} (${processed.width}x${processed.height})`);
			}
		} catch (e) {
			console.error('Image Auto Resizer: failed to process pasted/dropped image', e);
			new Notice('Image Auto Resizer: failed to process image');
		}
	}

	private getExtFromFile(file: File): string | null {
		// Try to get extension from filename first
		if (file.name) {
			const match = file.name.match(/\.([^.]+)$/);
			if (match) {
				const ext = match[1]!.toLowerCase();
				if (ALL_IMAGE_EXTENSIONS.has(ext)) return ext;
			}
		}
		// Fall back to MIME type
		return MIME_TO_EXT[file.type] || null;
	}

	/**
	 * Core image processing: decode, resize, and compress.
	 * Returns the processed ArrayBuffer and dimensions.
	 */
	private async processImageData(
		data: ArrayBuffer,
		ext: string
	): Promise<{arrayBuffer: ArrayBuffer; width: number; height: number}> {
		const {maxWidth, maxHeight, quality, outputFormat} = this.settings;

		let img: HTMLImageElement | ImageBitmap;

		if (DECODE_IMAGE_EXTENSIONS.has(ext)) {
			img = await this.decodeSpecialFormat(data, ext);
		} else {
			const blob = new Blob([data], {type: `image/${ext === 'jpg' ? 'jpeg' : ext}`});
			img = await this.loadImage(blob);
		}

		const {width, height} = img;

		// Skip conversion if already in target format and within size limits
		const isTargetFormat = (outputFormat === 'jpeg' && (ext === 'jpg' || ext === 'jpeg'))
			|| (outputFormat === 'webp' && ext === 'webp');
		if (isTargetFormat && width <= maxWidth && height <= maxHeight) {
			this.cleanupImage(img);
			return {arrayBuffer: data, width, height};
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

		return {arrayBuffer, width: newWidth, height: newHeight};
	}

	/**
	 * Fallback handler for images added via file manager, sync, or other non-editor means.
	 */
	private async handleNewImage(file: TFile): Promise<void> {
		const ext = file.extension.toLowerCase();
		if (!ALL_IMAGE_EXTENSIONS.has(ext)) return;

		if (this.processing.has(file.path)) return;
		this.processing.add(file.path);

		let newPath = file.path;
		try {
			const data = await this.app.vault.readBinary(file);

			const processed = await this.processImageData(data, ext);

			// If no conversion needed (same buffer returned), skip
			if (processed.arrayBuffer === data) return;

			// Determine the new file path, replacing generic names with a timestamp
			const oldBaseName = file.basename;
			const newBaseName = this.isGenericImageName(oldBaseName)
				? `Pasted image ${this.formatTimestamp()}`
				: oldBaseName;
			const folder = file.parent?.path === '/' ? '' : `${file.parent?.path}/`;
			newPath = `${folder}${newBaseName}.${this.outputExt}`;

			if (newPath === file.path) {
				await this.app.vault.modifyBinary(file, processed.arrayBuffer);
			} else {
				const parentFolder = file.parent;
				if (parentFolder && parentFolder.path !== '/') {
					await this.ensureFolder(parentFolder.path);
				}

				// Handle name collisions by appending a counter
				let counter = 1;
				while (this.app.vault.getAbstractFileByPath(newPath)) {
					newPath = `${folder}${newBaseName}-${counter}.${this.outputExt}`;
					counter++;
				}

				this.processing.add(newPath);
				await this.app.vault.createBinary(newPath, processed.arrayBuffer);

				// Update references in the active note before deleting the old file
				const oldName = file.name;
				const newName = newPath.split('/').pop()!;
				await this.updateReferences(oldName, newName);

				await this.app.vault.delete(file);
			}

			const saved = data.byteLength - processed.arrayBuffer.byteLength;
			const formatLabel = this.outputExt.toUpperCase();
			if (saved > 0) {
				new Notice(`Image resized: saved ${Math.round(saved / 1024)}KB`);
			} else {
				new Notice(`Image converted to ${formatLabel} (${processed.width}x${processed.height})`);
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

	/**
	 * Detect generic image names that mobile/clipboard pastes produce
	 * (e.g. "image", "Image", "photo", "IMG_1234").
	 */
	private isGenericImageName(name: string): boolean {
		if (!name) return true;
		const lower = name.toLowerCase().trim();
		return lower === 'image' || lower === 'photo' || lower === 'pasted image';
	}

	private formatTimestamp(): string {
		const d = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	}

	private async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;
		await this.app.vault.createFolder(path);
	}
}
