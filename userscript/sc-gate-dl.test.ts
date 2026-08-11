import { describe, expect, test } from 'bun:test';

type UpdateFeedPlaybackOrigin = (
	currentOrigin: string | null,
	feedCardUrl: string | null,
	outsidePlaybackSelection: boolean,
) => string | null;

const source = await Bun.file(
	new URL('./sc-gate-dl.user.js', import.meta.url),
).text();
const start = source.indexOf('\tfunction updateFeedPlaybackOrigin(');
const end = source.indexOf('\n\n\tlet lastRecordedPlayingUrl', start);
if (start < 0 || end < 0) throw new Error('Playback-origin helper not found');
const helperSource = source.slice(start, end).trim();
const updateFeedPlaybackOrigin = Function(
	`"use strict"; ${helperSource}; return updateFeedPlaybackOrigin;`,
)() as UpdateFeedPlaybackOrigin;

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

describe('Web UI preferences', () => {
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
