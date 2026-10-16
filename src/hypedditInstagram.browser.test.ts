import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { HypedditDownloader } from './hypeddit';

describe('Hypeddit Instagram visits', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	test('Hypeddit visits each Instagram popup and uses the offered Next without attention', async () => {
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		const unrelated = await context.newPage();
		await unrelated.goto('about:blank#instagram-existing');
		await page.bringToFront();
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			void request.respond({
				status: 200,
				contentType: 'text/html',
				body: `
<button id="downloadProcess">Download</button>
<div id="all_steps"><div class="ig" id="step_ig" hidden>
  <div id="instagram_status">
    <a class="hype-btn-instagram undone">Follow first</a>
    <a class="hype-btn-instagram undone">Follow second</a>
  </div>
  <button id="skipper_ig_next" hidden>Next</button>
</div><div class="dw"><button id="gateDownloadButton" hidden>Download</button></div></div>
<script>
  const links = [...document.querySelectorAll('#instagram_status a')];
  let visits = 0;
  document.querySelector('#downloadProcess').onclick = () => document.querySelector('#step_ig').hidden = false;
  for (const link of links) link.onclick = () => {
    const popup = window.open('about:blank#instagram-visit', 'ig_popup');
    visits++;
    link.classList.remove('undone');
    link.classList.add('done');
    const timer = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(timer);
      if (visits === 2) document.querySelector('#skipper_ig_next').hidden = false;
    }, 20);
  };
  document.querySelector('#skipper_ig_next').onclick = () => {
    document.querySelector('#step_ig').hidden = true;
    document.querySelector('#gateDownloadButton').hidden = false;
    document.body.dataset.visits = visits;
  };
</script>`,
			});
		});
		const downloader = new HypedditDownloader({
			browserMode: 'headless',
			comment: '',
		});
		const attention: boolean[] = [];
		downloader.setProgressCallback((_stage, _message, _percent, extra) => {
			if (extra?.requiresAttention) attention.push(true);
		});
		Object.assign(downloader, {
			browser: { newPage: async () => page },
			handleDownloadSlide: async (gate: Page) => {
				expect(
					await gate.$eval('#gateDownloadButton', (el) => el.checkVisibility()),
				).toBeTrue();
				expect(await gate.evaluate(() => document.body.dataset.visits)).toBe(
					'2',
				);
				Object.assign(downloader, { downloadFilename: 'club-edit.mp3' });
			},
		});
		try {
			expect(
				await downloader.downloadAudio('https://hypeddit.com/fixture'),
			).toBe('club-edit.mp3');
			expect(attention).toEqual([]);
			expect(unrelated.isClosed()).toBeFalse();
			expect(
				(await context.pages()).some((p) =>
					p.url().includes('#instagram-visit'),
				),
			).toBeFalse();
		} finally {
			await context.close();
		}
	}, 15_000);
});
