import { describe, expect, test } from 'bun:test';

type UpdateFeedPlaybackOrigin = (
	currentOrigin: string | null,
	feedCardUrl: string | null,
	outsidePlaybackSelection: boolean,
) => string | null;

type StoreServiceForUrl = (href: string) => string | null;
type NormalizeWebuiBase = (value: string) => string;

const source = await Bun.file(
	new URL('./sc-gate-dl.user.js', import.meta.url),
).text();

function extractHelper<T>(
	startMarker: string,
	endMarker: string,
	name: string,
): T {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start);
	if (start < 0 || end < 0) throw new Error(`${name} helper not found`);
	const helperSource = source.slice(start, end).trim();
	return Function(`"use strict"; ${helperSource}; return ${name};`)() as T;
}

const updateFeedPlaybackOrigin = extractHelper<UpdateFeedPlaybackOrigin>(
	'\tfunction updateFeedPlaybackOrigin(',
	'\n\n\tlet lastRecordedPlayingUrl',
	'updateFeedPlaybackOrigin',
);
const storeServiceForUrl = extractHelper<StoreServiceForUrl>(
	'\tfunction storeServiceForUrl(',
	'\n\n\tfunction decorateStoreLink(',
	'storeServiceForUrl',
);
const normalizeWebuiBase = extractHelper<NormalizeWebuiBase>(
	'\tfunction normalizeWebuiBase(',
	'\n\n\tfunction setWebuiBase(',
	'normalizeWebuiBase',
);

describe('feed playback origin', () => {
	test('clears feed provenance when another track is selected outside the feed', () => {
		expect(
			updateFeedPlaybackOrigin('https://soundcloud.com/feed/track', null, true),
		).toBeNull();
	});

	test('preserves feed provenance through unrelated page clicks', () => {
		const origin = 'https://soundcloud.com/feed/track';
		expect(updateFeedPlaybackOrigin(origin, null, false)).toBe(origin);
	});
});

describe('store link branding', () => {
	test('recognizes MyPressKit gate URLs', () => {
		expect(
			storeServiceForUrl(
				'https://www.mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit',
			),
		).toBe('mypresskit');
		expect(
			storeServiceForUrl(
				'https://mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit/',
			),
		).toBe('mypresskit');
	});

	test('rejects non-gate MyPressKit URLs', () => {
		expect(storeServiceForUrl('https://www.mypresskit.info/')).toBeNull();
		expect(
			storeServiceForUrl('https://www.mypresskit.info/marketplace'),
		).toBeNull();
		expect(storeServiceForUrl('https://example.com/gate/foo')).toBeNull();
	});
});

describe('Web UI preferences', () => {
	test('normalizes HTTP(S) server addresses', () => {
		expect(normalizeWebuiBase(' http://192.168.178.57:4321/ ')).toBe(
			'http://192.168.178.57:4321',
		);
		expect(normalizeWebuiBase('https://downloads.example.com/?old=1#top')).toBe(
			'https://downloads.example.com',
		);
		expect(() => normalizeWebuiBase('ftp://downloads.example.com')).toThrow();
	});

	test('offers server configuration without developer tools', () => {
		expect(source).toContain("GM_registerMenuCommand('Configure server…'");
		expect(source).toContain('class="sc-gate-dl-server"');
	});

	test('offers a remembered always-open-in-tab mode', () => {
		expect(source).toContain('sc-gate-dl-always-open-tab');
		expect(source).toContain('Always open downloads in new tab:');
		expect(source).toContain(
			"window.open(buildWebuiSrc(trackUrl), '_blank', 'noopener,noreferrer')",
		);
	});

	test('passes the remembered browser mode through the deep link', () => {
		expect(source).toContain('browserMode: getBrowserMode()');
		expect(source).toContain('class="sc-gate-dl-browser-mode"');
		expect(source).toContain("GM_registerMenuCommand('Choose browser mode…'");
	});

	test('releases remote pointer capture when mouseup happens outside iframe', () => {
		expect(source).toContain("type: 'release-remote-pointer'");
		expect(source).toContain(
			"window.addEventListener('pointerup', releaseRemotePointer, true)",
		);
	});
});
