import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { DroploudDownloader } from './droploud';
import Selectors from './selectors';

// Replays the redesigned (v2 "dltg") gate markup and its fading step stage
// without submitting data to Droploud or performing social actions. Popups
// open about:blank URLs, so nothing leaves the machine.
const fixture = (
	steps: string[],
	rejectEmail = false,
	hydrateDelay = 1_200,
) => `
<div class="dltg-root">
  <div class="dligb-root"><button type="button" class="dligb-follow ds-btn ds-solid">Follow</button></div>
  <div class="dltg-stage is-vis" aria-live="polite"></div>
</div>
<div role="dialog" class="dw-cookie-shell"><div class="ds-panel dw-cookie-card">
  <div class="dw-cookie-actions">
    <button type="button" class="ds-btn ds-sm">Reject non-essential</button>
    <button type="button" class="ds-btn ds-sm dw-cookie-save">Save preferences</button>
    <button type="button" class="ds-btn ds-sm">Accept all</button>
  </div>
</div></div>
<script>
  const steps = ${JSON.stringify(steps)};
  const data = document.body.dataset;
  const stage = document.querySelector('.dltg-stage');
  let index = 0;
  let revealed = false;
  let pane = '';
  document.querySelector('.dligb-follow').onclick = () => { data.banner = 'clicked'; };
  for (const button of document.querySelectorAll('.dw-cookie-card button')) {
    button.onclick = () => {
      data.cookies = button.textContent;
      document.querySelector('.dw-cookie-shell').remove();
    };
  }
  const legal = '<p class="ds-gate-legal">By accessing or downloading this content, you agree to our <a href="/terms">Terms of Use</a> and <a href="/dmca">DMCA policy</a>.</p>';
  const card = (inner, lg = true, form = false) =>
    '<section class="ds-panel ds-gate-card' + (lg ? ' ds-lg' : '') + '" aria-labelledby="dltg-card-t">' +
    (form ? '<form class="ds-gate-pane ds-fields-c ds-val-c" novalidate>' : '<div class="ds-gate-pane">') +
    inner + (form ? '</form>' : '</div>') + '</section>';
  const title = (text) => '<h2 class="ds-gate-t" id="dltg-card-t" tabindex="-1">' + text + '</h2>';
  const honor = {
    instagram: { label: 'Follow 2 accounts on Instagram', links: ['@first', '@second'] },
    youtube: { label: 'Subscribe on YouTube', links: ['@channel'] },
  };
  function view() {
    const step = steps[index];
    if (step === 'email') {
      return card('<span class="ds-glyph ds-up"></span><h2 class="ds-gate-t" id="dltg-card-t">Free download</h2>' +
        '<p class="ds-gate-sub">Grab the file in just ' + steps.length + ' quick steps.</p>' +
        '<div class="ds-field ds-f38"><label for="dltg-email">Your email</label><input id="dltg-email" class="ds-input" type="email" name="email" placeholder="your@email.com" value=""></div>' +
        '<label class="ds-check ds-c18"><input type="checkbox" required name="consent"><span class="ds-box"></span><span>I agree to receive emails. <a href="/privacy">Privacy policy</a></span></label>' +
        '<p class="ds-gate-hint" role="status" hidden>Tick the box to continue</p>' +
        '<button type="submit" class="ds-btn ds-h40 ds-solid ds-gate-wide" disabled><svg></svg>Free download</button>' + legal, false, true);
    }
    if (!revealed) {
      return card('<span class="ds-glyph ds-up"></span><h2 class="ds-gate-t" id="dltg-card-t">Free download</h2>' +
        '<p class="ds-gate-sub">Grab the file in just ' + steps.length + ' quick steps.</p>' +
        '<button type="button" class="ds-btn ds-h40 ds-solid ds-gate-wide"><svg></svg>Free download</button>' + legal, false);
    }
    if (index >= steps.length) {
      return card('<span class="ds-glyph ds-up"></span>' + title('Download unlocked') +
        '<button type="button" class="ds-btn ds-h40 ds-solid ds-gate-wide"><svg></svg>Download</button>' + legal, false);
    }
    if (honor[step]) {
      const rows = honor[step].links.map((name) =>
        '<li class="ds-honor-row"><span class="ds-icon-disc" aria-hidden="true"></span><span class="ds-honor-n">' +
        '<a href="https://example.invalid/' + step + '/' + name + '" target="_blank" rel="noopener noreferrer" title="' + name + '">' + name + '</a>' +
        '<span class="ds-honor-st"><span class="ds-sr-only">' + name + ' </span>To do</span></span>' +
        '<span class="ds-honor-act"><button type="button" class="ds-btn ds-h32">Open<span class="ds-sr-only"> ' + name + '</span><svg></svg></button></span></li>').join('');
      return card(title(honor[step].label) +
        '<p class="ds-gate-sub" id="dltg-honor-sub-' + step + '">Open each link, complete the action, then press I\\'ve done it.</p>' +
        '<ul class="ds-honor-list">' + rows + '</ul>' +
        '<button type="button" class="ds-btn ds-h40 ds-gate-wide ds-disabled" data-honor-go aria-disabled="true"><svg></svg>I\\'ve done it</button>');
    }
    if (step === 'droploud_follow') {
      return card(title('Follow Artist on Droploud') + '<div class="dtr-dlfollow-wrap">' +
        '<p class="dtr-dlfollow-copy">Follow Artist on Droploud so their next release lands in your feed. Recommended. You can skip.</p>' +
        '<button class="ds-btn ds-solid" data-follow>Open Artist\\'s profile</button>' +
        '<button class="ds-btn dtr-dlfollow-skip">I\\'m done, continue</button></div>');
    }
    if (step === 'soundcloud') {
      return card(title('Connect SoundCloud') +
        '<div class="ds-field ds-f38"><label for="dltg-sc-comment">Your comment</label><input id="dltg-sc-comment" class="ds-input" type="text" name="comment" maxlength="280" placeholder="Type your comment" value=""></div>' +
        '<div class="dltg-sc-start"><button type="button" class="ds-btn ds-h40 ds-sc-btn" disabled title="Type your comment first">Connect with<img class="ds-connect-logo ds-sc" alt="SoundCloud" width="376" height="94"></button>' +
        '<div class="ds-field"><span class="ds-hint" aria-label="Actions performed on your behalf"><span>Follow @artist and Droploud on SoundCloud</span></span></div></div>');
    }
    if (step === 'connected') {
      return card('<span class="ds-glyph ds-up"></span>' + title('SoundCloud connected') + '<p class="ds-gate-sub">@listener · repost and like are next</p>', false);
    }
    if (step === 'repost') {
      return card(title('Repost the track') + '<p class="ds-gate-sub">It is on the SoundCloud track page.</p>' +
        '<ol class="dltg-sc-rows" role="list"><li class="ds-task ds-d31"><span class="ds-task-txt"><span class="ds-task-name"><span class="ds-task-n">1 · </span>Tap Repost</span></span></li>' +
        '<li class="ds-task ds-d31"><span class="ds-task-txt"><span class="ds-task-name"><span class="ds-task-n">2 · </span>Come back here and tap Verify</span></span></li></ol>' +
        '<button type="button" class="ds-btn ds-h40 ds-solid ds-gate-wide" data-open-track>Open track on SoundCloud<svg></svg></button>' +
        '<div class="ds-field"><span class="ds-hint">Already reposted or liked? Leave them on, tapping again removes them.</span></div>');
    }
    throw new Error('Unknown fixture step ' + step);
  }
  function advance(delay = 50) {
    setTimeout(() => { index++; render(); }, delay);
  }
  function render(initial = false) {
    const next = view();
    if (next === pane) return;
    pane = next;
    const swap = () => {
      stage.innerHTML = next;
      hydrate();
    };
    // The first pane is server-rendered and only reacts once "hydrated".
    if (initial) {
      stage.innerHTML = next;
      return setTimeout(hydrate, ${hydrateDelay});
    }
    // Droploud fades the stage out for 210 ms before showing the next step.
    stage.classList.remove('is-vis');
    setTimeout(swap, 210);
  }
  // Emulates React hydration: handlers attach, controlled fields snap back to
  // React's state (typed text is lost, a pre-ticked box stays ticked in the
  // DOM while React still holds false), and elements gain __reactProps$ keys.
  function hydrate() {
    const email = stage.querySelector('#dltg-email');
    if (email) email.value = '';
    for (const el of stage.querySelectorAll('button, input')) {
      el['__reactProps$fixture'] = el.type === 'checkbox' ? { checked: false } : el.tagName === 'INPUT' ? { value: el.value } : {};
    }
    bind();
    stage.classList.add('is-vis');
  }
  function bind() {
    const step = steps[index];
    const primary = stage.querySelector('.ds-gate-wide');
    if (step === 'email') {
      const form = stage.querySelector('form');
      const email = stage.querySelector('#dltg-email');
      const consent = stage.querySelector('input[name="consent"]');
      const sync = () => {
        email['__reactProps$fixture'].value = email.value;
        consent['__reactProps$fixture'].checked = consent.checked;
        primary.disabled = !(/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(email.value.trim()) && consent.checked);
      };
      email.addEventListener('input', sync);
      consent.addEventListener('change', sync);
      form.onsubmit = (event) => {
        event.preventDefault();
        if (primary.disabled) throw new Error('Submitted a locked email form');
        data.email = email.value;
        if (${rejectEmail}) {
          email.insertAdjacentHTML('afterend', '<span class="ds-err" id="dltg-email-e" role="alert">Enter a valid email address.</span>');
          return;
        }
        primary.disabled = true;
        primary.textContent = 'Starting your download…';
        revealed = true;
        advance(80);
      };
    } else if (!revealed) {
      primary.onclick = () => { revealed = true; render(); };
    } else if (index >= steps.length) {
      primary.onclick = () => { data.downloaded = 'true'; };
    } else if (honor[step]) {
      const go = stage.querySelector('[data-honor-go]');
      for (const row of stage.querySelectorAll('.ds-honor-row')) {
        row.querySelector('.ds-honor-act button').onclick = (event) => {
          if (!event.isTrusted) throw new Error('Untrusted honor click');
          const popup = window.open('about:blank#honor-' + step, '_blank', 'width=600,height=700');
          if (!popup) { row.className = 'ds-honor-row is-blocked'; return; }
          popup.opener = null;
          data.opened = (data.opened || '') + step + ' ';
          row.className = 'ds-honor-row is-open';
          row.querySelector('.ds-honor-st').lastChild.textContent = 'Opened';
          if (!stage.querySelector('.ds-honor-row:not(.is-open)')) {
            go.removeAttribute('aria-disabled');
            go.className = 'ds-btn ds-h40 ds-gate-wide ds-solid';
          }
        };
      }
      go.onclick = () => {
        if (go.hasAttribute('aria-disabled')) return;
        go.setAttribute('aria-busy', 'true');
        go.textContent = 'Confirming…';
        advance(120);
      };
    } else if (step === 'droploud_follow') {
      stage.querySelector('[data-follow]').onclick = () => { data.followed = 'true'; };
      stage.querySelector('.dtr-dlfollow-skip').onclick = () => advance();
    } else if (step === 'soundcloud') {
      const comment = stage.querySelector('#dltg-sc-comment');
      const connect = stage.querySelector('.ds-sc-btn');
      comment.addEventListener('input', () => { connect.disabled = comment.value.trim().length < 2; });
      connect.onclick = (event) => {
        if (!event.isTrusted) throw new Error('Untrusted connect click');
        data.comment = comment.value;
        const popup = window.open('about:blank#soundcloud.com/connect', 'sc_connect', 'width=600,height=700');
        // Droploud polls its gate status until the OAuth window reports back.
        const timer = setInterval(() => {
          if (!popup.closed) return;
          clearInterval(timer);
          advance(0);
        }, 50);
      };
    } else if (step === 'connected') {
      // Droploud keeps this pane while it settles the repost mode.
      advance(1500);
    } else if (step === 'repost') {
      stage.querySelector('[data-open-track]').onclick = (event) => {
        if (!event.isTrusted) throw new Error('Untrusted repost click');
        window.open('about:blank#soundcloud.com/artist/track', 'dl_sc_repost', 'width=600,height=700');
        stage.querySelector('[data-open-track]').outerHTML =
          '<button type="button" class="ds-btn ds-h40 ds-solid ds-gate-wide" data-verify><svg></svg>Verify</button>' +
          '<button type="button" class="ds-btn ds-h40 ds-gate-wide">Back to SoundCloud</button>' +
          '<button type="button" class="ds-btn ds-h40 ds-gate-wide" data-give-up>Continue anyway</button>';
        stage.querySelector('[data-give-up]').onclick = () => { throw new Error('Gave up on a verifiable repost'); };
        const verify = stage.querySelector('[data-verify]');
        verify.onclick = () => {
          if (verify.getAttribute('aria-disabled') === 'true') return;
          verify.setAttribute('aria-disabled', 'true');
          verify.setAttribute('aria-busy', 'true');
          verify.textContent = 'Checking your repost…';
          data.verified = 'true';
          advance(200);
        };
      };
    }
  }
  render(true);
</script>`;

describe('Droploud redesigned gate', () => {
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
		soundcloudBlocks = false,
	) {
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			void request
				.respond({
					status: 200,
					contentType: 'text/html',
					body: fixture(steps, rejectEmail),
				})
				.catch(() => {});
		});
		const downloader = new DroploudDownloader({
			browserMode: 'headless',
			email: 'listener@example.com',
			comment: 'Test comment',
		});
		const oauthUrls: string[] = [];
		const reposted: string[] = [];
		let state: Record<string, string | undefined> = {};
		Object.assign(downloader, {
			browser: {
				newPage: async () => page,
				pages: () => context.pages(),
			},
			completeSoundcloudOauth: async (oauthPage: Page) => {
				oauthUrls.push(oauthPage.url());
				await oauthPage.close();
			},
			performSoundcloudManualActions: async (
				popup: Page,
				actions: { repost: boolean },
			) => {
				if (actions.repost) reposted.push(popup.url());
				// SoundCloud's anti-bot swaps the track for its block page.
				if (soundcloudBlocks) {
					await popup.setContent('<h1>You have been blocked</h1>');
				}
			},
			handleDownload: async (gate: Page) => {
				await gate.evaluate((selector) => {
					const button = Array.from(
						document.querySelectorAll<HTMLButtonElement>(selector),
					).find((btn) => btn.textContent?.trim() === 'Download');
					button?.click();
				}, Selectors.DROPLOUD_PRIMARY_BUTTON);
				state = await gate.evaluate(() => ({ ...document.body.dataset }));
			},
		});
		try {
			await downloader.downloadAudio('https://droploud.com/track/fixture');
			const popups = (await context.pages()).filter((p) => p !== page);
			return { state, oauthUrls, reposted, popups: popups.length };
		} finally {
			// Disposing a context that still holds an intercepting page can fail.
			if (!page.isClosed()) await page.close();
			await context.close();
		}
	}

	test('completes email, link, Droploud follow and SoundCloud steps, then downloads', async () => {
		const result = await runGate([
			'email',
			'instagram',
			'youtube',
			'droploud_follow',
			'soundcloud',
			'connected',
			'repost',
		]);
		expect(result.state).toMatchObject({
			cookies: 'Reject non-essential',
			email: 'listener@example.com',
			opened: 'instagram instagram youtube ',
			comment: 'Test comment',
			verified: 'true',
			downloaded: 'true',
		});
		// Optional Droploud follow is skipped; the promo banner stays untouched.
		expect(result.state.followed).toBeUndefined();
		expect(result.state.banner).toBeUndefined();
		expect(result.oauthUrls).toEqual(['about:blank#soundcloud.com/connect']);
		expect(result.reposted).toEqual([
			'about:blank#soundcloud.com/artist/track',
		]);
		expect(result.popups).toBe(0);
	}, 45_000);

	test('opens a gate without an email step from its Free download pane', async () => {
		const result = await runGate(['soundcloud', 'droploud_follow']);
		expect(result.state).toMatchObject({
			comment: 'Test comment',
			downloaded: 'true',
		});
		expect(result.state.email).toBeUndefined();
	}, 30_000);

	test('downloads right away when the gate is already unlocked', async () => {
		const result = await runGate([]);
		expect(result.state.downloaded).toBe('true');
	}, 30_000);

	test('reports the email error Droploud shows', async () => {
		await expect(runGate(['email', 'droploud_follow'], true)).rejects.toThrow(
			'Droploud rejected the email: Enter a valid email address.',
		);
	}, 30_000);

	test('fails fast when SoundCloud blocks the repost', async () => {
		const started = Date.now();
		await expect(
			runGate(['soundcloud', 'connected', 'repost'], false, true),
		).rejects.toThrow('SoundCloud blocked this browser or network');
		// No minutes-long wait for a repost Droploud can never see.
		expect(Date.now() - started).toBeLessThan(20_000);
	}, 30_000);
});

// Logged-in SoundCloud renders the track UI in a same-origin "webi" iframe
// (markup as seen live); the top document only has the header and player.
const soundcloudTop = (blocked = false) => `
<header><a href="/you/library">Library</a></header>
<iframe class="webiIframe webiIframeV2Layout playerVisible" id="__WEBI_IFRAME_PRELOADED__" title="SoundCloud"
  src="https://soundcloud.com/n/artist/track?crossfade=true&v2_layout=true&embedded=crossfade${blocked ? '&blocked=1' : ''}"></iframe>
<div class="playControls"><button aria-label="Like">Like</button></div>`;
const soundcloudWebi = `
<div class="MuiBox-root" title="Repost"><button class="MuiButtonBase-root MuiIconButton-root MuiIconButton-sizeMedium" aria-label="Repost"><svg></svg></button></div>
<a aria-label="See all reposts" class="MuiLink-root">341<span>Reposts</span></a>
<script>
  const button = document.querySelector('button[aria-label="Repost"]');
  button.onclick = () => {
    document.body.dataset.reposted = 'true';
    button.setAttribute('aria-label', 'Unpost / Edit repost');
    button.parentElement.title = 'Unpost / Edit repost';
  };
</script>`;

describe('Droploud SoundCloud track page', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function openTrack(blocked = false) {
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const url = new URL(request.url());
			const body = url.pathname.startsWith('/n/')
				? url.searchParams.has('blocked')
					? '<h1>You have been blocked</h1><p>We detected unusual activity from your device or network.</p>'
					: soundcloudWebi
				: soundcloudTop(blocked);
			void request
				.respond({ status: 200, contentType: 'text/html', body })
				.catch(() => {});
		});
		await page.goto('https://soundcloud.com/artist/track', {
			waitUntil: 'networkidle0',
		});
		const downloader = new DroploudDownloader({
			browserMode: 'headless',
			comment: '',
		}) as unknown as {
			tryClickRepostButton: (page: Page) => Promise<string>;
			pageLooksReposted: (page: Page) => Promise<boolean>;
			soundcloudBlocked: (page: Page) => Promise<boolean>;
		};
		return { context, page, downloader };
	}

	test('finds and clicks Repost inside the webi iframe', async () => {
		const { context, page, downloader } = await openTrack();
		try {
			expect(await downloader.soundcloudBlocked(page)).toBeFalse();
			expect(await downloader.pageLooksReposted(page)).toBeFalse();
			expect(await downloader.tryClickRepostButton(page)).toBe('clicked');
			const frame = page.frames().find((f) => f.url().includes('/n/'));
			expect(await frame?.evaluate(() => document.body.dataset.reposted)).toBe(
				'true',
			);
			expect(await downloader.pageLooksReposted(page)).toBeTrue();
			expect(await downloader.tryClickRepostButton(page)).toBe('already');
		} finally {
			await page.close();
			await context.close();
		}
	}, 30_000);

	test('recognizes the anti-bot block page inside the iframe', async () => {
		const { context, page, downloader } = await openTrack(true);
		try {
			expect(await downloader.soundcloudBlocked(page)).toBeTrue();
		} finally {
			await page.close();
			await context.close();
		}
	}, 30_000);
});
