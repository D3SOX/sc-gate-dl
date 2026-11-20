import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { DroploudDownloader } from './droploud';

let browser: Browser;
let page: Page;

beforeAll(async () => {
	browser = await launchAppBrowser({ headless: true });
	page = await browser.newPage();
});

afterAll(async () => {
	await browser?.close();
});

test('recognizes and verifies a repost step after SoundCloud authorization', async () => {
	await page.setContent(`
		<section class="ds-gate-card"><div class="ds-gate-pane">
			<h2 class="ds-gate-t">Repost the track</h2>
			<button id="verify">Verify</button>
			<button>Back to SoundCloud</button>
		</div></section>
		<script>
			document.getElementById('verify').onclick = () => {
				document.querySelector('.ds-gate-pane').innerHTML = '<h2 class="ds-gate-t">Email</h2>';
			};
		</script>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	const gate = downloader as unknown as {
		detectPaneKind(page: Page): Promise<string>;
		handleRepostVerify(page: Page): Promise<void>;
	};
	expect(await gate.detectPaneKind(page)).toBe('repost_verify');
	await gate.handleRepostVerify(page);
	expect(await page.$eval('.ds-gate-t', (element) => element.textContent)).toBe(
		'Email',
	);
});

test('recognizes a repost verification step before any social cards', async () => {
	await page.setContent(`
		<div class="ds-gate-pane">
			<h2 class="ds-gate-t">Repost the track</h2>
			<button>Verify</button>
			<button>Back to SoundCloud</button>
		</div>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	expect(
		await (
			downloader as unknown as { detectPaneKind(page: Page): Promise<string> }
		).detectPaneKind(page),
	).toBe('repost_verify');
});

test('repost verification fails visibly when the gate stays on the same step', async () => {
	await page.setContent(
		'<div class="ds-gate-pane"><h2 class="ds-gate-t">Repost the track</h2><button>Verify</button></div>',
	);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	const gate = downloader as unknown as {
		handleRepostVerify(page: Page): Promise<void>;
	};
	const wait = page.waitForFunction;
	page.waitForFunction = (() =>
		Promise.reject(new Error('Timed out'))) as typeof page.waitForFunction;
	try {
		await expect(gate.handleRepostVerify(page)).rejects.toThrow('timed out');
	} finally {
		page.waitForFunction = wait;
	}
});

test('reports a rejected repost verification without waiting for the full timeout', async () => {
	await page.setContent(`
		<div class="ds-gate-pane"><h2 class="ds-gate-t">Repost the track</h2>
		<p>Connected as @example</p><button id="verify">Verify</button></div>
		<script>
			document.getElementById('verify').onclick = () => {
				document.getElementById('verify').textContent = 'Verify again';
			};
		</script>
	`);
	const downloader = new DroploudDownloader({
		comment: 'test',
		browserMode: 'headless',
	});
	const gate = downloader as unknown as {
		handleRepostVerify(page: Page): Promise<void>;
	};
	await expect(gate.handleRepostVerify(page)).rejects.toThrow(
		'could not verify',
	);
}, 8_000);
