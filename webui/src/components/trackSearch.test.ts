/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import type { SearchResult } from '../../../src/types';
import {
	appendSearchResults,
	formatDuration,
	isTrackUrlInput,
	searchThumbnailUrl,
} from './trackSearch';

function result(id: number): SearchResult {
	return {
		id,
		url: `https://soundcloud.com/artist/track-${id}`,
		title: `Track ${id}`,
		artist: 'Artist',
		uploader: 'artist',
		artworkUrl: null,
		durationMs: 1000,
		genre: null,
		source: 'none',
	};
}

describe('isTrackUrlInput', () => {
	test('fetches links and searches everything else', () => {
		expect(isTrackUrlInput(' https://soundcloud.com/artist/track ')).toBe(true);
		expect(isTrackUrlInput('HTTP://soundcloud.com/artist/track')).toBe(true);
		expect(isTrackUrlInput('artist - track')).toBe(false);
		expect(isTrackUrlInput('soundcloud.com/artist/track')).toBe(false);
	});
});

describe('formatDuration', () => {
	test('formats tracks and long mixes', () => {
		expect(formatDuration(245_000)).toBe('4:05');
		expect(formatDuration(59_600)).toBe('1:00');
		expect(formatDuration(3_725_000)).toBe('1:02:05');
	});
});

describe('appendSearchResults', () => {
	test('skips tracks that an earlier page already returned', () => {
		expect(
			appendSearchResults([result(1), result(2)], [result(2), result(3)]).map(
				({ id }) => id,
			),
		).toEqual([1, 2, 3]);
	});
});

describe('searchThumbnailUrl', () => {
	test('requests the small artwork size', () => {
		expect(
			searchThumbnailUrl('https://i1.sndcdn.com/artworks-abc-t500x500.jpg'),
		).toBe('https://i1.sndcdn.com/artworks-abc-large.jpg');
	});
});
