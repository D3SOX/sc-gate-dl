import { mkdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
	normalizeDirectDownloadParsedUrl,
	urlLooksLikeDirectDownload,
} from './directLinkRules';
import type { ProgressCallback } from './hypeddit';
import { safeFetch } from './safeOutboundUrl';
import { sanitizeFilenamePart, trimExtractedUrl } from './utils';

const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
/** Cap downloads (audio / zip packages). */
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

async function writeBodyWithSizeLimit(
	body: ReadableStream<Uint8Array>,
	target: string,
	maxBytes: number,
): Promise<void> {
	const writer = Bun.file(target).writer();
	const reader = body.getReader();
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error(
					`Direct download too large (${total} bytes; max ${maxBytes})`,
				);
			}
			writer.write(value);
		}
		await writer.end();
	} catch (error) {
		try {
			writer.end();
		} catch {
			// ignore
		}
		await unlink(target).catch(() => {});
		throw error;
	}
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

		let current = downloadUrl;
		let response: Response | null = null;
		let finalUrl = current;

		for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
			const result = await safeFetch(current, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: {
					'user-agent': USER_AGENT,
					accept: '*/*',
				},
			});
			finalUrl = result.url;
			response = result.response;

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				await response.body?.cancel().catch(() => {});
				if (!location) {
					throw new Error(
						`Direct download redirect missing Location from ${current}`,
					);
				}
				current = new URL(location, current).toString();
				continue;
			}
			break;
		}

		if (!response) {
			throw new Error(`Direct download failed for ${downloadUrl}`);
		}
		if (response.status >= 300 && response.status < 400) {
			throw new Error(
				`Direct download exceeded ${MAX_REDIRECTS} redirects for ${downloadUrl}`,
			);
		}
		if (!response.ok) {
			throw new Error(
				`Direct download failed: HTTP ${response.status} for ${finalUrl}`,
			);
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (/text\/html/i.test(contentType)) {
			await response.body?.cancel().catch(() => {});
			throw new Error(
				'Direct download returned HTML instead of a file — check that the link is a direct download (e.g. Dropbox with dl=1).',
			);
		}

		const contentLengthHeader = response.headers.get('content-length');
		if (contentLengthHeader) {
			const contentLength = Number(contentLengthHeader);
			if (
				Number.isFinite(contentLength) &&
				contentLength > MAX_DOWNLOAD_BYTES
			) {
				await response.body?.cancel().catch(() => {});
				throw new Error(
					`Direct download too large (${contentLength} bytes; max ${MAX_DOWNLOAD_BYTES})`,
				);
			}
		}

		const fromHeader = safeDownloadFilename(
			filenameFromContentDisposition(
				response.headers.get('content-disposition'),
			),
		);
		const urlName = safeDownloadFilename(
			decodeURIComponent(basename(new URL(finalUrl).pathname)),
		);
		const filename =
			fromHeader ||
			(urlName && urlName !== '/'
				? urlName
				: `direct-download-${Date.now()}.bin`);

		if (!response.body) {
			throw new Error(`Direct download returned an empty body for ${finalUrl}`);
		}

		const target = join('./downloads', filename);
		await writeBodyWithSizeLimit(response.body, target, MAX_DOWNLOAD_BYTES);
		console.log(`Saved ${filename}`);
		return filename;
	}

	async close(): Promise<void> {
		// no-op (browserless)
	}
}
