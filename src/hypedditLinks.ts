export const NO_HYPEDDIT_DOWNLOAD = 'Hypeddit page has no download link';

export class NoHypedditDownloadError extends Error {
	constructor() {
		super(
			`${NO_HYPEDDIT_DOWNLOAD}; this smartlink only offers listening or purchase links.`,
		);
		this.name = 'NoHypedditDownloadError';
	}
}

/** Inspect the links the page actually offers; missing gate markup alone is inconclusive. */
export function inspectHypedditPage(
	html: string,
	pageUrl: string,
): string | null {
	if (/\bid\s*=\s*["']downloadProcess["']/i.test(html)) return null;
	if (!/hype-smart-link-list-section/.test(html)) return null;
	const downloads = new Set<string>();
	let links = 0;
	let otherDownload = false;
	for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const attributes = match[1] ?? '';
		if (!/\bclass\s*=\s*["'][^"']*\bsmartlink-click-button\b/i.test(attributes))
			continue;
		links++;
		const href = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
		if (!href) continue;
		const text = (match[2] ?? '').replace(/<[^>]*>/g, ' ');
		const isDownload =
			/\bdownload\b/i.test(text) ||
			/\bdata-type\s*=\s*["']hypeddit["']/i.test(attributes);
		if (!isDownload) continue;
		try {
			const url = new URL(href.replace(/&amp;/g, '&'), pageUrl);
			if (
				url.protocol === 'https:' &&
				/^(?:www\.)?hypeddit\.com$/i.test(url.hostname)
			)
				downloads.add(url.toString());
			else otherDownload = true;
		} catch {
			otherDownload = true;
		}
	}
	if (downloads.size > 1)
		throw new Error(
			'Multiple Hypeddit download links are available. Choose the recording manually.',
		);
	const destination = [...downloads][0];
	if (destination) return destination;
	if (links && !otherDownload) throw new NoHypedditDownloadError();
	return null;
}
