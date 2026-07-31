import { describe, expect, test } from 'bun:test';
import { jobStore } from './jobStore';

describe('jobStore Bandcamp track selection', () => {
	test('resolveBandcampTrackSelection delivers URL to waiter', async () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3');
		try {
			const wait = jobStore.waitForBandcampTrackSelection(job.id);
			expect(
				jobStore.resolveBandcampTrackSelection(
					job.id,
					'https://x.bandcamp.com/track/y',
				),
			).toBe(true);
			expect(await wait).toBe('https://x.bandcamp.com/track/y');
		} finally {
			jobStore.delete(job.id);
		}
	});

	test('cancel resolves pending wait with null', async () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3');
		try {
			const wait = jobStore.waitForBandcampTrackSelection(job.id);
			jobStore.cancel(job.id);
			expect(await wait).toBeNull();
		} finally {
			jobStore.delete(job.id);
		}
	});

	test('delete resolves pending wait with null', async () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3');
		const wait = jobStore.waitForBandcampTrackSelection(job.id);
		jobStore.delete(job.id);
		expect(await wait).toBeNull();
	});

	test('second wait supersedes first with null', async () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3');
		try {
			const first = jobStore.waitForBandcampTrackSelection(job.id);
			const second = jobStore.waitForBandcampTrackSelection(job.id);
			expect(await first).toBeNull();
			expect(
				jobStore.resolveBandcampTrackSelection(
					job.id,
					'https://x.bandcamp.com/track/z',
				),
			).toBe(true);
			expect(await second).toBe('https://x.bandcamp.com/track/z');
		} finally {
			jobStore.delete(job.id);
		}
	});
});
