import { expect, spyOn, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { BandcampGateDownloader, pickBandcampGateTrack } from './bandcampGate';
import { DirectDownloader } from './directDownload';
import { PumpyoursoundDownloader } from './pumpyoursound';
import { BandcampAlbumMatchError, YtDlpDownloader } from './ytdlp';

const albumUrl = 'https://linapary.bandcamp.com/album/latina';
const tracks = [
	{ title: 'LATINA (perreo)', title_link: '/track/latina-perreo' },
	{ title: 'LATINA (guaracha)', title_link: '/track/latina-guaracha' },
];

test('Bandcamp album selection retains the requested recording version', () => {
	expect(
		pickBandcampGateTrack(
			albumUrl,
			tracks,
			'Linapary, Don Amor - LATINA (Guaracha) - FREE DONWLOAD',
		),
	).toBe('https://linapary.bandcamp.com/track/latina-guaracha');
	expect(() => pickBandcampGateTrack(albumUrl, tracks, 'LATINA')).toThrow(
		BandcampAlbumMatchError,
	);
	expect(() => pickBandcampGateTrack(albumUrl, tracks)).toThrow(
		BandcampAlbumMatchError,
	);
});

test('a paid Bandcamp destination only uses a stream when original-only is disabled', async () => {
	const visited: string[] = [];
	const page = {
		goto: async (url: string) => {
			visited.push(url);
		},
		waitForFunction: async () => {},
		evaluate: async () => ({ current: { minimum_price: 1.5 } }),
	};
	const stream = spyOn(
		YtDlpDownloader.prototype,
		'downloadAudio',
	).mockResolvedValue('el-chamber.mp3');
	const direct = spyOn(DirectDownloader.prototype, 'downloadAudio');
	const downloader = new BandcampGateDownloader(page as unknown as Page);
	const url = 'https://2at2at.bandcamp.com/track/el-chamber-2';
	try {
		await expect(
			downloader.downloadAudio(url, { originalOnly: true }),
		).rejects.toThrow('Bandcamp requires a purchase for the original');
		expect(stream).not.toHaveBeenCalled();
		expect(await downloader.downloadAudio(url)).toEqual({
			filename: 'el-chamber.mp3',
			method: 'bandcamp-stream',
		});
		expect(stream).toHaveBeenCalledWith(url);
		expect(direct).not.toHaveBeenCalled();
		expect(visited).toEqual([url, url]);
	} finally {
		stream.mockRestore();
		direct.mockRestore();
		await downloader.close();
	}
});

test('free Bandcamp destination selects the matching track and MP3 after manual form completion', async () => {
	const visited: string[] = [];
	const clicks: string[] = [];
	const attention: boolean[] = [];
	let reads = 0;
	let waitedForForm = false;
	let selectedMp3 = false;
	const page = {
		goto: async (url: string) => {
			visited.push(url);
		},
		evaluate: async () => {
			reads++;
			if (reads === 1)
				return { current: { minimum_price: 0 }, trackinfo: tracks };
			if (reads === 2) return { current: { minimum_price: 0 } };
			return true;
		},
		waitForSelector: async () => {},
		click: async (selector: string) => {
			clicks.push(selector);
		},
		bringToFront: async () => {},
		waitForFunction: async (fn: () => unknown) => {
			const source = fn.toString();
			if (source.includes('location.pathname')) waitedForForm = true;
			if (source.includes('mp3-320')) {
				expect(waitedForForm).toBe(true);
				selectedMp3 = true;
			}
			return { jsonValue: async () => 'https://t4.bcbits.com/download/test' };
		},
	};
	const direct = spyOn(
		DirectDownloader.prototype,
		'downloadAudio',
	).mockImplementation(async () => {
		expect(selectedMp3).toBe(true);
		return 'LATINA (guaracha).mp3';
	});
	const stream = spyOn(YtDlpDownloader.prototype, 'downloadAudio');
	const downloader = new BandcampGateDownloader(
		page as unknown as Page,
		(_stage, _message, _percent, extra) => {
			if (extra?.requiresAttention !== undefined)
				attention.push(extra.requiresAttention);
		},
	);
	try {
		expect(
			await downloader.downloadAudio(albumUrl, {
				matchTitle: 'LATINA (Guaracha)',
				originalOnly: true,
			}),
		).toEqual({
			filename: 'LATINA (guaracha).mp3',
			method: 'gate',
		});
		expect(visited).toEqual([
			albumUrl,
			'https://linapary.bandcamp.com/track/latina-guaracha',
		]);
		expect(clicks).toEqual(['.download-panel-free-download-link']);
		expect(attention).toEqual([true, false]);
		expect(stream).not.toHaveBeenCalled();
	} finally {
		direct.mockRestore();
		stream.mockRestore();
		await downloader.close();
	}
});

test('PumpYourSound routes a Bandcamp destination instead of fetching its HTML as audio', async () => {
	const downloader = new PumpyoursoundDownloader({
		comment: '',
		browserMode: 'headless',
	});
	const page = {
		setViewport: async () => {},
		goto: async () => {},
		waitForNetworkIdle: async () => {},
		close: async () => {},
	};
	Object.assign(downloader, {
		browser: { newPage: async () => page },
		browserLaunch: { close: async () => {} },
		dismissOverlays: async () => {},
		completeGateSteps: async () => {},
		submitAndReadDownloadLink: async () => albumUrl,
	});
	const bandcamp = spyOn(
		BandcampGateDownloader.prototype,
		'downloadAudio',
	).mockResolvedValue({ filename: 'latina.mp3', method: 'gate' });
	const direct = spyOn(DirectDownloader.prototype, 'downloadAudio');
	try {
		expect(
			await downloader.downloadAudio(
				'https://pumpyoursound.com/f/pys/latina-ep/200904',
				{ matchTitle: 'LATINA (Guaracha)', originalOnly: true },
			),
		).toBe('latina.mp3');
		expect(bandcamp).toHaveBeenCalledWith(albumUrl, {
			matchTitle: 'LATINA (Guaracha)',
			originalOnly: true,
		});
		expect(direct).not.toHaveBeenCalled();
		expect(downloader.downloadMethod).toBe('gate');
		bandcamp.mockResolvedValue({
			filename: 'latina-stream.mp3',
			method: 'bandcamp-stream',
		});
		await downloader.downloadAudio(
			'https://pumpyoursound.com/f/pys/latina-ep/200904',
		);
		expect(downloader.downloadMethod).toBe('bandcamp-stream');
	} finally {
		bandcamp.mockRestore();
		direct.mockRestore();
		await downloader.close();
	}
});

for (const validChoice of [true, false]) {
	test(`ambiguous gate albums ${validChoice ? 'use the normal track chooser' : 'reject choices outside the offered album'}`, async () => {
		const visited: string[] = [];
		const page = {
			goto: async (url: string) => {
				visited.push(url);
			},
			waitForFunction: async () => {},
			evaluate: async () => ({
				current: { minimum_price: 1.5 },
				trackinfo: tracks,
			}),
		};
		const stream = spyOn(
			YtDlpDownloader.prototype,
			'downloadAudio',
		).mockResolvedValue('chosen.mp3');
		const downloader = new BandcampGateDownloader(page as unknown as Page);
		const chosen = 'https://linapary.bandcamp.com/track/latina-guaracha';
		let prompts = 0;
		try {
			const download = downloader.downloadAudio(albumUrl, {
				matchTitle: 'LATINA',
				onAlbumMatchFailed: async (error) => {
					prompts++;
					expect(error.tracks.map((track) => track.url)).toContain(chosen);
					return validChoice
						? chosen
						: 'https://unrelated.bandcamp.com/track/other';
				},
			});
			if (validChoice) {
				expect(await download).toEqual({
					filename: 'chosen.mp3',
					method: 'bandcamp-stream',
				});
				expect(visited).toEqual([albumUrl, chosen]);
				expect(stream).toHaveBeenCalledWith(chosen);
			} else {
				await expect(download).rejects.toThrow(
					'Choose a track from the offered Bandcamp album',
				);
				expect(visited).toEqual([albumUrl]);
				expect(stream).not.toHaveBeenCalled();
			}
			expect(prompts).toBe(1);
		} finally {
			stream.mockRestore();
			await downloader.close();
		}
	});
}
