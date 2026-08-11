import { describe, expect, test } from 'bun:test';
import { JobQueue } from './jobQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('JobQueue', () => {
	test('runs one job and advances waiting jobs across clients', async () => {
		const first = deferred();
		const third = deferred();
		const started: string[] = [];
		const positions = new Map<string, number>();
		const errors: unknown[] = [];
		const queue = new JobQueue({
			onQueued: (id, position) => positions.set(id, position),
			onTaskError: (_id, error) => errors.push(error),
		});

		expect(
			queue.enqueue('first', () => {
				started.push('first');
				return first.promise;
			}),
		).toEqual({
			queued: false,
			position: 0,
		});
		expect(
			queue.enqueue('second', async () => {
				started.push('second');
			}),
		).toEqual({
			queued: true,
			position: 1,
		});
		expect(
			queue.enqueue('third', () => {
				started.push('third');
				return third.promise;
			}),
		).toEqual({
			queued: true,
			position: 2,
		});
		expect(started).toEqual(['first']);

		expect(queue.cancel('second')).toBe(true);
		expect(positions.get('third')).toBe(1);

		first.resolve();
		await Bun.sleep(0);
		expect(started).toEqual(['first', 'third']);
		expect(errors).toEqual([]);
		third.resolve();
	});

	test('continues after a job fails', async () => {
		const errors: Array<{ id: string; error: unknown }> = [];
		const started: string[] = [];
		const queue = new JobQueue({
			onQueued: () => {},
			onTaskError: (id, error) => errors.push({ id, error }),
		});

		queue.enqueue('broken', async () => {
			started.push('broken');
			throw new Error('broken');
		});
		queue.enqueue('next', async () => {
			started.push('next');
		});
		await Bun.sleep(0);

		expect(started).toEqual(['broken', 'next']);
		expect(errors[0]?.id).toBe('broken');
	});

	test('lets cancellation wait until the active slot is released', async () => {
		const active = deferred();
		const queue = new JobQueue({
			onQueued: () => {},
			onTaskError: () => {},
		});
		queue.enqueue('active', () => active.promise);

		let released = false;
		const waiting = queue.waitForCompletion('active').then(() => {
			released = true;
		});
		await Bun.sleep(0);
		expect(released).toBeFalse();

		active.resolve();
		await waiting;
		expect(released).toBeTrue();
		expect(queue.enqueue('next', async () => {})).toEqual({
			queued: false,
			position: 0,
		});
	});

	test('releases a cancelled active slot without letting its stale task clear a retry', async () => {
		const stale = deferred();
		const retry = deferred();
		const started: string[] = [];
		const queue = new JobQueue({
			onQueued: () => {},
			onTaskError: () => {},
		});
		queue.enqueue('same-id', () => stale.promise);

		expect(queue.releaseActive('same-id')).toBeTrue();
		expect(
			queue.enqueue('same-id', () => {
				started.push('retry');
				return retry.promise;
			}),
		).toEqual({ queued: false, position: 0 });

		stale.resolve();
		await Bun.sleep(0);
		expect(
			queue.enqueue('next', async () => {
				started.push('next');
			}),
		).toEqual({ queued: true, position: 1 });
		expect(started).toEqual(['retry']);
		retry.resolve();
	});

	test('ignores a stale task error after retrying the same job ID', async () => {
		let rejectStale = (_error: Error) => {};
		const stale = new Promise<void>((_resolve, reject) => {
			rejectStale = reject;
		});
		const retry = deferred();
		const errors: Array<{ id: string; error: unknown }> = [];
		const queue = new JobQueue({
			onQueued: () => {},
			onTaskError: (id, error) => errors.push({ id, error }),
		});

		queue.enqueue('same-id', () => stale);
		expect(queue.releaseActive('same-id')).toBeTrue();
		queue.enqueue('same-id', () => retry.promise);

		rejectStale(new Error('stale failure'));
		await Bun.sleep(0);
		expect(errors).toEqual([]);
		expect(queue.enqueue('next', async () => {})).toEqual({
			queued: true,
			position: 1,
		});

		retry.resolve();
	});
});
