/**
 * Minimal stub of the Obsidian API for unit tests.
 * Only the exports actually used by the source modules are included.
 */
export function normalizePath(p: string): string {
	return p
		.replace(/\\/g, '/')   // backslash → forward slash
		.replace(/^\/+/, '')    // no leading slash
		.replace(/\/+$/, '');   // no trailing slash
}

export class Notice {
	constructor(public message: string, public timeout?: number) { }
	hide(): void { }
}

export class Plugin {
	constructor(public app: unknown, public manifest: unknown) { }
}
export class PluginSettingTab { }
export class Modal { }
export class SuggestModal { }
export class FuzzySuggestModal { }
export class TFile {
	path = '';
}
export class TFolder extends TFile {
	children: TFile[] = [];
}

/** Platform stub — always simulates desktop in unit tests. */
export const Platform = {
	isMobile: false,
	isDesktop: true,
	isMobileApp: false,
	isDesktopApp: true,
	isIosApp: false,
	isAndroidApp: false,
};
