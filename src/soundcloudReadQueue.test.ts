import { expect, test } from 'bun:test';
import { SoundcloudClient } from './soundcloud';
import { SoundcloudReadQueue } from './soundcloudReadQueue';

function fixture() {
	let now = 0;
	const waits: number[] = [];
	const queue = new SoundcloudReadQueue({
		now: () => now,
		sleep: async (delay) => {
			waits.push(delay);
			now += delay;
		},
	});
	return { queue, waits };
}

test('track reads retry 429 after cooldown instead of failing each track immediately', async () => {
	const { queue, waits } = fixture();
	const client = new SoundcloudClient({
		credentials: { clientId: 'test', oauthToken: 'test' },
		readQueue: queue,
	});
	let attempts = 0;
	Object.assign(client, {
		soundcloud: {
			tracks: {
				get: async () => {
					attempts++;
					if (attempts < 3) throw new Error('Status code 429');
					return { id: 42, title: 'Recording' };
				},
			},
		},
	});
	const notices: number[] = [];
	expect(
		await client.getTrack('https://soundcloud.com/artist/recording', (delay) =>
			notices.push(delay),
		),
	).toMatchObject({ id: 42 });
	expect(attempts).toBe(3);
	expect(waits).toEqual([30_000, 60_000]);
	expect(notices).toEqual([30_000, 60_000]);
});

test('exhausted rate limits leave a shared cooldown for the next read', async () => {
	const { queue, waits } = fixture();
	let attempts = 0;
	await expect(
		queue.run(async () => {
			attempts++;
			throw new Error('Status code 429');
		}),
	).rejects.toThrow('429');
	expect(attempts).toBe(3);
	expect(await queue.run(async () => 'next')).toBe('next');
	expect(waits).toEqual([30_000, 60_000, 120_000]);
});

test('read calls are serialized and authentication failures are not retried', async () => {
	const { queue, waits } = fixture();
	const events: string[] = [];
	await Promise.all([
		queue.run(async () => {
			events.push('first');
			return 1;
		}),
		queue.run(async () => {
			events.push('second');
			return 2;
		}),
	]);
	expect(events).toEqual(['first', 'second']);
	expect(waits).toEqual([2000]);
	let attempts = 0;
	await expect(
		queue.run(async () => {
			attempts++;
			throw new Error('Status code 403');
		}),
	).rejects.toThrow('403');
	expect(attempts).toBe(1);
});
