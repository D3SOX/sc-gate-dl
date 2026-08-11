import {
	type BrowserMode,
	isBrowserMode,
	isOutputFormat,
	type OutputFormat,
} from '../../../src/types';

export function readStoredBrowserMode(
	storage: Pick<Storage, 'getItem'>,
	key: string,
): BrowserMode | null {
	const storedMode = storage.getItem(key);
	return isBrowserMode(storedMode) ? storedMode : null;
}

export function readRequestedBrowserMode(search: string): BrowserMode | null {
	const mode = new URLSearchParams(search).get('browserMode');
	return isBrowserMode(mode) ? mode : null;
}

export function readStoredOutputFormat(
	storage: Pick<Storage, 'getItem'>,
	key: string,
): OutputFormat | null {
	const storedFormat = storage.getItem(key);
	return isOutputFormat(storedFormat) ? storedFormat : null;
}

export function readRequestedOutputFormat(search: string): OutputFormat | null {
	const format = new URLSearchParams(search).get('outputFormat');
	return isOutputFormat(format) ? format : null;
}

export function shouldAutoStartDeepLink(
	browserModeHydrated: boolean,
	alreadyStarted: boolean,
	queryUrl: string | null,
): queryUrl is string {
	return browserModeHydrated && !alreadyStarted && Boolean(queryUrl);
}

export function shouldUseEmbeddedLayout(search: string): boolean {
	return new URLSearchParams(search).get('embedded') === '1';
}

export function parseAvailableBrowserModes(value: unknown): BrowserMode[] {
	if (!value || typeof value !== 'object') return ['headless', 'headed'];
	const browserModes = (value as { browserModes?: unknown }).browserModes;
	if (!Array.isArray(browserModes)) return ['headless', 'headed'];
	const parsed = browserModes.filter(isBrowserMode);
	return parsed.length > 0 ? parsed : ['headless', 'headed'];
}

export function parseBrowserViewUrl(
	value: unknown,
	currentHostname?: string,
): string | null {
	if (!value || typeof value !== 'object') return null;
	const browserViewUrl = (value as { browserViewUrl?: unknown }).browserViewUrl;
	if (typeof browserViewUrl !== 'string') return null;

	try {
		const hostname = currentHostname?.includes(':')
			? `[${currentHostname.replace(/^\[|\]$/g, '')}]`
			: currentHostname;
		const resolvedUrl = hostname
			? browserViewUrl.replaceAll('{host}', hostname)
			: browserViewUrl;
		const url = new URL(resolvedUrl);
		return url.protocol === 'http:' || url.protocol === 'https:'
			? url.href
			: null;
	} catch {
		return null;
	}
}
