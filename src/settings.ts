import {App, PluginSettingTab, Setting} from "obsidian";
import ImageAutoResizerPlugin from "./main";

export type OutputFormat = 'webp' | 'jpeg';

export interface ImageAutoResizerSettings {
	maxWidth: number;
	maxHeight: number;
	quality: number;
	outputFormat: OutputFormat;
}

export const DEFAULT_SETTINGS: ImageAutoResizerSettings = {
	maxWidth: 1200,
	maxHeight: 1200,
	quality: 0.8,
	outputFormat: 'webp',
}

export class ImageAutoResizerSettingTab extends PluginSettingTab {
	plugin: ImageAutoResizerPlugin;

	constructor(app: App, plugin: ImageAutoResizerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Output format')
			.setDesc('WebP produces smaller files at equivalent quality. JPEG has wider compatibility outside of Obsidian.')
			.addDropdown(drop => drop
				.addOption('webp', 'WebP (recommended)')
				.addOption('jpeg', 'JPEG')
				.setValue(this.plugin.settings.outputFormat)
				.onChange(async (value) => {
					this.plugin.settings.outputFormat = value as OutputFormat;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max width')
			.setDesc('Maximum image width in pixels. Images wider than this will be scaled down.')
			.addText(text => text
				.setPlaceholder('1200')
				.setValue(String(this.plugin.settings.maxWidth))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.maxWidth = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Max height')
			.setDesc('Maximum image height in pixels. Images taller than this will be scaled down.')
			.addText(text => text
				.setPlaceholder('1200')
				.setValue(String(this.plugin.settings.maxHeight))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.maxHeight = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Compression quality')
			.setDesc('Quality from 0.0 (worst) to 1.0 (best). Default: 0.8')
			.addText(text => text
				.setPlaceholder('0.7')
				.setValue(String(this.plugin.settings.quality))
				.onChange(async (value) => {
					const num = parseFloat(value);
					if (!isNaN(num) && num > 0 && num <= 1) {
						this.plugin.settings.quality = num;
						await this.plugin.saveSettings();
					}
				}));
	}
}
