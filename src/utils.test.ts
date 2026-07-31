import { describe, expect, test } from 'bun:test';
import {
	artistTitleFilename,
	cookiesToNetscape,
	previewProcessedFilename,
	resolveGateProviderUrl,
	sanitizeFilenamePart,
} from './utils';

describe('resolveGateProviderUrl', () => {
	test('extracts Bandcamp track URLs from surrounding prose', () => {
		expect(
			resolveGateProviderUrl(
				'grab it (https://artist.bandcamp.com/track/song).',
			),
		).toEqual({
			url: 'https://artist.bandcamp.com/track/song',
			provider: 'bandcamp',
		});
	});

	test('strips trailing sentence punctuation from SoundCloud URLs', () => {
		expect(
			resolveGateProviderUrl('listen: https://soundcloud.com/a/b!'),
		).toEqual({
			url: 'https://soundcloud.com/a/b',
			provider: 'soundcloud',
		});
	});

	test('strips Markdown-style closing delimiters', () => {
		expect(
			resolveGateProviderUrl('[buy](https://x.bandcamp.com/album/y)'),
		).toEqual({
			url: 'https://x.bandcamp.com/album/y',
			provider: 'bandcamp',
		});
	});

	test('prefers traditional gates over Bandcamp', () => {
		expect(
			resolveGateProviderUrl(
				'https://hypeddit.com/foo and https://x.bandcamp.com/track/y',
			),
		).toEqual({
			url: 'https://hypeddit.com/foo',
			provider: 'hypeddit',
		});
	});
});

describe('cookiesToNetscape', () => {
	test('emits Netscape rows with subdomain flag from leading dot', () => {
		const text = cookiesToNetscape([
			{
				name: 'oauth_token',
				value: 'tok',
				domain: 'soundcloud.com',
				path: '/',
				secure: true,
				expirationDate: 1700000000.5,
			},
			{
				name: 'datadome',
				value: 'dd',
				domain: '.soundcloud.com',
				path: '/',
				secure: false,
			},
		]);
		expect(text.startsWith('# Netscape HTTP Cookie File\n')).toBe(true);
		expect(text).toContain(
			'soundcloud.com\tFALSE\t/\tTRUE\t1700000000\toauth_token\ttok',
		);
		expect(text).toContain('.soundcloud.com\tTRUE\t/\tFALSE\t0\tdatadome\tdd');
	});
});

describe('sanitizeFilenamePart', () => {
	test('strips unsafe filename characters and collapses whitespace', () => {
		expect(sanitizeFilenamePart('  a/b:c*d?e  ')).toBe('abcde');
		expect(sanitizeFilenamePart('foo   bar')).toBe('foo bar');
	});
});

describe('artistTitleFilename', () => {
	test('builds Artist - Title with default mp3 extension', () => {
		expect(artistTitleFilename('Wax Thief', 'When I grow up')).toBe(
			'Wax Thief - When I grow up.mp3',
		);
	});

	test('falls back for empty artist/title and preserves custom extension', () => {
		expect(artistTitleFilename('  ', '', '.wav')).toBe(
			'Unknown Artist - Unknown Title.wav',
		);
		expect(artistTitleFilename('A', 'B', 'flac')).toBe('A - B.flac');
	});
});

describe('previewProcessedFilename', () => {
	test('prefers artist-title naming when requested', () => {
		expect(
			previewProcessedFilename('track.wav', {
				nameAsArtistTitle: true,
				artist: 'Artist',
				title: 'Title',
			}),
		).toBe('Artist - Title.mp3');
	});

	test('converts lossless extensions to mp3 when not renaming', () => {
		expect(
			previewProcessedFilename('song.flac', { nameAsArtistTitle: false }),
		).toBe('song.mp3');
		expect(
			previewProcessedFilename('song.aiff', { nameAsArtistTitle: false }),
		).toBe('song.mp3');
	});

	test('keeps non-lossless filenames unchanged when not renaming', () => {
		expect(
			previewProcessedFilename('song.mp3', { nameAsArtistTitle: false }),
		).toBe('song.mp3');
	});
});
