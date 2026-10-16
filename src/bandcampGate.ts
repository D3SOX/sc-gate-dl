import type { Page } from 'puppeteer';
import { DirectDownloader } from './directDownload';
import type { ProgressCallback } from './hypeddit';
import type { BandcampAlbumTrackChoice } from './types';
import { isBandcampAlbumUrl, isBandcampUrl } from './utils';
import {
	BandcampAlbumMatchError,
	YtDlpDownloader,
	type YtDlpDownloadOptions,
} from './ytdlp';

export type BandcampGateOptions = Pick<
	YtDlpDownloadOptions,
	'matchTitle' | 'onAlbumMatchFailed'
> & { originalOnly?: boolean };

type BandcampTrack = { title: string; title_link: string };
type BandcampData = {
	current?: { minimum_price?: number };
	trackinfo?: BandcampTrack[];
};

/** Keep version names: LATINA (perreo) and LATINA (guaracha) are different tracks. */
function normalizedTitle(title: string): string {
	return title
		.normalize('NFKD')
		.toLowerCase()
		.replace(/\bfree\s+(?:download|donwload)\b/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

export function pickBandcampGateTrack(
	albumUrl: string,
	tracks: BandcampTrack[],
	matchTitle?: string,
): string {
	const wanted = normalizedTitle(matchTitle ?? '');
	const choices: BandcampAlbumTrackChoice[] = tracks
		.map((track) => {
			const title = normalizedTitle(track.title);
			const url = new URL(track.title_link, albumUrl).toString();
			return {
				title: track.title,
				url,
				score:
					wanted &&
					title &&
					(wanted === title || wanted.includes(title) || title.includes(wanted))
						? 1
						: 0,
			};
		})
		.filter((track) => isBandcampUrl(track.url));
	const matches = choices.filter((track) => track.score === 1);
	if (matches.length === 1 && matches[0]) return matches[0].url;
	throw new BandcampAlbumMatchError(
		'Choose the matching Bandcamp album track; the destination is ambiguous.',
		albumUrl,
		matchTitle,
		choices,
	);
}

/** Handle the store page offered after a completed gate, rather than fetching it as audio. */
export class BandcampGateDownloader {
	private readonly direct = new DirectDownloader();
	private readonly stream = new YtDlpDownloader('Bandcamp');
	private closed = false;

	constructor(
		private readonly page: Page,
		private readonly progress?: ProgressCallback,
	) {
		this.direct.setProgressCallback((stage, message, percent, extra) =>
			this.progress?.(stage, message, percent, {
				...extra,
				browserless: false,
			}),
		);
		this.stream.setProgressCallback((stage, message, percent, extra) =>
			this.progress?.(stage, message, percent, {
				...extra,
				browserless: false,
			}),
		);
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([this.direct.close(), this.stream.close()]);
	}

	async downloadAudio(
		url: string,
		options: BandcampGateOptions = {},
	): Promise<{ filename: string; method: 'gate' | 'bandcamp-stream' }> {
		if (this.closed) throw new Error('Download cancelled');
		if (!isBandcampUrl(url))
			throw new Error('Unsupported Bandcamp destination.');
		await this.page.goto(url, { waitUntil: 'domcontentloaded' });
		let data = await this.readData();
		if (isBandcampAlbumUrl(url)) {
			try {
				url = pickBandcampGateTrack(
					url,
					data.trackinfo ?? [],
					options.matchTitle,
				);
			} catch (error) {
				if (
					!(error instanceof BandcampAlbumMatchError) ||
					!options.onAlbumMatchFailed
				)
					throw error;
				const selected = await options.onAlbumMatchFailed(error);
				if (this.closed) throw new Error('Download cancelled');
				if (!error.tracks.some((track) => track.url === selected))
					throw new Error('Choose a track from the offered Bandcamp album.');
				url = selected;
			}
			await this.page.goto(url, { waitUntil: 'domcontentloaded' });
			data = await this.readData();
		}
		if (typeof data.current?.minimum_price !== 'number')
			throw new Error(
				'Bandcamp download availability could not be determined.',
			);
		if (data.current.minimum_price > 0) {
			if (options.originalOnly)
				throw new Error(
					'Bandcamp requires a purchase for the original. Use a regular download to accept the available lower-quality stream.',
				);
			return {
				filename: await this.stream.downloadAudio(url),
				method: 'bandcamp-stream',
			};
		}

		const buy = await this.page.evaluate(() => {
			const button = Array.from(
				document.querySelectorAll<HTMLButtonElement>('.buyItem button'),
			).find(
				(button) =>
					button.checkVisibility() &&
					/^buy digital track$/i.test(button.textContent?.trim() ?? ''),
			);
			button?.click();
			return !!button;
		});
		if (!buy)
			throw new Error('Bandcamp free track download button was not found.');
		await this.page.waitForSelector('#userPrice', { visible: true });
		await this.page.evaluate(() => {
			const price = document.querySelector<HTMLInputElement>('#userPrice');
			if (!price?.checkVisibility())
				throw new Error('Bandcamp price input missing.');
			price.value = '0';
			price.dispatchEvent(new Event('input', { bubbles: true }));
			price.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await this.page.waitForSelector('.download-panel-free-download-link', {
			visible: true,
		});
		await this.page.click('.download-panel-free-download-link');

		await this.page.bringToFront();
		this.progress?.(
			'handling_gates',
			'Complete Bandcamp’s free download form in the remote browser, then continue to the download page. MP3 320 will be selected.',
			80,
			{ currentGate: 'bandcamp', browserActive: true, requiresAttention: true },
		);
		await this.page.waitForFunction(
			() => location.pathname.startsWith('/download'),
			{ timeout: 180_000 },
		);
		if (this.closed) throw new Error('Download cancelled');
		this.progress?.('handling_gates', 'Selecting Bandcamp MP3 320...', 82, {
			currentGate: 'bandcamp',
			browserActive: true,
			requiresAttention: false,
		});
		await this.page.waitForFunction(() => {
			for (const select of document.querySelectorAll('select')) {
				if (!select.checkVisibility()) continue;
				const mp3 = Array.from(select.options).find(
					(option) =>
						option.value === 'mp3-320' || /mp3\s*320/i.test(option.text),
				);
				if (!mp3) continue;
				if (select.value !== mp3.value) {
					select.value = mp3.value;
					select.dispatchEvent(new Event('change', { bubbles: true }));
				}
				return true;
			}
			return false;
		});
		const ready = await this.page.waitForFunction(
			() => {
				for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
					'a[href]',
				)) {
					if (
						!anchor.checkVisibility() ||
						!/^download$/i.test(anchor.textContent?.trim() ?? '')
					)
						continue;
					const link = new URL(anchor.href);
					if (
						link.protocol === 'https:' &&
						/(?:^|\.)bcbits\.com$/.test(link.hostname) &&
						(/\/mp3-320(?:\/|$)/.test(link.pathname) ||
							link.searchParams.get('enc') === 'mp3-320')
					)
						return link.toString();
				}
				return false;
			},
			{ timeout: 60_000 },
		);
		const fileUrl = await ready.jsonValue();
		if (typeof fileUrl !== 'string')
			throw new Error('Bandcamp MP3 download link missing.');
		return {
			filename: await this.direct.downloadAudio(fileUrl),
			method: 'gate',
		};
	}

	private async readData(): Promise<BandcampData> {
		await this.page.waitForFunction(() =>
			Boolean((window as Window & { TralbumData?: unknown }).TralbumData),
		);
		return this.page.evaluate(() => {
			const data = (window as Window & { TralbumData?: BandcampData })
				.TralbumData;
			return {
				current: { minimum_price: data?.current?.minimum_price },
				trackinfo: data?.trackinfo?.map(({ title, title_link }) => ({
					title,
					title_link,
				})),
			};
		});
	}
}
