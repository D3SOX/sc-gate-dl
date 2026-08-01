/**
 * Shared direct-download URL rules (no imports from utils / downloaders) so
 * matchers and the downloader cannot drift apart.
 */

export const AUDIO_OR_ARCHIVE_EXT_RE =
	/\.(mp3|wav|flac|aiff|aif|m4a|aac|ogg|opus|zip|rar)(\?|$)/i;

/** Google Drive file IDs are long URL-safe tokens. */
const DRIVE_FILE_ID_RE = /^[a-zA-Z0-9_-]{10,}$/;

export function isKnownDirectDownloadHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		/(?:^|\.)dropbox\.com$/i.test(host) ||
		/(?:^|\.)dropboxusercontent\.com$/i.test(host) ||
		/(?:^|\.)drive\.google\.com$/i.test(host)
	);
}

/** Extract a validated Drive file id from path (`/file/d/ID`) or `id` query. */
export function extractDriveFileId(url: URL): string | null {
	const fromPath = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1];
	if (fromPath && DRIVE_FILE_ID_RE.test(fromPath)) return fromPath;
	const fromQuery = url.searchParams.get('id');
	if (fromQuery && DRIVE_FILE_ID_RE.test(fromQuery)) return fromQuery;
	return null;
}

/** True when a parsed URL looks like a direct file link, not an HTML gate page. */
export function urlLooksLikeDirectDownload(url: URL): boolean {
	if (!/^https?:$/i.test(url.protocol)) return false;
	const host = url.hostname.toLowerCase();
	if (
		/(?:^|\.)dropbox\.com$/i.test(host) ||
		/(?:^|\.)dropboxusercontent\.com$/i.test(host)
	) {
		return true;
	}
	if (/(?:^|\.)drive\.google\.com$/i.test(host)) {
		return extractDriveFileId(url) !== null;
	}
	if (AUDIO_OR_ARCHIVE_EXT_RE.test(url.pathname)) return true;
	return false;
}

/**
 * Normalize share links so fetch gets the file bytes.
 * Dropbox: force `dl=1` (rewrites `dl=0` preview links and adds `dl` when missing).
 * Drive: only rewrite when a valid file id is present.
 */
export function normalizeDirectDownloadParsedUrl(url: URL): string {
	if (/(?:^|\.)dropbox\.com$/i.test(url.hostname)) {
		const parsed = new URL(url.toString());
		parsed.searchParams.set('dl', '1');
		return parsed.toString();
	}
	if (/(?:^|\.)drive\.google\.com$/i.test(url.hostname)) {
		const id = extractDriveFileId(url);
		if (!id) {
			throw new Error(
				`Malformed Google Drive link (missing valid file id): ${url}`,
			);
		}
		const download = new URL('https://drive.google.com/uc');
		download.searchParams.set('export', 'download');
		download.searchParams.set('id', id);
		// Link-shared files may require resourcekey alongside the file id.
		let resourceKey: string | null = null;
		for (const [key, value] of url.searchParams) {
			if (key.toLowerCase() === 'resourcekey' && value) {
				resourceKey = value;
				break;
			}
		}
		if (resourceKey) {
			download.searchParams.set('resourcekey', resourceKey);
		}
		return download.toString();
	}
	return url.toString();
}
