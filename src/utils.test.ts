import { describe, expect, test } from 'bun:test';
import { resolveGateProviderUrl } from './utils';

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
