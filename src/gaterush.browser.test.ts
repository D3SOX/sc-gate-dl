import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { GaterushDownloader } from './gaterush';
import Selectors from './selectors';

// Replays the redesigned gate's DOM and delayed step replacement without
// submitting personal data or performing social actions against live services.
const fixture = (steps: string[], rejectEmail = false) => `
<div id="cookieModal" hidden>
  <input id="cookieAdToggle" type="checkbox" checked>
  <button id="cookieRejectAll">Reject all</button>
</div>
<div id="stepStage"></div>
<button id="download" disabled>Locked</button>
<script>
  const steps = ${JSON.stringify(steps)};
  let index = 0;
  const stage = document.querySelector('#stepStage');
  const modal = document.querySelector('#cookieModal');
  modal.hidden = localStorage.getItem('rejected') === 'true';
  document.querySelector('#cookieRejectAll').onclick = () => {
    localStorage.setItem('rejected', 'true');
    location.reload();
  };
  function advance() {
    stage.firstElementChild.classList.add('leaving');
    index++;
    setTimeout(render, 280);
  }
  function render() {
    if (index === steps.length) {
      stage.innerHTML = '<div class="step">All set</div>';
      document.querySelector('#download').disabled = false;
      return;
    }
    const step = steps[index];
    const content = {
      email: '<input id="nameInput"><input id="emailInput"><button data-go>Save &amp; continue</button>',
      soundcloud: '<input id="commentInput"><button class="btn-soundcloud" data-go>Connect SoundCloud</button>',
      instagram: '<button class="list-btn svc-instagram">Follow</button><button class="list-btn svc-instagram">Follow</button>',
      'instagram-visit': '<button class="list-btn svc-instagram">Open Instagram</button><button class="list-btn svc-instagram">Open Instagram</button>',
      'instagram-confirm': '<button class="list-btn svc-instagram">Follow</button><button class="list-btn svc-instagram">Follow</button>',
      'instagram-pair': '<div class="follow-pair"><button class="btn-instagram" data-open>Open Instagram</button><button data-confirm disabled>I followed</button></div>',
      'instagram-empty': '<button class="btn-instagram" data-open>Open Instagram</button><button data-confirm disabled>I followed</button>',
      'instagram-required': '<button class="btn-instagram" data-open>Open Instagram</button><button data-confirm disabled>I followed</button>'
    }[step];
    const optionalInstagram = step === 'instagram' || step === 'instagram-empty';
    stage.innerHTML = '<div class="step"><h2 class="step-title">' + step + '</h2><div data-body>' + content + '</div>' + (optionalInstagram ? '<button data-skip>Skip this step</button>' : '') + '</div>';
    if (optionalInstagram) stage.querySelector('[data-skip]').onclick = advance;
    if (step === 'instagram-confirm') {
      for (const button of stage.querySelectorAll('.list-btn')) {
        button.onclick = () => {
          window.open('about:blank#instagram-visit');
          button.disabled = true;
          setTimeout(() => { button.disabled = false; button.textContent = 'Done'; }, 100);
          button.onclick = () => {
            if (button.disabled) throw new Error('Confirmed before publisher wait');
            button.classList.add('done');
            button.disabled = true;
            if (!stage.querySelector('.list-btn:not(.done)')) advance();
          };
        };
      }
    } else if (step === 'instagram-pair') {
      const open = stage.querySelector('[data-open]');
      const confirm = stage.querySelector('[data-confirm]');
      open.onclick = () => {
        window.open('about:blank#instagram-visit');
        open.disabled = true;
        open.classList.add('done');
        setTimeout(() => { confirm.disabled = false; }, 100);
      };
      confirm.onclick = () => {
        if (confirm.disabled) throw new Error('Confirmed before publisher wait');
        advance();
      };
    } else if (step === 'instagram-visit') {
      for (const button of stage.querySelectorAll('.list-btn')) {
        button.onclick = () => {
          const popup = window.open('about:blank#instagram-visit');
          document.body.dataset.visits = String(Number(document.body.dataset.visits || 0) + 1);
          const timer = setInterval(() => {
            if (!popup || !popup.closed) return;
            clearInterval(timer);
            button.classList.add('done');
            button.disabled = true;
            if (!stage.querySelector('.list-btn:not(.done)')) advance();
          }, 20);
        };
      }
    } else if (step === 'instagram-empty' || step === 'instagram-required') {
      stage.querySelector('[data-open]').onclick = () => {
        document.body.dataset.profileOpened = 'true';
        stage.querySelector('[data-confirm]').disabled = false;
      };
      stage.querySelector('[data-confirm]').onclick = advance;
    } else if (step === 'instagram') {
      for (const button of stage.querySelectorAll('.list-btn')) {
        button.onclick = () => {
          if (button.classList.contains('done')) throw new Error('Repeated Instagram follow');
          button.classList.add('done');
          button.innerHTML = '<svg></svg>';
          window.open('about:blank#instagram');
          if (!stage.querySelector('.list-btn:not(.done)')) setTimeout(advance, 50);
        };
      }
    } else {
      stage.querySelector('button').onclick = () => {
        if (!modal.hidden) throw new Error('Cookie banner still open');
        if (step === 'email') {
          if (document.querySelector('#nameInput').value !== 'Test Listener' ||
              document.querySelector('#emailInput').value !== 'listener@example.com') return;
          if (${rejectEmail}) return;
        } else if (document.querySelector('#commentInput').value !== 'Test comment') return;
        stage.querySelector('button').disabled = true;
        setTimeout(advance, 50);
      };
    }
  }
  document.querySelector('#download').onclick = () => document.body.dataset.downloaded = 'true';
  setTimeout(render, 50);
</script>`;

describe('GateRush redesigned gate', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function runGate(
		steps: string[],
		rejectEmail = false,
		missEmailClick = false,
	) {
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		const unrelated = await context.newPage();
		await unrelated.goto('about:blank#instagram-existing');
		await page.bringToFront();
		const waitForFunction = page.waitForFunction.bind(page);
		spyOn(page, 'waitForFunction').mockImplementation((fn, options, ...args) =>
			waitForFunction(
				fn,
				options?.timeout === 120_000 ? { ...options, timeout: 1_500 } : options,
				...args,
			),
		);
		const click = page.click.bind(page);
		if (missEmailClick) {
			spyOn(page, 'click').mockImplementation(async (selector, options) => {
				if (selector === Selectors.GATERUSH_EMAIL_SUBMIT) {
					await page.$eval('#stepStage', (el) => (el as HTMLElement).click());
					return;
				}
				await click(selector, options);
			});
		}
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			void request.respond({
				status: 200,
				contentType: 'text/html',
				body: fixture(steps, rejectEmail),
			});
		});
		const downloader = new GaterushDownloader({
			browserMode: 'headless',
			name: 'Test Listener',
			email: 'listener@example.com',
			comment: 'Test comment',
		});
		let downloaded = false;
		let alerted = false;
		downloader.setProgressCallback((_stage, _message, _percent, extra) => {
			if (!extra?.requiresAttention) return;
			alerted = true;
			if (steps.includes('instagram-visit')) return;
			void (async () => {
				expect(
					await page.evaluate(() => document.body.dataset.profileOpened),
				).toBe('true');
				// Emulate a user's ordinary actions on this local fixture only.
				await page.click('[data-confirm]');
			})();
		});
		Object.assign(downloader, {
			browser: {
				newPage: async () => page,
				pages: () => context.pages(),
			},
			handleDownload: async (gate: Page) => {
				expect(
					await gate.$eval('#cookieModal', (el) => el.hasAttribute('hidden')),
				).toBeTrue();
				await gate.click('#download');
				downloaded = await gate.evaluate(
					() => document.body.dataset.downloaded === 'true',
				);
			},
		});
		try {
			await downloader.downloadAudio('https://gaterush.me/fixture');
			expect(downloaded).toBeTrue();
			expect(unrelated.isClosed()).toBeFalse();
			expect(alerted).toBe(steps.includes('instagram-required'));
			if (steps.includes('instagram-visit')) {
				const pages = await context.pages();
				expect(
					pages.every((p) => !p.url().includes('#instagram-visit')),
				).toBeTrue();
			}
		} finally {
			await context.close();
		}
	}

	test('rejects cookies, waits for reload, and completes successive steps', async () => {
		await runGate(['email', 'soundcloud', 'instagram']);
	}, 15_000);

	test('handles the order chosen by the gate and optional steps', async () => {
		await runGate(['instagram', 'soundcloud', 'email']);
		await runGate(['instagram-empty']);
		await runGate([]);
	}, 15_000);

	test('reports email validation failure without advancing', async () => {
		await expect(runGate(['email'], true)).rejects.toThrow(
			'GateRush email step did not complete',
		);
	}, 15_000);

	test('submits email when the humanized pointer would miss the button', async () => {
		await runGate(['email'], false, true);
	}, 15_000);

	test('retains attention when the popup cannot open and resumes after the user advances', async () => {
		await runGate(['instagram-required']);
	}, 15_000);

	test('opens and closes each visit-only Instagram popup without asking for attention', async () => {
		await runGate(['instagram-visit', 'instagram-visit']);
	}, 15_000);

	test('uses the delayed Done control after visiting each Instagram account', async () => {
		await runGate(['instagram-confirm', 'instagram-pair']);
	}, 15_000);
});
