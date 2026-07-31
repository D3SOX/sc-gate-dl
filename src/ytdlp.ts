import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import { lookpath } from 'find-bin';
import type { JobProgress } from './types';
import { isBandcampAlbumUrl } from './utils';

type ProgressCallback = (
	stage: JobProgress['stage'],
	message: string,
	percent: number,
	extra?: Partial<JobProgress>,
) => void;

export type YtDlpDownloadOptions = {
	/** Prefer this title when the URL is a Bandcamp album (or multi-entry). */
	matchTitle?: string;
};

const DOWNLOADS_DIR = './downloads';
const YTDLP_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const YTDLP_METADATA_TIMEOUT_MS = 60_000;

type FlatEntry = {
	id?: string;
	title?: string;
	url?: string;
	webpage_url?: string;
};

export async function getYtDlpBin(): Promise<string> {
	const ytDlpBin = await lookpath('yt-dlp');
	if (!ytDlpBin) {
		throw new Error(
			'yt-dlp is not installed. Please make sure it is in your PATH (required for Bandcamp / SoundCloud downloads).',
		);
	}
	return ytDlpBin;
}

/** Strip (Clip)/(Preview)/brackets and normalize for fuzzy title compare. */
export function normalizeTrackTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/\(.*?\)/g, ' ')
		.replace(/\[.*?\]/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/** 0–1 score; exact normalized match → 1. */
export function titleMatchScore(candidate: string, wanted: string): number {
	const a = normalizeTrackTitle(candidate);
	const b = normalizeTrackTitle(wanted);
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.includes(b) || b.includes(a)) return 0.9;

	const tokensA = new Set(a.split(' '));
	const tokensB = new Set(b.split(' '));
	let inter = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) inter += 1;
	}
	const union = tokensA.size + tokensB.size - inter;
	return union === 0 ? 0 : inter / union;
}

/**
 * Downloads audio via yt-dlp into ./downloads (Bandcamp, SoundCloud, …).
 * Browserless — no gate browser / SoundCloud session automation.
 *
 * Bandcamp album URLs: when `matchTitle` is set, resolves the best-matching
 * track on the album and downloads only that entry (avoids grabbing the whole
 * album and offering the wrong file).
 */
export class YtDlpDownloader {
	private progressCallback: ProgressCallback | null = null;
	private sourceLabel: string;

	constructor(sourceLabel = 'yt-dlp') {
		this.sourceLabel = sourceLabel;
	}

	setProgressCallback(callback: ProgressCallback) {
		this.progressCallback = callback;
	}

	async downloadAudio(
		url: string,
		options: YtDlpDownloadOptions = {},
	): Promise<string> {
		const ytDlpBin = await getYtDlpBin();
		let downloadUrl = url;

		if (isBandcampAlbumUrl(url) && options.matchTitle) {
			downloadUrl = await this.resolveBandcampAlbumTrack(
				ytDlpBin,
				url,
				options.matchTitle,
			);
		} else if (isBandcampAlbumUrl(url) && !options.matchTitle) {
			throw new Error(
				'Bandcamp album URL needs a track title to pick the right song. Re-fetch the SoundCloud track and try again.',
			);
		}

		this.progressCallback?.(
			'downloading',
			`Downloading from ${this.sourceLabel} via yt-dlp...`,
			50,
			{ browserless: true },
		);
		console.log(`${this.sourceLabel}: downloading via yt-dlp → ${downloadUrl}`);

		await mkdir(DOWNLOADS_DIR, { recursive: true });

		const outputTemplate = join(DOWNLOADS_DIR, '%(title)s [%(id)s].%(ext)s');

		const { stdout } = await execa(
			ytDlpBin,
			[
				'--no-mtime',
				'--no-playlist',
				'-f',
				'bestaudio/best',
				'-o',
				outputTemplate,
				'--print',
				'after_move:filepath',
				'--no-warnings',
				downloadUrl,
			],
			{ timeout: YTDLP_DOWNLOAD_TIMEOUT_MS, killSignal: 'SIGTERM' },
		);

		const filepaths = stdout
			.trim()
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);

		if (filepaths.length === 0) {
			throw new Error('yt-dlp finished but did not report an output filepath');
		}

		const matchTitle = options.matchTitle;
		let filepath = filepaths[filepaths.length - 1] ?? '';
		if (filepaths.length > 1 && matchTitle) {
			const ranked = filepaths
				.map((path) => ({
					path,
					score: titleMatchScore(basename(path), matchTitle),
				}))
				.sort((a, b) => b.score - a.score);
			const bestPath = ranked[0]?.path;
			if (bestPath) {
				filepath = bestPath;
				console.log(
					`${this.sourceLabel}: yt-dlp wrote ${filepaths.length} files; picked ${basename(filepath)} (score ${ranked[0]?.score.toFixed(2)})`,
				);
			}
		} else if (filepaths.length > 1) {
			console.warn(
				`${this.sourceLabel}: yt-dlp wrote ${filepaths.length} files; using last: ${basename(filepath)}`,
			);
		}

		const filename = basename(filepath);
		const dest = join(DOWNLOADS_DIR, filename);
		if (!(await Bun.file(dest).exists())) {
			throw new Error(`yt-dlp reported ${filename} but file is missing`);
		}

		console.log(`${this.sourceLabel}: downloaded ${filename}`);
		this.progressCallback?.('downloading', 'Download complete', 85, {
			browserless: true,
		});
		return filename;
	}

	private async resolveBandcampAlbumTrack(
		ytDlpBin: string,
		albumUrl: string,
		matchTitle: string,
	): Promise<string> {
		this.progressCallback?.(
			'downloading',
			`Matching “${matchTitle}” on Bandcamp album...`,
			45,
			{ browserless: true },
		);
		console.log(
			`${this.sourceLabel}: album URL — matching track “${matchTitle}”…`,
		);

		const { stdout } = await execa(
			ytDlpBin,
			['--flat-playlist', '-J', '--no-warnings', albumUrl],
			{ timeout: YTDLP_METADATA_TIMEOUT_MS, killSignal: 'SIGTERM' },
		);

		const data = JSON.parse(stdout) as {
			_type?: string;
			entries?: FlatEntry[];
			title?: string;
		};
		const entries = (data.entries ?? []).filter(
			(e): e is FlatEntry & { title: string } => Boolean(e.title),
		);

		if (entries.length === 0) {
			throw new Error(`No tracks found on Bandcamp album: ${albumUrl}`);
		}

		const ranked = entries
			.map((entry) => ({
				entry,
				score: titleMatchScore(entry.title, matchTitle),
			}))
			.sort((a, b) => b.score - a.score);

		const best = ranked[0];
		if (!best || best.score < 0.5) {
			const available = entries.map((e) => e.title).join(', ');
			throw new Error(
				`Could not match SoundCloud title “${matchTitle}” to a track on the Bandcamp album. Available: ${available}`,
			);
		}

		const finalUrl = best.entry.url || best.entry.webpage_url;
		if (!finalUrl) {
			throw new Error(
				`Matched “${best.entry.title}” but yt-dlp did not provide a track URL`,
			);
		}

		console.log(
			`${this.sourceLabel}: matched “${best.entry.title}” (score ${best.score.toFixed(2)}) → ${finalUrl}`,
		);

		return finalUrl;
	}
}

/** @deprecated Prefer YtDlpDownloader */
export class BandcampDownloader extends YtDlpDownloader {
	constructor() {
		super('Bandcamp');
	}
}
