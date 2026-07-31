/**
 * Shared direct-download URL rules (no imports from utils / downloaders) so
 * matchers and the downloader cannot drift apart.
 */

export const AUDIO_OR_ARCHIVE_EXT_RE =
	/\.(mp3|wav|flac|aiff|aif|m4a|aac|ogg|opus|zip|rar)(\?|$)/i;

export function isKnownDirectDownloadHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		/(?:^|\.)dropbox\.com$/i.test(host) ||
		/(?:^|\.)dropboxusercontent\.com$/i.test(host) ||
		/(?:^|\.)drive\.google\.com$/i.test(host) ||
		/(?:^|\.)docs\.google\.com$/i.test(host)
	);
}

/** True when a parsed URL looks like a direct file link, not an HTML gate page. */
export function urlLooksLikeDirectDownload(url: URL): boolean {
	if (!/^https?:$/i.test(url.protocol)) return false;
	if (isKnownDirectDownloadHost(url.hostname)) return true;
	if (AUDIO_OR_ARCHIVE_EXT_RE.test(url.pathname)) return true;
	// Dropbox preview links often use dl=0; treat any dl= as a download intent.
	if (url.searchParams.has('dl')) return true;
	if (url.searchParams.has('raw')) return true;
	return false;
}

/**
 * Normalize share links so fetch gets the file bytes.
 * Dropbox: force `dl=1` (rewrites `dl=0` preview links and adds `dl` when missing).
 */
export function normalizeDirectDownloadParsedUrl(url: URL): string {
	if (/(?:^|\.)dropbox\.com$/i.test(url.hostname)) {
		const parsed = new URL(url.toString());
		parsed.searchParams.set('dl', '1');
		return parsed.toString();
	}
	const driveFile = url.pathname.match(/\/file\/d\/([^/]+)/);
	if (/(?:^|\.)drive\.google\.com$/i.test(url.hostname) && driveFile?.[1]) {
		return `https://drive.google.com/uc?export=download&id=${driveFile[1]}`;
	}
	return url.toString();
}
