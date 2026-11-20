import { expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { DroploudDownloader } from './droploud';

test('opens the correct social card when a disabled confirmation precedes it', async () => {
	const clicked: string[] = [];
	let snapshot = 0;
	let pagesRead = 0;
	const popup = {
		url: () => 'https://example.com/',
		isClosed: () => false,
		close: async () => {},
	} as unknown as Page;
	const button = (label: string) => ({
		evaluate: async () => label,
		click: async () => {
			clicked.push(label);
		},
		dispose: async () => {},
	});
	const page = {
		evaluate: async () =>
			++snapshot === 1
				? [
						{ kind: 'verify', label: "I've done it", enabled: false },
						{ kind: 'open', label: 'Open Instagram', done: false },
					]
				: [],
		$$: async () => [button("I've done it"), button('Open Instagram')],
		$eval: async () => 'Follow on Instagram',
	} as unknown as Page;
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, {
		browser: {
			pages: async () => (++pagesRead === 1 ? [page] : [page, popup]),
		},
	});
	await (
		downloader as unknown as { handleSocialCards(page: Page): Promise<void> }
	).handleSocialCards(page);
	expect(clicked).toEqual(['Open Instagram']);
});

test('waits for a gate step to appear after a transient unknown state', async () => {
	const page = {
		setViewport: async () => {},
		goto: async () => {},
		waitForNetworkIdle: async () => {},
		waitForFunction: async () => {},
		close: async () => {},
	} as unknown as Page;
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	const states = ['unknown', 'soundcloud_connect', 'unlocked', 'unlocked'];
	let handled = false;
	Object.assign(downloader, {
		browser: { newPage: async () => page },
		dismissCookieBanner: async () => {},
		startGateIfNeeded: async () => {},
		detectPaneKind: async () => states.shift() ?? 'unknown',
		handleSoundcloudConnect: async () => {
			handled = true;
		},
		handleDownload: async () => {},
	});
	await downloader.downloadAudio('https://droploud.com/track/test');
	expect(handled).toBeTrue();
});

test('handles the SoundCloud repost in the social popup before verifying', async () => {
	const events: string[] = [];
	let snapshot = 0;
	let pagesRead = 0;
	const popup = {
		url: () => 'https://soundcloud.com/artist/track',
		isClosed: () => false,
		close: async () => {
			events.push('close');
		},
	} as unknown as Page;
	const handle = {
		evaluate: async () => 'Open SoundCloud',
		click: async () => {
			events.push('open');
		},
		dispose: async () => {},
	};
	const page = {
		evaluate: async () =>
			++snapshot === 1
				? [{ kind: 'open', label: 'Open SoundCloud', done: false }]
				: [],
		$$: async () => [handle],
		$eval: async () => 'Repost the track',
	} as unknown as Page;
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, {
		browser: {
			pages: async () => (++pagesRead === 1 ? [page] : [page, popup]),
		},
		performSoundcloudManualActions: async (
			_page: Page,
			actions: { repost: boolean },
		) => {
			if (actions.repost) events.push('repost');
		},
	});
	await (
		downloader as unknown as { handleSocialCards(page: Page): Promise<void> }
	).handleSocialCards(page);
	expect(events).toEqual(['open', 'repost', 'close']);
});

test('does not repost for an unrelated SoundCloud social card', async () => {
	let snapshot = 0;
	let pagesRead = 0;
	let repostCalled = false;
	const popup = {
		url: () => 'https://soundcloud.com/artist/track',
		isClosed: () => false,
		close: async () => {},
	} as unknown as Page;
	const page = {
		evaluate: async () =>
			++snapshot === 1
				? [{ kind: 'open', label: 'Open SoundCloud', done: false }]
				: [],
		$$: async () => [
			{
				evaluate: async () => 'Open SoundCloud',
				click: async () => {},
				dispose: async () => {},
			},
		],
		$eval: async () => 'Follow on SoundCloud',
	} as unknown as Page;
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	Object.assign(downloader, {
		browser: {
			pages: async () => (++pagesRead === 1 ? [page] : [page, popup]),
		},
		performSoundcloudManualActions: async () => {
			repostCalled = true;
		},
	});
	await (
		downloader as unknown as { handleSocialCards(page: Page): Promise<void> }
	).handleSocialCards(page);
	expect(repostCalled).toBeFalse();
});
