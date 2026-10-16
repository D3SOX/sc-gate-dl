import { expect, spyOn, test } from 'bun:test';
import { DirectDownloader } from './directDownload';
import { HypedditDownloader } from './hypeddit';
import { HypedditHttpDownloader } from './hypedditHttp';

function linkGate(granted: boolean) {
	const gateUrl = 'https://hypeddit.com/artist/link';
	const clicks: string[] = [];
	let currentUrl = gateUrl;
	let unlock: (() => void) | undefined;
	const page = {
		setViewport: async () => {},
		goto: async (url: string) => {
			currentUrl = url;
		},
		url: () => currentUrl,
		content: async () => '<button id="downloadProcess">Download</button>',
		waitForNetworkIdle: async () => {},
		waitForSelector: async () => ({}),
		evaluate: async () => ['dw'],
		$eval: async () => true,
		close: async () => {},
		waitForResponse: async (
			predicate: (response: { url: () => string }) => boolean,
		) => {
			expect(predicate({ url: () => `${gateUrl}/unrelated` })).toBe(false);
			expect(
				predicate({ url: () => 'https://hypeddit.com/gate/download/ul' }),
			).toBe(true);
			await new Promise<void>((resolve) => {
				unlock = resolve;
			});
			return {
				json: async () => ({
					download_status: granted,
					custom_redirection_url: 'https://files.example.test/original.mp3',
				}),
			};
		},
		click: async (selector: string) => {
			clicks.push(selector);
			if (selector === '#gateDownloadButton') unlock?.();
		},
	};
	const downloader = new HypedditDownloader({
		comment: '',
		browserMode: 'headless',
	});
	Object.assign(downloader, {
		browser: { newPage: async () => page },
		browserLaunch: { close: async () => {} },
	});
	return { downloader, clicks };
}

test('an unlocked Hypeddit link is downloaded from the granted destination instead of waiting for CDP', async () => {
	const { downloader, clicks } = linkGate(true);
	const direct = spyOn(
		DirectDownloader.prototype,
		'downloadAudio',
	).mockResolvedValue('original.mp3');
	try {
		expect(
			await downloader.downloadAudio('https://hypeddit.com/artist/link'),
		).toBe('original.mp3');
		expect(direct).toHaveBeenCalledWith(
			'https://files.example.test/original.mp3',
		);
		expect(clicks).toEqual(['#downloadProcess', '#gateDownloadButton']);
	} finally {
		direct.mockRestore();
		await downloader.close();
	}
});

test('a denied link gate never fetches the destination', async () => {
	const { downloader } = linkGate(false);
	const direct = spyOn(DirectDownloader.prototype, 'downloadAudio');
	try {
		await expect(
			downloader.downloadAudio('https://hypeddit.com/artist/link'),
		).rejects.toThrow('Hypeddit did not grant access');
		expect(direct).not.toHaveBeenCalled();
	} finally {
		direct.mockRestore();
		await downloader.close();
	}
});

test('link gates go through the browser Unlock action rather than the browserless file flow', async () => {
	const requests: string[] = [];
	const mockFetch = Object.assign(
		async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return new Response(
				'<a id="gateDownloadButton" data-type="linkGate">Unlock</a>',
			);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(mockFetch);
	const downloader = new HypedditHttpDownloader({
		comment: '',
		browserMode: 'headless',
	});
	try {
		expect(
			await downloader.tryDownload('https://hypeddit.com/artist/link'),
		).toBeNull();
		expect(requests).toEqual(['https://hypeddit.com/artist/link']);
	} finally {
		fetch.mockRestore();
		await downloader.close();
	}
});
