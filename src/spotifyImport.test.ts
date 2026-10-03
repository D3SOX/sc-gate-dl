import { describe, expect, test } from 'bun:test';
import { scoreSoundcloudCandidate, type SpotifyImportTrack } from './spotifyImport';

const wanted: SpotifyImportTrack = {
	spotifyId: '1',
	uri: 'spotify:track:1',
	title: 'Example Song',
	artists: ['Example Artist'],
	album: 'Example Album',
	isrc: 'USAAA2600001',
	durationMs: 180_000,
	isLocal: false,
	playlists: [],
	liked: true,
};

const user = {
	username: 'exampleartist',
	full_name: 'Example Artist',
	avatar_url: '',
} as never;

describe('scoreSoundcloudCandidate', () => {
	test('strongly scores an exact title, artist, and duration match', () => {
		const score = scoreSoundcloudCandidate(wanted, {
			title: 'Example Song',
			duration: 180_200,
			publisher_metadata: { artist: 'Example Artist' },
			user,
		});
		expect(score).toBeGreaterThan(0.95);
	});

	test('treats an exact ISRC as definitive', () => {
		const score = scoreSoundcloudCandidate(wanted, {
			title: 'Odd uploader title',
			duration: 181_000,
			publisher_metadata: {
				artist: 'Different display name',
				isrc: 'usaaa2600001',
			},
			user,
		});
		expect(score).toBe(1);
	});

	test('penalizes an unwanted remix', () => {
		const exact = scoreSoundcloudCandidate(wanted, {
			title: 'Example Song',
			duration: 180_000,
			publisher_metadata: { artist: 'Example Artist' },
			user,
		});
		const remix = scoreSoundcloudCandidate(wanted, {
			title: 'Example Song (Remix)',
			duration: 180_000,
			publisher_metadata: { artist: 'Example Artist' },
			user,
		});
		expect(remix).toBeLessThan(exact);
	});

	test('drops candidates with a large duration mismatch', () => {
		const score = scoreSoundcloudCandidate(wanted, {
			title: 'Example Song',
			duration: 240_000,
			publisher_metadata: { artist: 'Example Artist' },
			user,
		});
		expect(score).toBeLessThan(0.9);
	});
});
