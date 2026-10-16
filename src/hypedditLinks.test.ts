import { expect, spyOn, test } from 'bun:test';
import { HypedditDownloader } from './hypeddit';
import { HypedditHttpDownloader } from './hypedditHttp';
import { inspectHypedditPage } from './hypedditLinks';

test('smartlink classification preserves unknown pages and requires a unique download', () => {
	expect(inspectHypedditPage('<html>Loading...</html>', smartUrl)).toBeNull();
	expect(
		inspectHypedditPage(
			'<button id="downloadProcess">Download</button>',
			smartUrl,
		),
	).toBeNull();
	expect(() =>
		inspectHypedditPage(
			smartPage.replace(
				'</section>',
				`<a class="smartlink-click-button" href="https://hypeddit.com/another/recording">Download</a></section>`,
			),
			smartUrl,
		),
	).toThrow('Multiple Hypeddit');
});

test('a started browser transfer can finish after the start timeout', async () => {
	const handlers = new Map<string, (event: Record<string, unknown>) => void>();
	const page = {
		setViewport: async () => {},
		goto: async () => {},
		url: () => gateUrl,
		content: async () => '<button id="downloadProcess">Download</button>',
		waitForNetworkIdle: async () => {},
		waitForSelector: async () => ({}),
		evaluate: async () => ['dw'],
		$eval: async () => false,
		close: async () => {},
		createCDPSession: async () => ({
			send: async () => {},
			on: (name: string, handler: (event: Record<string, unknown>) => void) => {
				handlers.set(name, handler);
			},
			detach: async () => {},
		}),
		click: async (selector: string) => {
			if (selector !== '#gateDownloadButton') return;
			handlers.get('Browser.downloadWillBegin')?.({
				guid: 'test',
				suggestedFilename: 'recording.wav',
			});
			setTimeout(
				() =>
					handlers.get('Browser.downloadProgress')?.({
						guid: 'test',
						state: 'completed',
					}),
				30,
			);
		},
	};
	const downloader = new HypedditDownloader({
		comment: '',
		browserMode: 'headless',
	});
	Object.assign(downloader, {
		downloadStartTimeoutMs: 10,
		browser: { newPage: async () => page },
		browserLaunch: { close: async () => {} },
	});
	try {
		expect(await downloader.downloadAudio(gateUrl)).toBe('recording.wav');
	} finally {
		await downloader.close();
	}
});

test('a browser download that never starts fails promptly instead of occupying the entire transfer timeout', async () => {
	const downloader = new HypedditDownloader({
		comment: '',
		browserMode: 'headless',
	});
	const page = {
		setViewport: async () => {},
		goto: async () => {},
		url: () => gateUrl,
		content: async () => '<button id="downloadProcess">Download</button>',
		waitForNetworkIdle: async () => {},
		waitForSelector: async () => ({}),
		evaluate: async () => ['dw'],
		$eval: async () => false,
		close: async () => {},
		createCDPSession: async () => ({
			send: async () => {},
			on: () => {},
			detach: async () => {},
		}),
		click: async (selector: string) => {
			if (selector === '#gateDownloadButton')
				watchdog = setTimeout(() => void downloader.close(), 100);
		},
	};
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	Object.assign(downloader, {
		downloadStartTimeoutMs: 10,
		browser: { newPage: async () => page },
		browserLaunch: { close: async () => {} },
	});
	try {
		await expect(downloader.downloadAudio(gateUrl)).rejects.toThrow(
			'Hypeddit download did not start',
		);
	} finally {
		clearTimeout(watchdog);
		await downloader.close();
	}
});

const smartUrl = 'https://hypeddit.com/woodpop/higherorder';
const gateUrl =
	'https://hypeddit.com/amsterdamdancecapital/woodpopgetdownbonusadc053';
const smartPage = `<section class="hype-smart-link-list-section">
 <a href="${gateUrl}" class="smartlink-click-button" data-type="custom"><span>Bonus</span><span>Download</span></a>
 <a href="https://open.spotify.com/album/example" class="smartlink-click-button" data-type="spotify">Play</a>
</section>`;

test('the browser follows a custom Hypeddit download link before waiting for the gate', async () => {
	const visited: string[] = [];
	let current = '';
	const page = {
		setViewport: async () => {},
		goto: async (url: string) => {
			current = url;
			visited.push(url);
		},
		url: () => current,
		content: async () =>
			current === smartUrl
				? smartPage
				: '<button id="downloadProcess">Download</button>',
		waitForNetworkIdle: async () => {},
		$: async () => null,
		waitForSelector: async (selector: string) => {
			if (selector === '#downloadProcess' && current === smartUrl)
				throw new Error('Waiting for selector `#downloadProcess` failed');
			return {};
		},
		click: async () => {},
		evaluate: async () => [],
		close: async () => {},
	};
	const downloader = new HypedditDownloader({
		comment: '',
		browserMode: 'headless',
	});
	Object.assign(downloader, { browser: { newPage: async () => page } });
	await downloader.downloadAudio(smartUrl);
	expect(visited).toEqual([smartUrl, gateUrl]);
});

test('HTTP follows custom download links and explicitly rejects stream-only smartlinks', async () => {
	const visited: string[] = [];
	let html = smartPage;
	const fetchMock = Object.assign(
		async (input: RequestInfo | URL) => {
			visited.push(String(input));
			return new Response(
				String(input) === smartUrl
					? html
					: '<button id="downloadProcess">Download</button>',
			);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
	try {
		const downloader = new HypedditHttpDownloader({
			comment: '',
			browserMode: 'headless',
		});
		await downloader.tryDownload(smartUrl);
		expect(visited).toEqual([smartUrl, gateUrl]);
		html = `<section class="hype-smart-link-list-section"><a class="smartlink-click-button" data-type="spotify" href="https://open.spotify.com/track/example">Play</a></section>`;
		await expect(downloader.tryDownload(smartUrl)).rejects.toThrow(
			'Hypeddit page has no download link',
		);
	} finally {
		fetch.mockRestore();
	}
});
