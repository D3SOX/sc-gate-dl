import { type BrowserMode, isBrowserMode } from '../../../src/types';

export function readStoredBrowserMode(
	storage: Pick<Storage, 'getItem'>,
	key: string,
): BrowserMode | null {
	const storedMode = storage.getItem(key);
	return isBrowserMode(storedMode) ? storedMode : null;
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
