import {App, PluginSettingTab, Setting} from "obsidian";
import ImageAutoResizerPlugin from "./main";

export interface ImageAutoResizerSettings {
	maxWidth: number;
	maxHeight: number;
	jpegQuality: number;
}

export const DEFAULT_SETTINGS: ImageAutoResizerSettings = {
	maxWidth: 1200,
	maxHeight: 1200,
	jpegQuality: 0.7,
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

		containerEl.createEl('h2', {text: 'Image Auto Resizer Settings'});

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
			.setName('JPEG quality')
			.setDesc('Compression quality from 0.0 (worst) to 1.0 (best). Default: 0.7')
			.addText(text => text
				.setPlaceholder('0.7')
				.setValue(String(this.plugin.settings.jpegQuality))
				.onChange(async (value) => {
					const num = parseFloat(value);
					if (!isNaN(num) && num > 0 && num <= 1) {
						this.plugin.settings.jpegQuality = num;
						await this.plugin.saveSettings();
					}
				}));
	}
}
