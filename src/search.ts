import type { SoundcloudTrack, SoundcloudTrackSearch } from 'soundcloud.ts';
import { isSoundcloudDownloadEnabled } from './soundcloudDownload';
import type { SearchResponse, SearchResult, SearchSource } from './types';
import { extractGateUrl, getDefaultMetadata } from './utils';

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

export interface SearchQuery {
	q: string;
	limit: number;
	offset: number;
}

/** Returns the parsed query, or an error message for a 400 response. */
export function parseSearchQuery(
	params: URLSearchParams,
): SearchQuery | string {
	const q = params.get('q')?.trim() ?? '';
	if (!q) return 'q is required';
	const limit = parseCount(params.get('limit'), DEFAULT_SEARCH_LIMIT);
	if (limit === null || limit < 1 || limit > MAX_SEARCH_LIMIT) {
		return `limit must be between 1 and ${MAX_SEARCH_LIMIT}`;
	}
	const offset = parseCount(params.get('offset'), 0);
	if (offset === null) return 'offset must be 0 or greater';
	return { q, limit, offset };
}

function parseCount(value: string | null, fallback: number): number | null {
	if (value === null || value === '') return fallback;
	return /^\d+$/.test(value) ? Number(value) : null;
}

export function searchSource(track: SoundcloudTrack): SearchSource {
	if (isSoundcloudDownloadEnabled(track)) return 'download';
	return extractGateUrl(track) ? 'gate' : 'none';
}

/** SoundCloud returns 100px `-large` artwork; request the 500px variant. */
function largeArtworkUrl(url: string | null | undefined): string | null {
	return url ? url.replace('-large.', '-t500x500.') : null;
}

export function toSearchResult(track: SoundcloudTrack): SearchResult {
	return {
		id: track.id,
		url: track.permalink_url,
		title: track.title,
		artist: getDefaultMetadata(track).artist ?? track.user.username,
		uploader: track.user.username,
		artworkUrl: largeArtworkUrl(track.artwork_url || track.user.avatar_url),
		durationMs: track.full_duration || track.duration,
		genre: track.genre || null,
		source: searchSource(track),
	};
}

export function toSearchResponse(
	search: Pick<SoundcloudTrackSearch, 'collection' | 'next_href'>,
	query: SearchQuery,
): SearchResponse {
	return {
		results: search.collection.map(toSearchResult),
		nextOffset: search.next_href ? query.offset + query.limit : null,
	};
}

/**
 * Accepts only SoundCloud's image CDN, so the artwork proxy cannot be used to
 * reach other hosts. Returns the normalized URL or null.
 */
export function parseArtworkUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		const allowed =
			url.protocol === 'https:' &&
			url.hostname.endsWith('.sndcdn.com') &&
			url.port === '' &&
			url.username === '' &&
			url.password === '';
		return allowed ? url.href : null;
	} catch {
		return null;
	}
}
