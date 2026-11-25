import { describe, expect, test } from 'bun:test';
import {
	parseAvailableBrowserModes,
	parseBrowserViewUrl,
	parseReviewTagsDefault,
	readRequestedBrowserMode,
	readRequestedOutputFormat,
	readRequestedReviewTags,
	readStoredBrowserMode,
	readStoredOutputFormat,
	readStoredReviewTags,
	resolveReviewTags,
	shouldAutoFinalize,
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

describe('output-format preference hydration', () => {
	test('reads a valid output format from a userscript deep link', () => {
		expect(readRequestedOutputFormat('?outputFormat=flac')).toBe('flac');
		expect(readRequestedOutputFormat('?outputFormat=invalid')).toBeNull();
	});

	test('keeps configurable mp3 and fixed mp3-320 deep links distinct', () => {
		expect(readRequestedOutputFormat('?outputFormat=mp3')).toBe('mp3');
		expect(readRequestedOutputFormat('?outputFormat=mp3-320')).toBe('mp3-320');
	});

	test('reads stored formats through the same helper used by the UI', () => {
		const storage = { getItem: () => 'original' };
		expect(readStoredOutputFormat(storage, 'output-format')).toBe('original');
	});

	test('keeps a stored legacy mp3-320 preference rather than remapping it', () => {
		const storage = { getItem: () => 'mp3-320' };
		expect(readStoredOutputFormat(storage, 'output-format')).toBe('mp3-320');
	});

	test('ignores invalid stored formats', () => {
		const storage = { getItem: () => 'mp4' };
		expect(readStoredOutputFormat(storage, 'output-format')).toBeNull();
	});
});

describe('browser-mode preference hydration', () => {
	test('reads a valid browser mode from a userscript deep link', () => {
		expect(readRequestedBrowserMode('?browserMode=xvfb')).toBe('xvfb');
		expect(readRequestedBrowserMode('?browserMode=invalid')).toBeNull();
	});
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

describe('browser-view capability', () => {
	test('accepts an HTTP browser viewer URL', () => {
		expect(
			parseBrowserViewUrl({
				browserViewUrl: 'http://192.168.178.57:6080/vnc.html?autoconnect=true',
			}),
		).toBe('http://192.168.178.57:6080/vnc.html?autoconnect=true');
	});

	test('uses the Web UI hostname for a host template', () => {
		const capability = {
			browserViewUrl: 'http://{host}:6080/vnc.html?autoconnect=true',
		};
		expect(parseBrowserViewUrl(capability, '192.168.178.57')).toBe(
			'http://192.168.178.57:6080/vnc.html?autoconnect=true',
		);
		expect(parseBrowserViewUrl(capability, 'homelan')).toBe(
			'http://homelan:6080/vnc.html?autoconnect=true',
		);
		expect(parseBrowserViewUrl(capability, 'fd7a:115c:a1e0::1')).toBe(
			'http://[fd7a:115c:a1e0::1]:6080/vnc.html?autoconnect=true',
		);
	});

	test('rejects invalid and executable URLs', () => {
		expect(
			parseBrowserViewUrl({ browserViewUrl: 'javascript:alert(1)' }),
		).toBeNull();
		expect(parseBrowserViewUrl({ browserViewUrl: 'not a URL' })).toBeNull();
	});
});

describe('review-tags preference', () => {
	test('a deep link wins over a stored choice and the server default', () => {
		expect(readRequestedReviewTags('?reviewTags=true')).toBe(true);
		expect(readRequestedReviewTags('?reviewTags=false')).toBe(false);
		expect(resolveReviewTags(true, false, false)).toBe(true);
		expect(resolveReviewTags(false, true, true)).toBe(false);
	});

	test('a stored choice wins over the server default', () => {
		expect(resolveReviewTags(null, true, false)).toBe(true);
		expect(resolveReviewTags(null, false, true)).toBe(false);
	});

	test('the server default applies when nothing else is chosen', () => {
		expect(resolveReviewTags(null, null, true)).toBe(true);
		expect(resolveReviewTags(null, null, false)).toBe(false);
	});

	test('invalid stored or requested values fall back safely', () => {
		expect(readRequestedReviewTags('?reviewTags=maybe')).toBeNull();
		expect(readRequestedReviewTags('')).toBeNull();
		expect(
			readStoredReviewTags({ getItem: () => 'yes' }, 'sc-gate-dl-review-tags'),
		).toBeNull();
		expect(
			readStoredReviewTags({ getItem: () => 'true' }, 'sc-gate-dl-review-tags'),
		).toBe(true);
	});

	test('capabilities without a usable default mean false', () => {
		expect(parseReviewTagsDefault({ reviewTagsDefault: true })).toBe(true);
		expect(parseReviewTagsDefault({ reviewTagsDefault: 'x' })).toBe(false);
		expect(parseReviewTagsDefault(null)).toBe(false);
	});
});

describe('automatic finalization', () => {
	test('runs only for ready jobs that are not reviewed or original', () => {
		expect(shouldAutoFinalize(false, 'mp3', false)).toBe(true);
		expect(shouldAutoFinalize(true, 'mp3', false)).toBe(false);
		expect(shouldAutoFinalize(false, 'original', false)).toBe(false);
		expect(shouldAutoFinalize(false, 'mp3', true)).toBe(false);
	});
});
