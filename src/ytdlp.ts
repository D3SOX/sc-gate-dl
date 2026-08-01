import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import { lookpath } from 'find-bin';
import type { BandcampAlbumTrackChoice, JobProgress } from './types';
import {
	isBandcampAlbumUrl,
	isSoundcloudUrl,
	writeSoundcloudNetscapeCookies,
} from './utils';

type ProgressCallback = (
	stage: JobProgress['stage'],
	message: string,
	percent: number,
	extra?: Partial<JobProgress>,
) => void;

export type YtDlpDownloadOptions = {
	/** Prefer this title when the URL is a Bandcamp album (or multi-entry). */
	matchTitle?: string;
	/**
	 * Called when auto title-match fails (or no title was given).
	 * Return a track URL from `error.tracks` to continue; throw/reject to abort.
	 */
	onAlbumMatchFailed?: (error: BandcampAlbumMatchError) => Promise<string>;
};

const DOWNLOADS_DIR = './downloads';
const YTDLP_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const YTDLP_METADATA_TIMEOUT_MS = 60_000;
const ALBUM_MATCH_THRESHOLD = 0.5;

type FlatEntry = {
	id?: string;
	title?: string;
	url?: string;
	webpage_url?: string;
};

/** Thrown when a Bandcamp album cannot be auto-matched to a single track. */
export class BandcampAlbumMatchError extends Error {
	readonly albumUrl: string;
	readonly matchTitle: string | undefined;
	readonly tracks: BandcampAlbumTrackChoice[];

	constructor(
		message: string,
		albumUrl: string,
		matchTitle: string | undefined,
		tracks: BandcampAlbumTrackChoice[],
	) {
		super(message);
		this.name = 'BandcampAlbumMatchError';
		this.albumUrl = albumUrl;
		this.matchTitle = matchTitle;
		this.tracks = tracks;
	}
}

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
 * SoundCloud: when `soundcloud-cookies.json` is present, cookies are passed to
 * yt-dlp so downloadable tracks can fetch the original upload (not just 128k).
 *
 * Bandcamp album URLs: when `matchTitle` is set, resolves the best-matching
 * track on the album and downloads only that entry (avoids grabbing the whole
 * album and offering the wrong file). If matching fails, `onAlbumMatchFailed`
 * (when provided) can pick a track; otherwise a `BandcampAlbumMatchError` is thrown.
 */
export class YtDlpDownloader {
	private progressCallback: ProgressCallback | null = null;
	private sourceLabel: string;
	private activeProcess: ReturnType<typeof execa> | null = null;
	private closed = false;

	constructor(sourceLabel = 'yt-dlp') {
		this.sourceLabel = sourceLabel;
	}

	setProgressCallback(callback: ProgressCallback) {
		this.progressCallback = callback;
	}

	async close(): Promise<void> {
		this.closed = true;
		const running = this.activeProcess;
		this.activeProcess = null;
		running?.kill('SIGTERM');
	}

	private async runYtDlp(
		ytDlpBin: string,
		args: string[],
		timeout: number,
	): Promise<string> {
		if (this.closed) {
			throw new Error('yt-dlp downloader is closed');
		}
		const subprocess = execa(ytDlpBin, args, {
			timeout,
			killSignal: 'SIGTERM',
		});
		this.activeProcess = subprocess;
		try {
			const { stdout } = await subprocess;
			return stdout;
		} finally {
			if (this.activeProcess === subprocess) {
				this.activeProcess = null;
			}
		}
	}

	async downloadAudio(
		url: string,
		options: YtDlpDownloadOptions = {},
	): Promise<string> {
		const ytDlpBin = await getYtDlpBin();
		let downloadUrl = url;

		if (isBandcampAlbumUrl(url)) {
			downloadUrl = await this.resolveBandcampAlbumTrack(
				ytDlpBin,
				url,
				options.matchTitle,
				options.onAlbumMatchFailed,
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
		const soundcloud = isSoundcloudUrl(downloadUrl);
		// Prefer SoundCloud's original upload (`download`) when the track allows it.
		// That format is only listed for registered users — pass cookies when available.
		const format = soundcloud ? 'download/bestaudio/best' : 'bestaudio/best';
		const args = [
			'--no-mtime',
			'--no-playlist',
			'-f',
			format,
			'-o',
			outputTemplate,
			'--print',
			'after_move:filepath',
			'--no-warnings',
		];

		let cookiesPath: string | null = null;
		if (soundcloud) {
			cookiesPath = await writeSoundcloudNetscapeCookies();
			if (cookiesPath) {
				args.push('--cookies', cookiesPath);
				console.log(
					`${this.sourceLabel}: using soundcloud-cookies.json for yt-dlp (original download if available)`,
				);
			} else {
				console.warn(
					`${this.sourceLabel}: no soundcloud-cookies.json — original SoundCloud downloads may be unavailable`,
				);
			}
		}

		args.push(downloadUrl);

		let stdout: string;
		try {
			stdout = await this.runYtDlp(ytDlpBin, args, YTDLP_DOWNLOAD_TIMEOUT_MS);
		} finally {
			if (cookiesPath) await rm(cookiesPath, { force: true });
		}

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
		matchTitle: string | undefined,
		onAlbumMatchFailed?: (error: BandcampAlbumMatchError) => Promise<string>,
	): Promise<string> {
		const matchingLabel = matchTitle
			? `Matching “${matchTitle}” on Bandcamp album...`
			: 'Listing Bandcamp album tracks...';
		this.progressCallback?.('downloading', matchingLabel, 45, {
			browserless: true,
		});
		console.log(
			matchTitle
				? `${this.sourceLabel}: album URL — matching track “${matchTitle}”…`
				: `${this.sourceLabel}: album URL — no title to match; listing tracks…`,
		);

		const stdout = await this.runYtDlp(
			ytDlpBin,
			['--flat-playlist', '-J', '--no-warnings', albumUrl],
			YTDLP_METADATA_TIMEOUT_MS,
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

		const tracks: BandcampAlbumTrackChoice[] = entries
			.map((entry) => {
				const url = entry.url || entry.webpage_url;
				if (!url) return null;
				return {
					title: entry.title,
					url,
					score: matchTitle ? titleMatchScore(entry.title, matchTitle) : 0,
				};
			})
			.filter((t): t is BandcampAlbumTrackChoice => t !== null)
			.sort((a, b) => b.score - a.score);

		if (tracks.length === 0) {
			throw new Error(
				`Bandcamp album listed tracks but yt-dlp did not provide track URLs: ${albumUrl}`,
			);
		}

		const best = matchTitle ? tracks[0] : undefined;
		if (best && best.score >= ALBUM_MATCH_THRESHOLD) {
			console.log(
				`${this.sourceLabel}: matched “${best.title}” (score ${best.score.toFixed(2)}) → ${best.url}`,
			);
			return best.url;
		}

		const available = tracks.map((t) => t.title).join(', ');
		const message = matchTitle
			? `Could not match SoundCloud title “${matchTitle}” to a track on the Bandcamp album. Available: ${available}`
			: `Bandcamp album URL needs a track pick (no SoundCloud title to match). Available: ${available}`;

		const matchError = new BandcampAlbumMatchError(
			message,
			albumUrl,
			matchTitle,
			tracks,
		);

		if (onAlbumMatchFailed) {
			const selectedUrl = await onAlbumMatchFailed(matchError);
			if (!selectedUrl) {
				throw new Error('No Bandcamp album track selected');
			}
			const picked = tracks.find((t) => t.url === selectedUrl);
			console.log(
				picked
					? `${this.sourceLabel}: user selected “${picked.title}” → ${selectedUrl}`
					: `${this.sourceLabel}: user selected track URL → ${selectedUrl}`,
			);
			return selectedUrl;
		}

		throw matchError;
	}
}

/** @deprecated Prefer YtDlpDownloader */
export class BandcampDownloader extends YtDlpDownloader {
	constructor() {
		super('Bandcamp');
	}
}
