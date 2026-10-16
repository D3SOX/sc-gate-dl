import { describe, expect, test } from 'bun:test';
import { jobStore } from './jobStore';

describe('jobStore Bandcamp track selection', () => {
	test('manual waits keep a stable alert id until ordinary progress resumes', () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'original');
		try {
			jobStore.updateProgress(job.id, 'handling_gates', 'Connecting...', 40);
			expect(job.progress.attentionId).toBeUndefined();
			jobStore.updateProgress(job.id, 'handling_gates', 'Log in...', 50, {
				requiresAttention: true,
			});
			const first = job.progress.attentionId;
			expect(first).toBeTruthy();
			jobStore.updateProgress(
				job.id,
				'handling_gates',
				'Still waiting...',
				50,
				{ requiresAttention: true },
			);
			expect(job.progress.attentionId).toBe(first);
			jobStore.updateProgress(job.id, 'handling_gates', 'Connected', 60);
			expect(job.progress.attentionId).toBeUndefined();
			expect(job.progress.requiresAttention).toBeUndefined();
			jobStore.updateProgress(
				job.id,
				'handling_gates',
				'Solve captcha...',
				60,
				{ requiresAttention: true },
			);
			expect(job.progress.attentionId).not.toBe(first);
		} finally {
			jobStore.delete(job.id);
		}
	});
	test('resolveBandcampTrackSelection delivers URL to waiter', async () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3-320');
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
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3-320');
		try {
			const wait = jobStore.waitForBandcampTrackSelection(job.id);
			jobStore.cancel(job.id);
			expect(await wait).toBeNull();
		} finally {
			jobStore.delete(job.id);
		}
	});

	test('reports cancellation as terminal only after teardown completes', () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3-320');
		const stages: string[] = [];
		const unsubscribe = jobStore.subscribe(job.id, (progress) => {
			stages.push(progress.stage);
		});
		try {
			jobStore.requestCancellation(job.id);
			expect(jobStore.isCancelled(job.id)).toBeTrue();
			expect(jobStore.get(job.id)?.progress.stage).toBe('cancelling');
			expect(stages).toEqual(['cancelling']);

			jobStore.cancel(job.id);
			expect(jobStore.get(job.id)?.progress.stage).toBe('cancelled');
			expect(stages).toEqual(['cancelling', 'cancelled']);
		} finally {
			unsubscribe();
			jobStore.delete(job.id);
		}
	});

	test('delete resolves pending wait with null', async () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3-320');
		const wait = jobStore.waitForBandcampTrackSelection(job.id);
		jobStore.delete(job.id);
		expect(await wait).toBeNull();
	});

	test('second wait supersedes first with null', async () => {
		const job = jobStore.create('https://soundcloud.com/a/b', 'mp3-320');
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
