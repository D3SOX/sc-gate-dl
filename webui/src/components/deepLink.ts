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
