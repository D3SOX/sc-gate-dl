import { expect, test } from 'bun:test';
import { HypedditDownloader, type ProgressCallback } from './hypeddit';

const gateUrl = 'https://hypeddit.com/transition/trsn005onlywithyoucomeon';

function bandcampDownload(
	skipVisible: boolean | null,
	failManualStep = false,
	gate = 'bc',
) {
	const clicks: string[] = [];
	const waits: {
		selector: string;
		hidden?: boolean;
		visible?: boolean;
		timeout?: number;
	}[] = [];
	const handlers = new Map<string, (event: Record<string, unknown>) => void>();
	let manualStepCompleted = false;
	const page = {
		setViewport: async () => {},
		goto: async () => {},
		url: () => gateUrl,
		content: async () => '<button id="downloadProcess">Download</button>',
		waitForNetworkIdle: async () => {},
		waitForSelector: async (
			selector: string,
			options: { hidden?: boolean; visible?: boolean } = {},
		) => {
			waits.push({ selector, ...options });
			if (selector === `#step_${gate}` && options.hidden) {
				if (failManualStep) throw new Error('Waiting for selector failed');
				expect(manualStepCompleted).toBe(true);
			}
			return {};
		},
		$: async (selector: string) => {
			if (gate === 'ig' && selector !== '#skipper_ig') return null;
			expect(selector).toBe(`#skipper_${gate}`);
			return skipVisible === null
				? null
				: {
						isVisible: async () => skipVisible,
						click: async () => {
							clicks.push(selector);
						},
					};
		},
		evaluate: async () => [gate, 'dw'],
		$eval: async () => false,
		bringToFront: async () => {},
		close: async () => {},
		createCDPSession: async () => ({
			send: async () => {},
			on: (name: string, handler: (event: Record<string, unknown>) => void) => {
				handlers.set(name, handler);
			},
			detach: async () => {},
		}),
		click: async (selector: string) => {
			clicks.push(selector);
			if (selector !== '#gateDownloadButton') return;
			handlers.get('Browser.downloadWillBegin')?.({
				guid: 'test',
				suggestedFilename: 'OnlyWithYou - Come On.mp3',
			});
			handlers.get('Browser.downloadProgress')?.({
				guid: 'test',
				state: 'completed',
			});
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
	return {
		downloader,
		clicks,
		waits,
		completeManualStep: () => {
			manualStepCompleted = true;
		},
	};
}

test('Bandcamp uses the offered visible skip and downloads the gate recording', async () => {
	const { downloader, clicks } = bandcampDownload(true);
	try {
		expect(await downloader.downloadAudio(gateUrl)).toBe(
			'OnlyWithYou - Come On.mp3',
		);
		expect(clicks).toEqual([
			'#downloadProcess',
			'#skipper_bc',
			'#gateDownloadButton',
		]);
	} finally {
		await downloader.close();
	}
});

for (const skipVisible of [false, null]) {
	test(`Bandcamp requests attention when its skip is ${skipVisible === null ? 'absent' : 'hidden'}`, async () => {
		const { downloader, clicks, waits, completeManualStep } =
			bandcampDownload(skipVisible);
		const attention: boolean[] = [];
		const progress: ProgressCallback = (_stage, _message, _percent, extra) => {
			if (extra?.currentGate !== 'bc' || extra.requiresAttention === undefined)
				return;
			attention.push(extra.requiresAttention);
			if (extra.requiresAttention) {
				expect(clicks).toEqual(['#downloadProcess']);
				completeManualStep();
			}
		};
		downloader.setProgressCallback(progress);
		try {
			expect(await downloader.downloadAudio(gateUrl)).toBe(
				'OnlyWithYou - Come On.mp3',
			);
			expect(attention).toEqual([true, false]);
			expect(waits).toContainEqual({
				selector: '#step_bc',
				hidden: true,
				timeout: 120_000,
			});
			expect(clicks).toEqual(['#downloadProcess', '#gateDownloadButton']);
		} finally {
			await downloader.close();
		}
	});
}

test('an unfinished mandatory Bandcamp step fails with an actionable message', async () => {
	const { downloader, clicks } = bandcampDownload(null, true);
	try {
		await expect(downloader.downloadAudio(gateUrl)).rejects.toThrow(
			'Complete the Bandcamp step in the remote browser',
		);
		expect(clicks).toEqual(['#downloadProcess']);
	} finally {
		await downloader.close();
	}
});

test('a mandatory Instagram step requests interaction instead of failing on a missing popup', async () => {
	const { downloader, clicks, completeManualStep } = bandcampDownload(
		null,
		false,
		'ig',
	);
	const attention: boolean[] = [];
	downloader.setProgressCallback((_stage, _message, _percent, extra) => {
		if (extra?.currentGate !== 'ig' || extra.requiresAttention === undefined)
			return;
		attention.push(extra.requiresAttention);
		if (extra.requiresAttention) completeManualStep();
	});
	try {
		expect(await downloader.downloadAudio(gateUrl)).toBe(
			'OnlyWithYou - Come On.mp3',
		);
		expect(attention).toEqual([true, false]);
		expect(clicks).toEqual(['#downloadProcess', '#gateDownloadButton']);
	} finally {
		await downloader.close();
	}
});
