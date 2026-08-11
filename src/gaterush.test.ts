import { describe, expect, test } from 'bun:test';
import { GaterushDownloader } from './gaterush';

describe('GaterushDownloader cancellation', () => {
	test('rejects a pending download wait before closing the browser', async () => {
		const downloader = new GaterushDownloader({
			comment: '',
			browserMode: 'headless',
		});
		let rejectPending = (_error: Error) => {};
		const pending = new Promise<void>((_resolve, reject) => {
			rejectPending = reject;
		});
		const settled = pending.catch((error: unknown) => error);
		let browserClosed = false;

		Object.assign(downloader, {
			cancelPendingDownloadWait: () => {
				rejectPending(new Error('Download was canceled'));
			},
			browser: {
				close: async () => {
					browserClosed = true;
				},
			},
		});

		await downloader.close();

		expect(browserClosed).toBeTrue();
		expect(await settled).toEqual(new Error('Download was canceled'));
	});
});
