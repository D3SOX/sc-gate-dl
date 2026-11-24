import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { DownloadgaterDownloader } from './downloadgater';

// Replays GatePage's step markup (captured from live gates) and its
// sessionStorage progress without contacting DownloadGater, Spotify or YouTube.
const fixture = (steps: string[], rejectEmail: boolean) => `
<div id="root"></div>
<script>
  const steps = ${JSON.stringify(steps)};
  const root = document.querySelector('#root');
  const key = (name) => 'downloadgater.' + name + '.fixture';
  const read = (name) => JSON.parse(sessionStorage.getItem(key(name)) || '{}');
  const url = new URL(location.href);
  if (url.searchParams.has('spotify_unlock')) {
    sessionStorage.setItem(key('spotifyUnlock'), url.searchParams.get('spotify_unlock'));
  }
  url.searchParams.delete('spotify_unlock');
  url.searchParams.delete('spotify_error');
  history.replaceState({}, '', url.pathname + url.search);

  function complete(step) {
    const done = read('done');
    done[step] = true;
    sessionStorage.setItem(key('done'), JSON.stringify(done));
    render();
  }
  function heading(kicker, label, platform, platformLabel, verb) {
    return '<div class="gate-flow-heading"><span class="gate-icon"><svg></svg></span><div>' +
      '<p class="gate-flow-kicker">' + kicker + '</p><h2 id="gate-flow-title">' +
      '<span aria-label="' + label + '" class="gate-action-wordmark" data-gate-platform="' + platform + '">' +
      '<strong class="gate-action-platform">' + platformLabel + '</strong> <span class="gate-action-verb">' + verb + '</span></span>' +
      '</h2><p>Step description.</p></div></div>';
  }
  function section(html) {
    root.innerHTML = '<section class="gate-flow" aria-labelledby="gate-flow-title">' + html + '</section>';
  }
  function render() {
    if (sessionStorage.getItem(key('downloadRequested')) !== '1') {
      root.innerHTML = '<div class="gate-start-actions"><h2>Free download</h2><button class="download-button" type="button"><svg></svg><span>Free download</span></button></div>';
      root.querySelector('button').onclick = () => {
        sessionStorage.setItem(key('downloadRequested'), '1');
        render();
      };
      return;
    }
    const done = read('done');
    const step = steps.find((s) => s === 'spotify-oauth' ? !sessionStorage.getItem(key('spotifyUnlock')) : !done[s]);
    if (!step) {
      section('<div class="gate-flow-complete"><h2 id="gate-flow-title">Thank you for your support!</h2><button class="download-button" type="button"><svg></svg><span>Download file</span></button></div>');
      root.querySelector('button').onclick = () => { document.body.dataset.downloaded = 'true'; };
      return;
    }
    if (step === 'email') {
      section(heading('Unlock step', 'Email capture', 'email', 'Email', 'Submit') +
        '<div class="email-capture-row"><input inputmode="email" placeholder="you@example.com" type="email" value=""><button disabled type="button">Next</button></div>');
      const input = root.querySelector('input');
      const next = root.querySelector('.email-capture-row button');
      input.addEventListener('input', () => { next.disabled = !/^[^@]+@[^@]+\\.[^@]+$/.test(input.value); });
      next.onclick = () => {
        next.disabled = true;
        input.disabled = true;
        next.textContent = 'Saving...';
        setTimeout(() => {
          if (${rejectEmail}) {
            next.disabled = false;
            input.disabled = false;
            next.textContent = 'Next';
            root.querySelector('section').insertAdjacentHTML('beforeend', '<p class="download-error">Could not capture this email. Try again.</p>');
            return;
          }
          sessionStorage.setItem(key('email'), input.value);
          complete('email');
        }, 50);
      };
    } else if (step === 'spotify-oauth') {
      section(heading('Verified unlock', 'Connect Spotify', 'spotify', 'Spotify', 'Connect') +
        '<div class="soundcloud-action-list spotify-action-list" aria-label="Spotify unlock actions"><span><svg></svg>Follow the Spotify profile</span><span><svg></svg>Follow the Spotify playlist</span></div>' +
        '<div class="gate-flow-actions"><button type="button"><svg></svg><span>Connect &amp; Follow on Spotify</span></button></div>' +
        '<p class="gate-flow-status">This uses official Spotify OAuth. We never see your Spotify password.</p>');
      const connect = root.querySelector('.gate-flow-actions button');
      connect.onclick = () => {
        connect.disabled = true;
        connect.querySelector('span').textContent = 'Connecting...';
        // /api/spotify/start answers with the authorization URL.
        setTimeout(() => location.assign('https://accounts.spotify.com/authorize?client_id=fixture'), 50);
      };
    } else if (step === 'youtube') {
      section(heading('Unlock step', 'YouTube Subscribe', 'youtube', 'YouTube', 'Subscribe') +
        '<div class="gate-flow-actions"><button data-gate-key="youtubeSubscribe" data-target-url="https://youtube.com/@fixture" type="button"><svg></svg><span>Subscribe on YouTube</span></button>' +
        '<button class="gate-confirm-action" disabled type="button"><svg></svg><span>I subscribed</span></button></div>' +
        '<p aria-live="polite" class="gate-flow-status">The confirmation button appears after this page opens.</p>');
      const open = root.querySelector('[data-gate-key]');
      const confirm = root.querySelector('.gate-confirm-action');
      open.onclick = () => {
        // The real target is the channel; the hash keeps the popup offline.
        window.open('about:blank#youtube.com/@fixture', '_blank', 'noopener,noreferrer');
        confirm.disabled = false;
      };
      confirm.onclick = () => complete('youtube');
    } else if (step === 'spotify-visit') {
      const targets = ['a', 'b'];
      const opened = new Set();
      const label = () => opened.size < targets.length
        ? 'Follow Spotify — ' + (opened.size + 1) + ' of ' + targets.length
        : 'Follow on Spotify';
      section(heading('Unlock step', 'Spotify Follow', 'spotify', 'Spotify', 'Follow') +
        '<div class="gate-flow-actions"><button data-gate-key="spotifyFollow" type="button"><svg></svg><span></span></button>' +
        '<button class="gate-confirm-action" disabled type="button"><svg></svg><span>I followed</span></button></div>');
      const open = root.querySelector('[data-gate-key]');
      const confirm = root.querySelector('.gate-confirm-action');
      open.querySelector('span').textContent = label();
      open.onclick = () => {
        window.open('about:blank#open.spotify.com/artist/' + targets[Math.min(opened.size, targets.length - 1)], '_blank', 'noopener,noreferrer');
        opened.add(targets[Math.min(opened.size, targets.length - 1)]);
        open.querySelector('span').textContent = label();
        confirm.disabled = opened.size < targets.length;
      };
      confirm.onclick = () => complete('spotify-visit');
    }
  }
  setTimeout(render, 50);
</script>`;

const SPOTIFY_CONSENT = `
<button data-testid="auth-accept">Agree</button>
<script>
  document.querySelector('button').onclick = () =>
    location.assign('https://downloadgater.com/api/spotify/callback?code=fixture');
</script>`;

// Step sections as rendered by live gates (icons stripped).
const LIVE_PANES = {
	email:
		'<section class="gate-flow"><div class="gate-flow-heading"><div><p class="gate-flow-kicker">Unlock step</p><h2 id="gate-flow-title"><span aria-label="Email capture" class="gate-action-wordmark" data-gate-platform="email"><strong class="gate-action-platform">Email</strong> <span class="gate-action-verb">Submit</span></span></h2><p>Enter your email to continue.</p></div></div><div class="email-capture-row"><input inputmode="email" placeholder="you@example.com" type="email" value=""><button disabled="" type="button">Next</button></div></section>',
	instagram:
		'<section class="gate-flow"><div class="gate-flow-heading"><div><p class="gate-flow-kicker">Unlock step</p><h2 id="gate-flow-title"><span aria-label="Instagram Follow" class="gate-action-wordmark" data-gate-platform="instagram"><strong class="gate-action-platform">Instagram</strong> <span class="gate-action-verb">Follow</span></span></h2><p>Follow the creator on Instagram.</p></div></div><div class="gate-flow-actions"><button data-gate-key="instagramFollow" data-target-url="https://instagram.com/x" type="button"><span>Follow on Instagram</span></button></div></section>',
	'spotify-oauth':
		'<section class="gate-flow"><div class="gate-flow-heading"><div><p class="gate-flow-kicker">Verified unlock</p><h2 id="gate-flow-title"><span aria-label="Connect Spotify" class="gate-action-wordmark" data-gate-platform="spotify"><strong class="gate-action-platform">Spotify</strong> <span class="gate-action-verb">Connect</span></span></h2></div></div><div class="soundcloud-action-list spotify-action-list"><span>Follow the Spotify profile</span></div><div class="gate-flow-actions"><button type="button"><span>Connect &amp; Follow on Spotify</span></button></div></section>',
	youtube:
		'<section class="gate-flow"><div class="gate-flow-heading"><div><p class="gate-flow-kicker">Unlock step</p><h2 id="gate-flow-title"><span aria-label="YouTube Subscribe" class="gate-action-wordmark" data-gate-platform="youtube"><strong class="gate-action-platform">YouTube</strong> <span class="gate-action-verb">Subscribe</span></span></h2></div></div><div class="gate-flow-actions"><button data-gate-key="youtubeSubscribe" data-target-url="https://youtube.com/@x" type="button"><span>Subscribe on YouTube</span></button><button class="gate-confirm-action" disabled="" type="button"><span>I subscribed</span></button></div></section>',
	soundcloud:
		'<section class="gate-flow"><div class="gate-flow-heading"><div><p class="gate-flow-kicker">Verified unlock</p><h2 id="gate-flow-title"><span aria-label="Complete SoundCloud" class="gate-action-wordmark" data-gate-platform="soundcloud"><strong class="gate-action-platform">SoundCloud</strong> <span class="gate-action-verb">Unlock</span></span></h2></div></div><label class="soundcloud-comment-field public-comment-field"><span>Write your comment</span><textarea maxlength="280"></textarea></label><div class="gate-flow-actions"><button type="button"><span>Connect &amp; Follow on SoundCloud</span></button></div></section>',
};

describe('DownloadGater gate steps', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function runGate(
		steps: string[],
		{
			email = 'listener@example.com',
			rejectEmail = false,
			spotifyCookies = true,
			spotifyCallback = '/g/fixture?spotify_unlock=fixture-token',
		} = {},
	) {
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		const requests: string[] = [];
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const url = new URL(request.url());
			requests.push(`${url.hostname}${url.pathname}`);
			if (url.hostname === 'accounts.spotify.com') {
				void request.respond({
					status: 200,
					contentType: 'text/html',
					body: SPOTIFY_CONSENT,
				});
			} else if (url.pathname === '/api/spotify/callback') {
				void request.respond({
					status: 302,
					headers: { location: spotifyCallback },
				});
			} else if (url.hostname === 'downloadgater.com') {
				void request.respond({
					status: 200,
					contentType: 'text/html',
					body: fixture(steps, rejectEmail),
				});
			} else {
				void request.abort();
			}
		});
		const downloader = new DownloadgaterDownloader({
			browserMode: 'headless',
			email,
			comment: '',
		});
		let downloaded = false;
		let capturedEmail = null as string | null;
		Object.assign(downloader, {
			hasSpotifyCookies: spotifyCookies,
			browser: {
				newPage: async () => page,
				pages: () => context.pages(),
			},
			handleDownload: async (gate: Page) => {
				await gate.evaluate(() =>
					Array.from(document.querySelectorAll('button'))
						.find((btn) => btn.textContent?.trim() === 'Download file')
						?.click(),
				);
				downloaded = await gate.evaluate(
					() => document.body.dataset.downloaded === 'true',
				);
				capturedEmail = await gate.evaluate(() =>
					sessionStorage.getItem('downloadgater.email.fixture'),
				);
			},
		});
		try {
			await downloader.downloadAudio('https://downloadgater.com/g/fixture');
			expect(downloaded).toBeTrue();
			const popups = (await context.pages()).filter((p) => p !== page);
			expect(popups).toEqual([]);
			return { capturedEmail, requests };
		} finally {
			await context.close();
		}
	}

	test('classifies the live step markup', async () => {
		const page = await browser.newPage();
		const downloader = new DownloadgaterDownloader({
			browserMode: 'headless',
			comment: '',
		});
		const detectPane = (
			downloader as unknown as { detectPane(page: Page): Promise<string> }
		).detectPane.bind(downloader);
		try {
			for (const [pane, html] of Object.entries(LIVE_PANES)) {
				await page.setContent(html);
				expect(await detectPane(page)).toBe(pane);
			}
		} finally {
			await page.close();
		}
	});

	test('submits the email capture, Spotify OAuth and YouTube subscribe in gate order', async () => {
		const { capturedEmail, requests } = await runGate([
			'email',
			'spotify-oauth',
			'youtube',
		]);
		expect(capturedEmail).toBe('listener@example.com');
		expect(requests).toContain('accounts.spotify.com/authorize');
		expect(requests).toContain('downloadgater.com/api/spotify/callback');
	}, 30_000);

	test('opens every account of a visit-only Spotify step before confirming', async () => {
		await runGate(['spotify-visit']);
	}, 30_000);

	test('requires HYPEDDIT_EMAIL for an email capture', async () => {
		await expect(runGate(['email'], { email: '' })).rejects.toThrow(
			'This DownloadGater gate requires an email. Set HYPEDDIT_EMAIL',
		);
	}, 30_000);

	test('reports a rejected email', async () => {
		await expect(runGate(['email'], { rejectEmail: true })).rejects.toThrow(
			'DownloadGater email capture failed: Could not capture this email.',
		);
	}, 30_000);

	test('requires Spotify cookies for the OAuth variant', async () => {
		await expect(
			runGate(['spotify-oauth'], { spotifyCookies: false }),
		).rejects.toThrow('DownloadGater requires Spotify for this gate.');
	}, 30_000);

	test('reports the Spotify error the callback returns', async () => {
		await expect(
			runGate(['spotify-oauth'], {
				spotifyCallback: '/g/fixture?spotify_error=spotify_denied',
			}),
		).rejects.toThrow('DownloadGater Spotify unlock failed: spotify_denied');
	}, 30_000);
});
