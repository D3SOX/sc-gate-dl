import { describe, expect, test } from 'bun:test';
import { isSoundcloudLoginDocument } from './soundcloudLogin';

describe('SoundCloud interactive login detection', () => {
	test('detects a SoundCloud sign-in page without an approval action', () => {
		expect(
			isSoundcloudLoginDocument(
				'https://secure.soundcloud.com/authorize',
				'Sign in or create an account',
				false,
			),
		).toBe(true);
	});

	test('does not interrupt an OAuth approval page or another host', () => {
		expect(
			isSoundcloudLoginDocument(
				'https://secure.soundcloud.com/authorize',
				'Sign in or create an account',
				true,
			),
		).toBe(false);
		expect(
			isSoundcloudLoginDocument(
				'https://example.com/',
				'Sign in or create an account',
				false,
			),
		).toBe(false);
	});
});
