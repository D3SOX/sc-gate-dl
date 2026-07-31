import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookpath } from 'find-bin';
import type { CookieData } from 'puppeteer';
import type { SoundcloudTrack } from 'soundcloud.ts';
import packageJson from '../package.json' with { type: 'json' };
import type { LocalCookieData, Metadata } from './types';

export const REPO_URL = packageJson.repository.url;

export async function getFfmpegBin() {
	const ffmpegBin = await lookpath('ffmpeg');
	if (!ffmpegBin) {
		throw new Error(
			'ffmpeg is not installed. Please make sure it is in your PATH.',
		);
	}
	return ffmpegBin;
}

export async function getFfprobeBin() {
	const ffprobeBin = await lookpath('ffprobe');
	if (!ffprobeBin) {
		throw new Error(
			'ffprobe is not installed. Please make sure it is in your PATH.',
		);
	}
	return ffprobeBin;
}

export async function timeout(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull a DataDome / captcha-delivery challenge URL out of an API error body. */
export function extractCaptchaDeliveryUrl(body: string): string | undefined {
	try {
		const json = JSON.parse(body) as { url?: unknown };
		if (
			typeof json.url === 'string' &&
			/captcha-delivery\.com/i.test(json.url)
		) {
			return json.url;
		}
	} catch {
		// not JSON
	}
	const match = body.match(
		/https?:\/\/geo\.captcha-delivery\.com\/captcha\/[^"\\\s]+/i,
	);
	return match?.[0]?.replace(/\\u0026/g, '&');
}

/**
 * Parse DataDome `/captcha/check` JSON: `{ "cookie": "datadome=...; Domain=.soundcloud.com; ..." }`
 */
export function parseDatadomeCheckCookie(body: string): {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
} | null {
	try {
		const json = JSON.parse(body) as { cookie?: unknown };
		if (typeof json.cookie !== 'string' || !json.cookie.includes('datadome=')) {
			return null;
		}
		const parts = json.cookie.split(';').map((p) => p.trim());
		const nameValue = parts[0];
		if (!nameValue) return null;
		const eq = nameValue.indexOf('=');
		if (eq < 0) return null;
		const name = nameValue.slice(0, eq);
		const value = nameValue.slice(eq + 1);
		let domain = '.soundcloud.com';
		let path = '/';
		let secure = true;
		for (const attr of parts.slice(1)) {
			const sep = attr.indexOf('=');
			const k = (sep >= 0 ? attr.slice(0, sep) : attr).trim();
			const v = sep >= 0 ? attr.slice(sep + 1).trim() : '';
			if (/^domain$/i.test(k) && v) domain = v;
			if (/^path$/i.test(k) && v) path = v;
			if (/^secure$/i.test(k)) secure = true;
		}
		return { name, value, domain, path, secure };
	} catch {
		return null;
	}
}

export async function loadCookies(filename: string): Promise<CookieData[]> {
	const cookiesData: LocalCookieData[] = JSON.parse(
		await Bun.file(filename).text(),
	);
	return cookiesData.map((cookie) => {
		const puppeteerCookie: CookieData = {
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path || '/',
		};

		if (cookie.expirationDate) {
			puppeteerCookie.expires = cookie.expirationDate;
		}
		if (cookie.httpOnly !== undefined) {
			puppeteerCookie.httpOnly = cookie.httpOnly;
		}
		if (cookie.secure !== undefined) {
			puppeteerCookie.secure = cookie.secure;
		}
		if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
			puppeteerCookie.sameSite = cookie.sameSite as 'Strict' | 'Lax' | 'None';
		}

		return puppeteerCookie;
	});
}

/**
 * Convert EditThisCookie-style JSON cookies to Netscape/Mozilla cookie file
 * text (required by yt-dlp `--cookies`).
 */
export function cookiesToNetscape(cookies: LocalCookieData[]): string {
	const lines = ['# Netscape HTTP Cookie File'];
	for (const cookie of cookies) {
		const domain = cookie.domain || '';
		const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
		const path = cookie.path || '/';
		const secure = cookie.secure ? 'TRUE' : 'FALSE';
		const expires = Math.floor(cookie.expirationDate ?? 0);
		lines.push(
			[
				domain,
				includeSubdomains,
				path,
				secure,
				String(expires),
				cookie.name,
				cookie.value,
			].join('\t'),
		);
	}
	return `${lines.join('\n')}\n`;
}

/** Write `soundcloud-cookies.json` as a Netscape cookie file for yt-dlp. */
export async function writeSoundcloudNetscapeCookies(
	jsonPath = 'soundcloud-cookies.json',
	outPath?: string,
): Promise<string | null> {
	const file = Bun.file(jsonPath);
	if (!(await file.exists())) {
		return null;
	}
	let cookies: LocalCookieData[];
	try {
		const parsed: unknown = JSON.parse(await file.text());
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return null;
		}
		cookies = parsed as LocalCookieData[];
	} catch {
		return null;
	}
	const dest =
		outPath ??
		join(
			tmpdir(),
			`sc-gate-dl-cookies-${process.pid}-${crypto.randomUUID()}.txt`,
		);
	await Bun.write(dest, cookiesToNetscape(cookies), { mode: 0o600 });
	return dest;
}

export function isSoundcloudUrl(value: string): boolean {
	return value?.startsWith('https://soundcloud.com/') ?? false;
}

export function validateSoundcloudUrl(value: string): true | string {
	if (!isSoundcloudUrl(value)) {
		return 'A valid SoundCloud URL is required';
	}
	return true;
}

export type GateProvider =
	| 'hypeddit'
	| 'droploud'
	| 'gaterush'
	| 'downloadgater'
	| 'bandcamp'
	/** Direct track download via yt-dlp (manual fallback, not auto-extracted). */
	| 'soundcloud';

export type GateUrlMatch = {
	url: string;
	provider: GateProvider;
	type: 'purchase_url' | 'description';
};

const HYPEDDIT_URL_RE = /https:\/\/hypeddit\.com\/[^\s]+/;
const DROPLOUD_URL_RE = /https:\/\/droploud\.com\/(?:gate|track)\/[0-9a-f-]+/i;
const GATERUSH_URL_RE = /https?:\/\/(?:www\.)?gaterush\.me\/[A-Za-z0-9_-]+/i;
const DOWNLOADGATER_URL_RE =
	/https?:\/\/(?:www\.)?downloadgater\.com\/g\/[A-Za-z0-9_-]+/i;
/** artist.bandcamp.com/track|album/... (and bare bandcamp.com). */
const BANDCAMP_URL_RE =
	/https?:\/\/(?:[\w-]+\.)?bandcamp\.com\/(?:track|album)\/[^\s?#]+/i;
const BANDCAMP_ALBUM_URL_RE =
	/https?:\/\/(?:[\w-]+\.)?bandcamp\.com\/album\/[^\s?#]+/i;
const SOUNDCLOUD_URL_RE = /https:\/\/soundcloud\.com\/[^\s?#]+/i;

/** Strip prose/Markdown delimiters glued to the end of a matched URL. */
function trimExtractedUrl(url: string): string {
	return url.replace(/[)\]}>.,;:!?'"…]+$/g, '');
}

export function isHypedditUrl(value: string): boolean {
	return value.startsWith('https://hypeddit.com/');
}

export function isDroploudUrl(value: string): boolean {
	return DROPLOUD_URL_RE.test(value);
}

export function isGaterushUrl(value: string): boolean {
	return GATERUSH_URL_RE.test(value);
}

export function isDownloadgaterUrl(value: string): boolean {
	return DOWNLOADGATER_URL_RE.test(value);
}

export function isBandcampUrl(value: string): boolean {
	return BANDCAMP_URL_RE.test(value);
}

export function isBandcampAlbumUrl(value: string): boolean {
	return BANDCAMP_ALBUM_URL_RE.test(value);
}

/**
 * Extract the canonical provider URL from a string (possibly with surrounding
 * text). Prefer traditional gates, then Bandcamp, then SoundCloud.
 */
export function resolveGateProviderUrl(
	value: string,
): { url: string; provider: GateProvider } | null {
	const traditional = matchTraditionalGateUrl(value);
	if (traditional) return traditional;

	const bandcamp = matchBandcampUrl(value);
	if (bandcamp) return bandcamp;

	const soundcloudMatch = value.match(SOUNDCLOUD_URL_RE)?.[0];
	if (soundcloudMatch) {
		return {
			url: trimExtractedUrl(soundcloudMatch),
			provider: 'soundcloud',
		};
	}
	return null;
}

export function getGateProvider(value: string): GateProvider | null {
	return resolveGateProviderUrl(value)?.provider ?? null;
}

export function validateHypedditUrl(value: string): true | string {
	if (!isHypedditUrl(value)) {
		return 'A valid Hypeddit URL is required';
	}
	return true;
}

export function validateGateUrl(value: string): true | string {
	if (!resolveGateProviderUrl(value)) {
		return 'A valid Hypeddit, Droploud, GateRush, DownloadGater, Bandcamp, or SoundCloud URL is required';
	}
	return true;
}

function normalizeGateUrl(
	url: string,
	provider: GateProvider,
): { url: string; provider: GateProvider } {
	if (
		provider === 'gaterush' ||
		provider === 'downloadgater' ||
		provider === 'bandcamp'
	) {
		return {
			url: url.replace(/^http:\/\//i, 'https://'),
			provider,
		};
	}
	return { url, provider };
}

/** Traditional unlock gates (browser / HTTP). Prefer these over Bandcamp. */
function matchTraditionalGateUrl(
	value: string,
): { url: string; provider: GateProvider } | null {
	const hypedditMatch = value.match(HYPEDDIT_URL_RE)?.[0];
	if (hypedditMatch) {
		return { url: trimExtractedUrl(hypedditMatch), provider: 'hypeddit' };
	}
	const droploudMatch = value.match(DROPLOUD_URL_RE)?.[0];
	if (droploudMatch) {
		return { url: trimExtractedUrl(droploudMatch), provider: 'droploud' };
	}
	const gaterushMatch = value.match(GATERUSH_URL_RE)?.[0];
	if (gaterushMatch) {
		return normalizeGateUrl(trimExtractedUrl(gaterushMatch), 'gaterush');
	}
	const downloadgaterMatch = value.match(DOWNLOADGATER_URL_RE)?.[0];
	if (downloadgaterMatch) {
		return normalizeGateUrl(
			trimExtractedUrl(downloadgaterMatch),
			'downloadgater',
		);
	}
	return null;
}

function matchBandcampUrl(
	value: string,
): { url: string; provider: GateProvider } | null {
	const bandcampMatch = value.match(BANDCAMP_URL_RE)?.[0];
	if (bandcampMatch) {
		return normalizeGateUrl(trimExtractedUrl(bandcampMatch), 'bandcamp');
	}
	return null;
}

/**
 * Prefer Hypeddit / Droploud / GateRush / DownloadGater from purchase_url or
 * description, then fall back to a Bandcamp purchase/description link.
 */
export function extractGateUrl(track: SoundcloudTrack): GateUrlMatch | null {
	const { purchase_url, description } = track;

	if (purchase_url) {
		const fromPurchase = matchTraditionalGateUrl(purchase_url);
		if (fromPurchase) {
			return { ...fromPurchase, type: 'purchase_url' };
		}
	}

	if (description) {
		const fromDescription = matchTraditionalGateUrl(description);
		if (fromDescription) {
			return { ...fromDescription, type: 'description' };
		}
	}

	if (purchase_url) {
		const bandcamp = matchBandcampUrl(purchase_url);
		if (bandcamp) {
			return { ...bandcamp, type: 'purchase_url' };
		}
	}

	if (description) {
		const bandcamp = matchBandcampUrl(description);
		if (bandcamp) {
			return { ...bandcamp, type: 'description' };
		}
	}

	return null;
}

/** @deprecated Prefer extractGateUrl */
export function extractHypedditUrl(
	track: SoundcloudTrack,
): { url: string; type: 'purchase_url' | 'description' } | null {
	const gate = extractGateUrl(track);
	if (gate?.provider !== 'hypeddit') {
		return null;
	}
	return { url: gate.url, type: gate.type };
}

export function getDefaultMetadata(track: SoundcloudTrack): Metadata {
	return {
		title: track.title,
		artist:
			track.publisher_metadata?.artist ||
			track.user.full_name ||
			track.user.username,
		album: track.publisher_metadata?.album_title || '',
		genre: track.genre,
	};
}

const LOSSLESS_EXTENSIONS = ['.wav', '.aiff', '.aif', '.flac'] as const;
/** Lossy containers we still re-encode to MP3 when output is mp3-320. */
const LOSSY_TO_MP3_EXTENSIONS = [
	'.m4a',
	'.aac',
	'.ogg',
	'.opus',
	'.webm',
] as const;

function hasExtension(
	filename: string,
	extensions: readonly string[],
): boolean {
	const lower = filename.toLowerCase();
	return extensions.some((ext) => lower.endsWith(ext));
}

export function isLosslessFormat(filename: string): boolean {
	return hasExtension(filename, LOSSLESS_EXTENSIONS);
}

export function isMp3Format(filename: string): boolean {
	return filename.toLowerCase().endsWith('.mp3');
}

/** True when the file must be re-encoded to MP3 for the mp3-320 output path. */
export function needsMp3Conversion(filename: string): boolean {
	return (
		isLosslessFormat(filename) ||
		hasExtension(filename, LOSSY_TO_MP3_EXTENSIONS)
	);
}

export function toMp3Filename(filename: string): string {
	return filename.replace(
		/\.(wav|aiff|aif|flac|m4a|aac|ogg|opus|webm)$/i,
		'.mp3',
	);
}

/** @deprecated Prefer toMp3Filename */
export function losslessToMp3Filename(filename: string): string {
	return toMp3Filename(filename);
}

/** Strip characters that are unsafe or awkward in filenames. */
export function sanitizeFilenamePart(value: string): string {
	return value
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** `Artist - Title` (+ extension) from metadata fields. */
export function artistTitleFilename(
	artist?: string,
	title?: string,
	extension = '.mp3',
): string {
	const safeArtist = sanitizeFilenamePart(artist || '') || 'Unknown Artist';
	const safeTitle = sanitizeFilenamePart(title || '') || 'Unknown Title';
	const ext = extension.startsWith('.') ? extension : `.${extension}`;
	return `${safeArtist} - ${safeTitle}${ext}`;
}

/** Predicted output name for the metadata step (always ends as MP3). */
export function previewProcessedFilename(
	downloadFilename: string,
	options: {
		nameAsArtistTitle: boolean;
		artist?: string;
		title?: string;
	},
): string {
	if (options.nameAsArtistTitle) {
		return artistTitleFilename(options.artist, options.title, '.mp3');
	}
	if (needsMp3Conversion(downloadFilename)) {
		return toMp3Filename(downloadFilename);
	}
	return downloadFilename;
}
