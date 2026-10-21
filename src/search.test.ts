import { describe, expect, test } from 'bun:test';
import type { SoundcloudTrack } from 'soundcloud.ts';
import {
	MAX_SEARCH_LIMIT,
	parseArtworkUrl,
	parseSearchQuery,
	toSearchResponse,
	toSearchResult,
} from './search';

function track(overrides: Partial<SoundcloudTrack> = {}): SoundcloudTrack {
	return {
		id: 42,
		permalink_url: 'https://soundcloud.com/artist/track',
		title: 'Track',
		artwork_url: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
		duration: 30_000,
		full_duration: 245_000,
		genre: 'House',
		downloadable: false,
		has_downloads_left: false,
		purchase_url: null,
		description: '',
		publisher_metadata: null,
		user: {
			username: 'uploader',
			full_name: '',
			avatar_url: 'https://i1.sndcdn.com/avatars-xyz-large.jpg',
		},
		...overrides,
	} as unknown as SoundcloudTrack;
}

describe('parseSearchQuery', () => {
	test('applies defaults and trims the query', () => {
		expect(parseSearchQuery(new URLSearchParams('q=%20lambo%20'))).toEqual({
			q: 'lambo',
			limit: 20,
			offset: 0,
		});
	});

	test('rejects a blank query', () => {
		expect(parseSearchQuery(new URLSearchParams('q=%20'))).toBe(
			'q is required',
		);
	});

	test('rejects limits outside the allowed range', () => {
		for (const limit of ['0', String(MAX_SEARCH_LIMIT + 1), '2.5', 'ten']) {
			expect(
				typeof parseSearchQuery(new URLSearchParams({ q: 'a', limit })),
			).toBe('string');
		}
	});

	test('rejects negative offsets', () => {
		expect(
			parseSearchQuery(new URLSearchParams({ q: 'a', offset: '-1' })),
		).toBe('offset must be 0 or greater');
	});
});

describe('toSearchResult', () => {
	test('maps the listing and requests larger artwork', () => {
		expect(toSearchResult(track())).toEqual({
			id: 42,
			url: 'https://soundcloud.com/artist/track',
			title: 'Track',
			artist: 'uploader',
			uploader: 'uploader',
			artworkUrl: 'https://i1.sndcdn.com/artworks-abc-t500x500.jpg',
			durationMs: 245_000,
			genre: 'House',
			source: 'none',
		});
	});

	test('uses the same artist as the written tags', () => {
		const result = toSearchResult(
			track({
				publisher_metadata: { artist: 'Publisher Artist' },
			} as Partial<SoundcloudTrack>),
		);
		expect(result.artist).toBe('Publisher Artist');
	});

	test('falls back to the uploader avatar without artwork', () => {
		expect(toSearchResult(track({ artwork_url: '' })).artworkUrl).toBe(
			'https://i1.sndcdn.com/avatars-xyz-t500x500.jpg',
		);
	});

	test('prefers a creator-enabled download', () => {
		expect(
			toSearchResult(
				track({
					downloadable: true,
					has_downloads_left: true,
					purchase_url: 'https://hypeddit.com/artist/track',
				}),
			).source,
		).toBe('download');
	});

	test('detects gates in the purchase link and description', () => {
		expect(
			toSearchResult(track({ purchase_url: 'https://hypeddit.com/a/b' }))
				.source,
		).toBe('gate');
		expect(
			toSearchResult(
				track({ description: 'Free DL: https://hypeddit.com/a/b' }),
			).source,
		).toBe('gate');
	});
});

describe('toSearchResponse', () => {
	const query = { q: 'a', limit: 20, offset: 40 };

	test('returns the next offset while SoundCloud has more results', () => {
		expect(
			toSearchResponse(
				{ collection: [track()], next_href: 'https://api/next' },
				query,
			).nextOffset,
		).toBe(60);
	});

	test('ends pagination without a next page', () => {
		expect(
			toSearchResponse(
				{ collection: [], next_href: null as unknown as string },
				query,
			),
		).toEqual({ results: [], nextOffset: null });
	});
});

describe('parseArtworkUrl', () => {
	test('accepts SoundCloud image CDN URLs', () => {
		const url = 'https://i1.sndcdn.com/artworks-abc-t300x300.jpg';
		expect(parseArtworkUrl(url)).toBe(url);
	});

	test('rejects other hosts, schemes, ports and credentials', () => {
		for (const url of [
			null,
			'not a url',
			'http://i1.sndcdn.com/a.jpg',
			'https://sndcdn.com.example.org/a.jpg',
			'https://evilsndcdn.com/a.jpg',
			'https://i1.sndcdn.com:8443/a.jpg',
			'https://user:pass@i1.sndcdn.com/a.jpg',
			'https://127.0.0.1/a.jpg',
		]) {
			expect(parseArtworkUrl(url)).toBeNull();
		}
	});
});
