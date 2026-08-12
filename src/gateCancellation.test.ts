import { describe, expect, test } from 'bun:test';
import { DownloadgaterDownloader } from './downloadgater';
import { DroploudDownloader } from './droploud';
import { GaterushDownloader } from './gaterush';
import { HypedditDownloader } from './hypeddit';
import { MypresskitDownloader } from './mypresskit';
import { PumpyoursoundDownloader } from './pumpyoursound';
import { StillhypeDownloader } from './stillhype';
import type { HypedditConfig } from './types';

const config: HypedditConfig = {
	comment: '',
	browserMode: 'headless',
};

type ClosableDownloader = {
	close(): Promise<void>;
};

async function expectPendingWaitCancelled(
	downloader: ClosableDownloader,
): Promise<void> {
	let rejectPending = (_error: Error) => {};
	const pending = new Promise<void>((_resolve, reject) => {
		rejectPending = reject;
	});
	const settled = pending.catch((error: unknown) => error);
	const events: string[] = [];

	Object.assign(downloader, {
		cancelPendingDownloadWait: () => {
			events.push('cancel');
			rejectPending(new Error('Download was canceled'));
		},
		browserLaunch: {
			close: async () => {
				events.push('close');
			},
		},
	});

	await downloader.close();

	expect(events).toEqual(['cancel', 'close']);
	expect(await settled).toEqual(new Error('Download was canceled'));
}

describe('browser gate cancellation', () => {
	for (const [name, create] of [
		['Droploud', () => new DroploudDownloader(config)],
		['GateRush', () => new GaterushDownloader(config)],
		['DownloadGater', () => new DownloadgaterDownloader(config)],
		['StillHype', () => new StillhypeDownloader(config)],
		['Hypeddit', () => new HypedditDownloader(config)],
	] satisfies Array<[string, () => ClosableDownloader]>) {
		test(`${name} rejects a pending download wait before closing`, async () => {
			await expectPendingWaitCancelled(create());
		});
	}

	test('MyPressKit aborts its direct file transfer before closing', async () => {
		const downloader = new MypresskitDownloader(config);
		const downloadAbortController = new AbortController();
		const events: string[] = [];
		downloadAbortController.signal.addEventListener('abort', () => {
			events.push('abort');
		});
		Object.assign(downloader, {
			downloadAbortController,
			browserLaunch: {
				close: async () => {
					events.push('close');
				},
			},
		});

		await downloader.close();

		expect(events).toEqual(['abort', 'close']);
	});

	test('PumpYourSound closes its direct downloader before the browser', async () => {
		const downloader = new PumpyoursoundDownloader(config);
		const events: string[] = [];
		Object.assign(downloader, {
			directDownloader: {
				close: async () => {
					events.push('direct');
				},
			},
			browserLaunch: {
				close: async () => {
					events.push('close');
				},
			},
		});

		await downloader.close();

		expect(events).toEqual(['direct', 'close']);
	});
});
