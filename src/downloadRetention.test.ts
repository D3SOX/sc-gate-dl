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
});
