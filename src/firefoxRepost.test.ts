import { describe, expect, test } from 'bun:test';
import type { AccessibleNode } from './atspi';
import { findCaptcha, findRepostButton } from './firefoxRepost';

const node = (
	role: string,
	name: string,
	[x, y, width, height]: [number, number, number, number],
	doc = 2,
): AccessibleNode => ({ role, name, x, y, width, height, doc });

// Read from SoundCloud's track page and DataDome's challenge in Firefox.
const trackButtons = [
	node('button', 'Share', [668, 515, 40, 40]),
	node('button', 'Copy link', [716, 515, 40, 40]),
	node('button', 'Repost', [764, 515, 40, 40]),
	node('button', 'Add to playlist', [812, 515, 40, 40]),
];
const challenge = [
	node('button', 'Switch to the visual verification', [577, 341, 45, 30], 3),
	node('button', 'Reload the verification', [814, 342, 45, 30], 3),
	node('section', '', [551, 382, 338, 121], 3),
	node('section', '', [580, 382, 280, 60], 3),
	node('status bar', '', [580, 402, 280, 40], 3),
	node('paragraph', '', [551, 403, 338, 40], 3),
	node('section', '', [580, 443, 63, 40], 3),
];

describe('findRepostButton', () => {
	test('finds the Repost button', () => {
		expect(findRepostButton(trackButtons)).toEqual({
			state: 'repost',
			at: { x: 784, y: 535 },
		});
	});

	test('sees a track that is already reposted', () => {
		expect(
			findRepostButton([
				node('section', 'Unpost / Edit repost', [764, 515, 40, 40]),
				node('button', 'Unpost / Edit repost', [764, 515, 40, 40]),
			]),
		).toEqual({ state: 'reposted' });
	});

	test('ignores hidden buttons and a page still loading', () => {
		expect(findRepostButton([node('button', 'Repost', [-1, -1, -1, -1])])).toBe(
			null,
		);
		expect(findRepostButton([])).toBe(null);
	});
});

describe('findCaptcha', () => {
	test('finds the slider handle and drags it onto the target box', () => {
		expect(findCaptcha([...trackButtons, ...challenge])).toEqual({
			doc: 3,
			slider: { from: { x: 611.5, y: 463 }, to: { x: 834.5, y: 463 } },
		});
	});

	test('finds the Retry button after a failed slide', () => {
		expect(
			findCaptcha([
				node('button', 'Reload the verification', [814, 342, 45, 30], 3),
				node('button', 'RETRY', [583, 415, 274, 40], 3),
			]),
		).toEqual({ doc: 3, retry: { x: 720, y: 435 } });
	});

	test('is null without a challenge', () => {
		expect(findCaptcha(trackButtons)).toBe(null);
	});
});
