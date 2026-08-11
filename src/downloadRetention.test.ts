import { describe, expect, test } from 'bun:test';
import {
	deleteAfterDownloadEnabled,
	streamWithSuccessfulDownloadCleanup,
} from './downloadRetention';

describe('delete-after-download setting', () => {
	test('only enables explicit true', () => {
		expect(deleteAfterDownloadEnabled(' true ')).toBeTrue();
		expect(deleteAfterDownloadEnabled('false')).toBeFalse();
		expect(deleteAfterDownloadEnabled(undefined)).toBeFalse();
	});
});

describe('successful download cleanup stream', () => {
	test('cleans up after the complete body is consumed', async () => {
		let cleanups = 0;
		const stream = streamWithSuccessfulDownloadCleanup(
			new Blob(['complete']).stream(),
			async () => {
				cleanups += 1;
			},
		);
		expect(await new Response(stream).text()).toBe('complete');
		expect(cleanups).toBe(1);
	});

	test('keeps the file when the response is cancelled', async () => {
		let cleanups = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
		});
		const reader = streamWithSuccessfulDownloadCleanup(source, async () => {
			cleanups += 1;
		}).getReader();
		await reader.read();
		await reader.cancel();
		expect(cleanups).toBe(0);
	});

	test('keeps the file when the request aborts after the final chunk', async () => {
		let finishSource = () => {};
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) {
					controller.enqueue(new Uint8Array([1]));
					return;
				}
				return new Promise<void>((resolve) => {
					finishSource = () => {
						controller.close();
						resolve();
					};
				});
			},
		});
		const abortController = new AbortController();
		let cleanups = 0;
		const reader = streamWithSuccessfulDownloadCleanup(
			source,
			async () => {
				cleanups += 1;
			},
			abortController.signal,
		).getReader();

		expect((await reader.read()).done).toBeFalse();
		abortController.abort();
		finishSource();
		expect((await reader.read()).done).toBeTrue();
		expect(cleanups).toBe(0);
	});
});
