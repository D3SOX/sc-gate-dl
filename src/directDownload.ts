import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
	normalizeDirectDownloadParsedUrl,
	urlLooksLikeDirectDownload,
} from './directLinkRules';
import type { ProgressCallback } from './hypeddit';
import { assertSafeOutboundUrl } from './safeOutboundUrl';
import { sanitizeFilenamePart, trimExtractedUrl } from './utils';

const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 60_000;
/** Cap buffered downloads (audio / zip packages). */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/**
 * True for http(s) URLs that look like a direct file download (Dropbox, Drive,
 * or a path with a common audio/archive extension) — not HTML gate pages.
 */
export function isDirectDownloadUrl(value: string): boolean {
	try {
		return urlLooksLikeDirectDownload(new URL(trimExtractedUrl(value.trim())));
	} catch {
		return false;
	}
}

/** Normalize share links so fetch gets the file bytes (e.g. Dropbox dl=0 → dl=1). */
export function normalizeDirectDownloadUrl(url: string): string {
	const trimmed = trimExtractedUrl(url.trim());
	try {
		return normalizeDirectDownloadParsedUrl(new URL(trimmed));
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

function safeDownloadFilename(raw: string | null): string | null {
	if (!raw) return null;
	const base = basename(raw);
	const cleaned = sanitizeFilenamePart(base);
	return cleaned || null;
}

export class DirectDownloader {
	private progressCallback: ProgressCallback | null = null;

	setProgressCallback(callback: ProgressCallback): void {
		this.progressCallback = callback;
	}

	async downloadAudio(url: string): Promise<string> {
		const downloadUrl = normalizeDirectDownloadUrl(url);
		await assertSafeOutboundUrl(downloadUrl);
		console.log(`Downloading direct file: ${downloadUrl}`);
		this.progressCallback?.('downloading', 'Downloading direct file...', 40, {
			browserless: true,
		});

		await mkdir('./downloads', { recursive: true });
		const response = await fetch(downloadUrl, {
			redirect: 'follow',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

		await assertSafeOutboundUrl(response.url);

		const contentType = response.headers.get('content-type') ?? '';
		if (/text\/html/i.test(contentType)) {
			throw new Error(
				'Direct download returned HTML instead of a file — check that the link is a direct download (e.g. Dropbox with dl=1).',
			);
		}

		const contentLength = Number(response.headers.get('content-length') ?? '');
		if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
			throw new Error(
				`Direct download too large (${contentLength} bytes; max ${MAX_DOWNLOAD_BYTES})`,
			);
		}

		const fromHeader = safeDownloadFilename(
			filenameFromContentDisposition(
				response.headers.get('content-disposition'),
			),
		);
		const urlName = safeDownloadFilename(
			decodeURIComponent(basename(new URL(response.url).pathname)),
		);
		const filename =
			fromHeader ||
			(urlName && urlName !== '/'
				? urlName
				: `direct-download-${Date.now()}.bin`);

		const body = await response.arrayBuffer();
		if (body.byteLength > MAX_DOWNLOAD_BYTES) {
			throw new Error(
				`Direct download too large (${body.byteLength} bytes; max ${MAX_DOWNLOAD_BYTES})`,
			);
		}

		const target = join('./downloads', filename);
		await Bun.write(target, body);
		console.log(`Saved ${filename}`);
		return filename;
	}

	async close(): Promise<void> {
		// no-op (browserless)
	}
}
