import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, BrowserContext, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { HypedditDownloader } from './hypeddit';

// Trimmed from live gates (djmanjit/tangledjourneyfreedownloadviahypeddit,
// itsnudge/tinashenastynajclubedit) with the page's jumpGate(), skipper and
// slide logic reduced to plain DOM code.
const twitterButtons = `
<div class="hype-sidebar-step-form " id="step_tw">
  <span id ="twitter_status">
    <a class="hype-btn hype-btn-social undone" href="javascript:void(0);" onclick="popup('x');$(this).removeClass('undone');">Follow first</a>
    <a class="hype-btn hype-btn-social undone" href="javascript:void(0);" onclick="popup('x');">Follow second</a>
  </span>
  <button type="button" id="skipper_tw_channel">Next</button>
  <button type="button" data-step="tw" id="skipper_tw_next" class="hide">Next</button>
</div>`;
const twitterOauth = `
<div class="hype-sidebar-step-form " id="step_tw">
  <a href="javascript:void(0)" onclick="popup('x-oauth');" id="login_to_tw" data-type="twitterweb">Connect with X</a>
</div>`;

function gatePage(twitter: string) {
	return `
<style>.hide { display: none; } .move-left { opacity: 0; }</style>
<button id="downloadProcess" onclick="document.querySelector('#all_steps').classList.remove('hide')">Download</button>
<input type="hidden" name="is_skippable" id="is_skippable" value="0"/>
<div class="carousel-inner all_steps hide" id="all_steps">
  <div class="tw fangate-slider-content current-slide" data-group="1">${twitter}</div>
  <div class="bc|ig fangate-slider-content upcomming-slide" data-group="2">
    <a href="javascript:void(0)" class="step_button_2" data-group="2" onclick="jumpGate(this,'bc');">Bandcamp</a>
    <div class="hype-sidebar-step-form hide" id="step_bc">
      <span id ="bandcamp_status"><a class="undone" onclick="popup('bc');">Follow on Bandcamp</a></span>
      <button type="button" data-step="bc" id="skipper_bc_next" class="hide">Next</button>
    </div>
    <a href="javascript:void(0)" class="step_button_2" data-group="2" onclick="jumpGate(this,'ig');">Instagram</a>
    <div class="hype-sidebar-step-form hide" id="step_ig">
      <span id ="instagram_status"><a class="hype-btn-instagram undone" onclick="popup('ig');$(this).removeClass('undone');">Follow on Instagram</a></span>
      <button type="button" id="skipper_ig_channel">Next</button>
      <button type="button" data-step="ig" id="skipper_ig_next" class="hide">Next</button>
    </div>
  </div>
  <div class="dn fangate-slider-content upcomming-slide" data-group="3">
    <a href="javascript:void(0)" class="step_button_3 hide" data-group="3" onclick="jumpGate(this,'dn');">Donate to artist</a>
    <div class="hype-sidebar-step-form " id="step_dn">
      <a href="javascript:void(0)" onclick="jumpGateDonation(this,'dn');">Donate to artist</a>
      <div class="hype-siderbar-connect-text">
        <a href="javascript:void(0)" class="hype-connect-link myCarouselSocialSection">Skip donation</a>.
      </div>
    </div>
    <div class="hype-sidebar-step-form hide" id="step_dn_option">
      <a href="javascript:void(0)" id="skipper_dn" data-step="donation" class="hype-connect-link">Skip to next step</a>
    </div>
  </div>
  <div class="dw fangate-slider-content upcomming-slide" data-group="1000">
    <a href="javascript:void(0);" id="gateDownloadButton" data-type="gate">Download</a>
  </div>
</div>
<script>
  const $ = (el) => ({ removeClass: (name) => el.classList.remove(name) });
  const steps = 'dw,tw,bc|ig,dn'.split(',');
  const skipped = (step) => {
    const input = document.createElement('input');
    Object.assign(input, { type: 'hidden', name: 'skip_gate_steps[]', value: step });
    document.querySelector('#is_skippable').after(input);
  };
  function popup(name) { window.open('about:blank#' + name + '-visit', name + '_popup', 'width=500,height=500'); }
  function gateNextSlide(obj) {
    const slide = obj.closest('.fangate-slider-content');
    slide.classList.add('move-left');
    slide.nextElementSibling?.classList.remove('upcomming-slide');
  }
  function rX5mPQjW7s(id) { gateNextSlide(document.getElementById(id)); }
  function jumpGate(obj, type) {
    const group = obj.dataset.group;
    for (const step of steps[group].split('|')) if (step !== type) skipped(step);
    for (const button of document.querySelectorAll('.step_button_' + group)) button.classList.add('hide');
    document.querySelector('#step_' + type).classList.remove('hide');
  }
  function jumpGateDonation() {
    document.querySelector('#step_dn').classList.add('hide');
    document.querySelector('#step_dn_option').classList.remove('hide');
  }
  for (const platform of ['twitter', 'instagram']) {
    const short = platform === 'twitter' ? 'tw' : 'ig';
    for (const link of document.querySelectorAll('#' + platform + '_status a'))
      link.addEventListener('click', () => {
        link.classList.remove('undone');
        if (!document.querySelector('#' + platform + '_status a.undone')) {
          document.querySelector('#skipper_' + short + '_channel').classList.add('hide');
          document.querySelector('#skipper_' + short + '_next').classList.remove('hide');
        }
      });
  }
  for (const skipper of document.querySelectorAll('#skipper_tw_next, #skipper_ig_next, #skipper_bc_next, #skipper_dn'))
    skipper.addEventListener('click', () => { gateNextSlide(skipper); skipped(skipper.dataset.step); });
  for (const next of document.querySelectorAll('.myCarouselSocialSection'))
    next.addEventListener('click', () => gateNextSlide(next));
</script>`;
}

describe('Hypeddit X, either-or and donation steps', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function runGate(
		context: BrowserContext,
		twitter: string,
		onAttention: (page: Page) => Promise<void> = async () => {},
	) {
		const page = await context.newPage();
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			void request.respond({
				status: 200,
				contentType: 'text/html',
				body: gatePage(twitter),
			});
		});
		const downloader = new HypedditDownloader({
			browserMode: 'headless',
			comment: '',
		});
		const attention: string[] = [];
		downloader.setProgressCallback((_stage, _message, _percent, extra) => {
			if (!extra?.requiresAttention) return;
			attention.push(String(extra.currentGate));
			void onAttention(page);
		});
		const result: {
			finished?: { skipped: string[]; slides: string[] };
		} = {};
		Object.assign(downloader, {
			browser: { newPage: async () => page },
			handleDownloadSlide: async (gate: Page) => {
				result.finished = await gate.evaluate(() => ({
					skipped: Array.from(
						document.querySelectorAll<HTMLInputElement>(
							'input[name="skip_gate_steps[]"]',
						),
						(input) => input.value,
					),
					slides: Array.from(
						document.querySelectorAll('.move-left'),
						(slide) => slide.classList.item(0) ?? '',
					),
				}));
				Object.assign(downloader, { downloadFilename: 'track.mp3' });
			},
		});
		const filename = await downloader.downloadAudio(
			'https://hypeddit.com/fixture',
		);
		return { filename, attention, finished: result.finished };
	}

	test('visits X accounts, picks Instagram over Bandcamp and skips the donation', async () => {
		const context = await browser.createBrowserContext();
		try {
			const { filename, attention, finished } = await runGate(
				context,
				twitterButtons,
			);
			expect(filename).toBe('track.mp3');
			expect(attention).toEqual([]);
			// What the page itself would now send in skip_gate_steps[] (each
			// input is inserted right after #is_skippable, so newest first).
			expect(finished).toEqual({
				skipped: ['ig', 'bc', 'tw'],
				slides: ['tw', 'bc|ig', 'dn'],
			});
			expect(
				(await context.pages()).some((p) => p.url().includes('-visit')),
			).toBeFalse();
		} finally {
			await context.close();
		}
	}, 30_000);

	test('an X OAuth step asks for the remote browser and continues once the slide moves on', async () => {
		const context = await browser.createBrowserContext();
		try {
			const { filename, attention, finished } = await runGate(
				context,
				twitterOauth,
				// The page's OAuth callback advances the slide via rX5mPQjW7s().
				(page) => page.evaluate(() => rX5mPQjW7s('login_to_tw')),
			);
			expect(filename).toBe('track.mp3');
			expect(attention).toEqual(['tw']);
			expect(finished?.slides).toEqual(['tw', 'bc|ig', 'dn']);
		} finally {
			await context.close();
		}
	}, 30_000);
});

declare function rX5mPQjW7s(id: string): void;
