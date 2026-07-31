import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ProgressCallback } from './hypeddit';
import { trimExtractedUrl } from './utils';

const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const AUDIO_OR_ARCHIVE_EXT_RE =
	/\.(mp3|wav|flac|aiff|aif|m4a|aac|ogg|opus|zip|rar)(\?|$)/i;

/**
 * True for http(s) URLs that look like a direct file download (Dropbox, Drive,
 * or a path with a common audio/archive extension) — not HTML gate pages.
 */
export function isDirectDownloadUrl(value: string): boolean {
	try {
		const url = new URL(trimExtractedUrl(value.trim()));
		if (!/^https?:$/i.test(url.protocol)) return false;

		const host = url.hostname.toLowerCase();
		if (/(?:^|\.)dropbox\.com$/i.test(host)) return true;
		if (/(?:^|\.)dropboxusercontent\.com$/i.test(host)) return true;
		if (/(?:^|\.)drive\.google\.com$/i.test(host)) return true;
		if (/(?:^|\.)docs\.google\.com$/i.test(host)) return true;

		if (AUDIO_OR_ARCHIVE_EXT_RE.test(url.pathname)) return true;
		if (url.searchParams.get('dl') === '1') return true;
		if (url.searchParams.has('raw')) return true;

		return false;
	} catch {
		return false;
	}
}

/** Normalize share links so fetch gets the file bytes (e.g. Dropbox dl=1). */
export function normalizeDirectDownloadUrl(url: string): string {
	const trimmed = trimExtractedUrl(url.trim());
	try {
		const parsed = new URL(trimmed);
		if (/(?:^|\.)dropbox\.com$/i.test(parsed.hostname)) {
			parsed.searchParams.set('dl', '1');
			return parsed.toString();
		}
		// Google Drive file view → uc?export=download
		const driveFile = parsed.pathname.match(/\/file\/d\/([^/]+)/);
		if (
			/(?:^|\.)drive\.google\.com$/i.test(parsed.hostname) &&
			driveFile?.[1]
		) {
			return `https://drive.google.com/uc?export=download&id=${driveFile[1]}`;
		}
		return parsed.toString();
	} catch {
		return trimmed;
	}
}

function filenameFromContentDisposition(value: string | null): string | null {
	if (!value) return null;
	const star = value.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
	if (star) {
		return decodeURIComponent(star.replace(/["']/g, ''));
	}
	const plain = value.match(/filename=["']?([^"';]+)["']?/i)?.[1];
	return plain ? plain.trim() : null;
}

export class DirectDownloader {
	private progressCallback: ProgressCallback | null = null;

	setProgressCallback(callback: ProgressCallback): void {
		this.progressCallback = callback;
	}

	async downloadAudio(url: string): Promise<string> {
		const downloadUrl = normalizeDirectDownloadUrl(url);
		console.log(`Downloading direct file: ${downloadUrl}`);
		this.progressCallback?.('downloading', 'Downloading direct file...', 40, {
			browserless: true,
		});

		await mkdir('./downloads', { recursive: true });
		const response = await fetch(downloadUrl, {
			redirect: 'follow',
			headers: {
				'user-agent': USER_AGENT,
				accept: '*/*',
			},
		});
		if (!response.ok) {
			throw new Error(
				`Direct download failed: HTTP ${response.status} for ${downloadUrl}`,
			);
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (/text\/html/i.test(contentType)) {
			throw new Error(
				'Direct download returned HTML instead of a file — check that the link is a direct download (e.g. Dropbox with dl=1).',
			);
		}

		const fromHeader = filenameFromContentDisposition(
			response.headers.get('content-disposition'),
		);
		const urlName = basename(new URL(response.url).pathname);
		const filename =
			fromHeader ||
			(urlName && urlName !== '/'
				? decodeURIComponent(urlName)
				: `direct-download-${Date.now()}.bin`);

		const target = join('./downloads', filename);
		await Bun.write(target, await response.arrayBuffer());
		console.log(`Saved ${filename}`);
		return filename;
	}

	async close(): Promise<void> {
		// no-op (browserless)
	}
}
