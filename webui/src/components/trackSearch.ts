import type { SearchResult, SearchSource } from '../../../src/types';

export const SEARCH_SOURCE_LABELS: Partial<Record<SearchSource, string>> = {
	download: 'Free download',
	gate: 'Gate',
};

/** A link is fetched as a track; anything else is searched. */
export function isTrackUrlInput(value: string): boolean {
	return /^https?:\/\//i.test(value.trim());
}

/** `m:ss`, or `h:mm:ss` for mixes. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = String(totalSeconds % 60).padStart(2, '0');
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
		: `${minutes}:${seconds}`;
}

/** Append a page, skipping tracks SoundCloud repeats across offsets. */
export function appendSearchResults(
	current: SearchResult[],
	page: SearchResult[],
): SearchResult[] {
	const seen = new Set(current.map((result) => result.id));
	return [...current, ...page.filter((result) => !seen.has(result.id))];
}

/**
 * Load the 100px cover through the API's artwork proxy, so a search never
 * makes the browser contact SoundCloud. Results carry 500px artwork URLs.
 */
export function searchThumbnailUrl(
	apiBase: string,
	artworkUrl: string,
): string {
	const url = artworkUrl.replace('-t500x500.', '-large.');
	return `${apiBase}/api/artwork?${new URLSearchParams({ url })}`;
}
