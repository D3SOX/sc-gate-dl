import { describe, expect, test } from 'bun:test';
import {
	parseAvailableBrowserModes,
	readStoredBrowserMode,
	shouldAutoStartDeepLink,
	shouldUseEmbeddedLayout,
} from '../webui/src/components/deepLink';

describe('deep-link startup predicate', () => {
	test('waits for browser-mode hydration', () => {
		const queryUrl = 'https://soundcloud.com/artist/track';
		expect(shouldAutoStartDeepLink(false, false, queryUrl)).toBeFalse();
		expect(shouldAutoStartDeepLink(true, false, queryUrl)).toBeTrue();
	});

	test('does not restart an already-started deep link', () => {
		expect(
			shouldAutoStartDeepLink(
				true,
				true,
				'https://soundcloud.com/artist/track',
			),
		).toBeFalse();
	});

	test('requires a query URL', () => {
		expect(shouldAutoStartDeepLink(true, false, null)).toBeFalse();
	});
});

describe('embedded layout query parameter', () => {
	test('enables the compact layout only for embedded=1', () => {
		expect(shouldUseEmbeddedLayout('?url=track&embedded=1')).toBeTrue();
		expect(shouldUseEmbeddedLayout('?url=track')).toBeFalse();
		expect(shouldUseEmbeddedLayout('?embedded=0')).toBeFalse();
	});
});

describe('browser-mode preference hydration', () => {
	test('reads stored Xvfb through the same helper used by the UI', () => {
		const storage = { getItem: () => 'xvfb' };
		expect(readStoredBrowserMode(storage, 'browser-mode')).toBe('xvfb');
	});

	test('ignores invalid stored modes', () => {
		const storage = { getItem: () => 'invalid' };
		expect(readStoredBrowserMode(storage, 'browser-mode')).toBeNull();
	});
});

describe('browser-mode capabilities', () => {
	test('accepts the browser modes advertised by a Linux server', () => {
		expect(
			parseAvailableBrowserModes({
				browserModes: ['headless', 'xvfb', 'headed'],
			}),
		).toEqual(['headless', 'xvfb', 'headed']);
	});

	test('falls back to portable modes for an invalid response', () => {
		expect(parseAvailableBrowserModes(null)).toEqual(['headless', 'headed']);
		expect(parseAvailableBrowserModes({ browserModes: ['invalid'] })).toEqual([
			'headless',
			'headed',
		]);
	});
});
