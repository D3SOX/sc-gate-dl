import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Browser } from 'puppeteer';
import { launchAppBrowser } from '../../../src/browserLaunch';

const DIST = join(import.meta.dir, '..', '..', 'dist');
const TYPES: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

interface Api {
	origin: string;
	metadataPosts: number;
	stop(): void;
}

const API_PORT = 39555;

function startApi(reviewTagsDefault: boolean, outputFormat = 'mp3'): Api {
	const state = { metadataPosts: 0 };
	const cors = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': '*',
	};
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), {
			headers: { 'Content-Type': 'application/json', ...cors },
		});
	const server = Bun.serve({
		port: API_PORT,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (request.method === 'OPTIONS')
				return new Response(null, { headers: cors });
			if (pathname === '/api/capabilities') {
				return json({
					browserModes: ['headless'],
					browserViewUrl: null,
					reviewTagsDefault,
				});
			}
			if (pathname === '/api/job' && request.method === 'POST') {
				return json({
					jobId: 'job1',
					track: {
						title: 'Song',
						artworkUrl: null,
						user: { username: 'artist', fullName: 'Artist', avatarUrl: '' },
						genre: 'Techno',
					},
					hypedditUrl: null,
					defaultMetadata: { title: 'Song', artist: 'Artist' },
					needsHypedditUrl: false,
				});
			}
			if (pathname === '/api/job/job1/events') {
				const body = `data: ${JSON.stringify({ stage: 'ready', message: 'ready', percent: 100 })}\n\n`;
				return new Response(body, {
					headers: { 'Content-Type': 'text/event-stream', ...cors },
				});
			}
			if (pathname === '/api/job/job1/metadata') {
				state.metadataPosts += 1;
				return json({ success: true, outputFilename: 'Song.mp3' });
			}
			if (pathname === '/api/job/job1') {
				return json({
					id: 'job1',
					outputFormat,
					downloadFilename: 'Song.mp3',
					outputFilename: 'Song.mp3',
					existingMetadata: null,
					hasExistingArtwork: false,
					sourceIsLossless: false,
					progress: { stage: 'ready', message: 'ready', percent: 100 },
				});
			}
			return json({});
		},
	});
	return {
		origin: `http://127.0.0.1:${server.port}`,
		get metadataPosts() {
			return state.metadataPosts;
		},
		stop: () => server.stop(true),
	};
}

describe('review-tags choice in the built Web UI', () => {
	let browser: Browser;
	let web: ReturnType<typeof Bun.serve>;

	beforeAll(async () => {
		const build = Bun.spawn(['bun', 'run', 'build'], {
			cwd: join(import.meta.dir, '..', '..'),
			env: {
				...(process.env as Record<string, string>),
				PUBLIC_API_BASE_URL: `http://127.0.0.1:${API_PORT}`,
			},
			stdout: 'ignore',
			stderr: 'ignore',
		});
		expect(await build.exited).toBe(0);
		web = Bun.serve({
			port: 0,
			async fetch(request) {
				const { pathname } = new URL(request.url);
				const rel = normalize(pathname === '/' ? '/index.html' : pathname);
				try {
					const file = await readFile(join(DIST, rel));
					return new Response(file, {
						headers: {
							'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream',
						},
					});
				} catch {
					return new Response('not found', { status: 404 });
				}
			},
		});
		browser = await launchAppBrowser({ headless: true, humanize: false });
	});

	afterAll(async () => {
		await browser.close();
		web.stop(true);
	});

	async function run(options: {
		serverDefault: boolean;
		query?: string;
		stored?: string;
		outputFormat?: string;
	}) {
		const api = startApi(options.serverDefault, options.outputFormat);
		const page = await browser.newPage();
		try {
			if (options.stored !== undefined) {
				await page.evaluateOnNewDocument((value: string) => {
					localStorage.setItem('sc-gate-dl-review-tags', value);
				}, options.stored);
			}
			const query = new URLSearchParams({
				url: 'https://soundcloud.com/artist/song',
				...(options.query
					? Object.fromEntries(new URLSearchParams(options.query))
					: {}),
			});
			await page.goto(`http://127.0.0.1:${web.port}/?${query}`);
			await Bun.sleep(4000);
			const editorVisible = await page.evaluate(
				() =>
					document.body.innerText.includes('Check the tags') &&
					!!document.querySelector('form.step-block'),
			);
			return { editorVisible, posts: api.metadataPosts };
		} finally {
			await page.close();
			api.stop();
		}
	}

	test('review off finalizes without the tag editor', async () => {
		const result = await run({ serverDefault: false });
		expect(result.posts).toBe(1);
		expect(result.editorVisible).toBe(false);
	}, 60_000);

	test('review on keeps the tag editor and does not save by itself', async () => {
		const result = await run({
			serverDefault: false,
			query: 'reviewTags=true',
		});
		expect(result.posts).toBe(0);
		expect(result.editorVisible).toBe(true);
	}, 60_000);

	test('the server default applies when nothing else is chosen', async () => {
		const result = await run({ serverDefault: true });
		expect(result.posts).toBe(0);
		expect(result.editorVisible).toBe(true);
	}, 60_000);

	test('a stored choice beats the server default', async () => {
		const result = await run({ serverDefault: true, stored: 'false' });
		expect(result.posts).toBe(1);
	}, 60_000);

	test('a deep link beats a stored choice', async () => {
		const result = await run({
			serverDefault: false,
			stored: 'false',
			query: 'reviewTags=true',
		});
		expect(result.posts).toBe(0);
		expect(result.editorVisible).toBe(true);
	}, 60_000);

	test('an invalid stored value falls back to the server default', async () => {
		const result = await run({ serverDefault: true, stored: 'banana' });
		expect(result.posts).toBe(0);
		expect(result.editorVisible).toBe(true);
	}, 60_000);

	test('an Original download is never finalized or edited by the UI', async () => {
		const result = await run({
			serverDefault: false,
			outputFormat: 'original',
		});
		expect(result.posts).toBe(0);
		expect(result.editorVisible).toBe(false);
	}, 60_000);
});
