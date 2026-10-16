import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import type { Browser } from 'puppeteer';
import { BandcampGateDownloader } from './bandcampGate';
import { launchAppBrowser } from './browserLaunch';
import { DirectDownloader } from './directDownload';

let browser: Browser;
beforeAll(async () => {
	browser = await launchAppBrowser({ headless: true, humanize: false });
}, 30_000);
afterAll(async () => {
	await browser?.close();
});

// Local browser replay of the actual Bandcamp controls. No email is sent,
// no public gate is submitted, and the file fetch is replaced by a spy.
test('free Bandcamp UI keeps MP3 320 and waits for its regenerated download link', async () => {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	await page.setRequestInterception(true);
	page.on('request', (request) => {
		void request.respond({
			status: 200,
			contentType: 'text/html',
			body: new URL(request.url()).pathname.startsWith('/download')
				? `<select><option value="mp3-v0">MP3 V0</option><option value="mp3-320">MP3 320</option><option value="flac">FLAC</option></select>
<a href="https://t4.bcbits.com/download/test/mp3-v0/123">Download</a>
<script>document.querySelector('select').onchange=()=>setTimeout(()=>document.querySelector('a').href='https://t4.bcbits.com/download/test/mp3-320/123',100);</script>`
				: `<script>window.TralbumData={current:{minimum_price:0}};</script>
<div class="buyItem"><button>Buy Digital Track</button></div>
<input id="userPrice" hidden>
<a class="download-panel-free-download-link" hidden>download to your computer</a>
<button id="complete" hidden>Continue to download</button>
<script>
document.querySelector('.buyItem button').onclick=()=>document.querySelector('#userPrice').hidden=false;
document.querySelector('#userPrice').onchange=()=>document.querySelector('.download-panel-free-download-link').hidden=false;
document.querySelector('.download-panel-free-download-link').onclick=()=>document.querySelector('#complete').hidden=false;
document.querySelector('#complete').onclick=()=>location.href='/download/test';
</script>`,
		});
	});
	let completedForm: Promise<void> | undefined;
	const attention: boolean[] = [];
	const downloader = new BandcampGateDownloader(
		page,
		(_stage, _message, _percent, extra) => {
			if (extra?.requiresAttention === undefined) return;
			attention.push(extra.requiresAttention);
			if (extra.requiresAttention) completedForm = page.click('#complete');
		},
	);
	const direct = spyOn(
		DirectDownloader.prototype,
		'downloadAudio',
	).mockResolvedValue('recording.mp3');
	try {
		expect(
			await downloader.downloadAudio('https://artist.bandcamp.com/track/test', {
				originalOnly: true,
			}),
		).toEqual({ filename: 'recording.mp3', method: 'gate' });
		await completedForm;
		expect(direct).toHaveBeenCalledWith(
			'https://t4.bcbits.com/download/test/mp3-320/123',
		);
		expect(
			await page.$eval('select', (e) => (e as HTMLSelectElement).value),
		).toBe('mp3-320');
		expect(attention).toEqual([true, false]);
	} finally {
		direct.mockRestore();
		await downloader.close();
		await context.close();
	}
}, 15_000);
