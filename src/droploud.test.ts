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
