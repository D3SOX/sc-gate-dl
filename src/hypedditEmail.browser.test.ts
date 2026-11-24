import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { HypedditDownloader } from './hypeddit';

// Email slide as on hypeddit.com/space92/cirezdonoffspace92edit; the page's
// verify-email-ul.js posts /verifyEmailAddress and only on status "T" moves
// the slide left (gateEmailVerificationNextSlide). Until then it covers the
// next slide's buttons.
function gatePage(accept: boolean) {
	return `
<style>.hide { display: none; } .move-left { opacity: 0; z-index: -1 !important; }
  .fangate-slider-content { position: absolute; inset: 0; background: white; }
  .current-slide { z-index: 10; }</style>
<button id="downloadProcess" onclick="document.querySelector('#all_steps').classList.remove('hide')">Download</button>
<div class="carousel-inner all_steps hide" id="all_steps" style="position: relative; height: 300px">
  <div class="email fangate-slider-content current-slide zindex" data-group="1">
    <div class="hype-sidebar-step-form " id="step_email">
      <input type="text" name="email_name" id="email_name">
      <div class="name_error_email_name hype-invalid-feedback"></div>
      <input type="email" name="email_address" id="email_address">
      <div class="name_error_email hype-invalid-feedback"></div>
      <div class="col-sm-12 hide" id="gatePreviewCaptcha"><div id="html_element"></div></div>
      <button type="button" id="email_to_downloads_next">Next</button>
    </div>
  </div>
  <div class="dn fangate-slider-content upcomming-slide" data-group="2">
    <div id="step_dn"><a class="myCarouselSocialSection">Skip donation</a></div>
  </div>
  <div class="dw fangate-slider-content upcomming-slide" data-group="1000"></div>
</div>
<script>
  document.querySelector('#email_to_downloads_next').onclick = () => {
    const error = document.querySelector('.name_error_email');
    error.textContent = '';
    setTimeout(() => {
      if (${accept}) document.querySelector('#email_to_downloads_next').closest('.fangate-slider-content').classList.add('move-left');
      else error.textContent = 'Please enter a valid email address.';
    }, 1500);
  };
</script>`;
}

describe('Hypeddit email step', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function run(accept: boolean) {
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			void request.respond({
				status: 200,
				contentType: 'text/html',
				body: gatePage(accept),
			});
		});
		const downloader = new HypedditDownloader({
			browserMode: 'headless',
			comment: '',
			name: 'Fan',
			email: 'fan@example.test',
		});
		const seen: { emailSlideOnDonation?: string } = {};
		Object.assign(downloader, {
			browser: { newPage: async () => page },
			handleDonationSlide: async (gate: Page) => {
				seen.emailSlideOnDonation = await gate.$eval(
					'.email.fangate-slider-content',
					(slide) => slide.className,
				);
			},
			handleDownloadSlide: async () => {
				Object.assign(downloader, { downloadFilename: 'track.mp3' });
			},
		});
		try {
			const filename = await downloader.downloadAudio(
				'https://hypeddit.com/fixture',
			);
			return { filename, emailSlideOnDonation: seen.emailSlideOnDonation };
		} finally {
			await context.close();
		}
	}

	test('waits for Hypeddit to accept the address before the next step', async () => {
		const { filename, emailSlideOnDonation } = await run(true);
		expect(filename).toBe('track.mp3');
		expect(emailSlideOnDonation).toContain('move-left');
	}, 30_000);

	test('reports an address Hypeddit rejects instead of clicking the covered next step', async () => {
		await expect(run(false)).rejects.toThrow(
			'Hypeddit rejected the email step (Please enter a valid email address.)',
		);
	}, 30_000);
});
