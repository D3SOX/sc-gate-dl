import { expect, test } from 'bun:test';
import { launchAppBrowser } from '../src/browserLaunch';

const source = await Bun.file(
	new URL('./sc-gate-dl.user.js', import.meta.url),
).text();

function linkHelper(): string {
	const start = source.indexOf('\tfunction buildWebuiSrc(');
	const end = source.indexOf('\n\tfunction loadTrackIntoPanel(', start);
	if (start < 0 || end < 0) throw new Error('buildWebuiSrc not found');
	return source.slice(start, end).trim();
}

function formatHelpers(): string {
	const start = source.indexOf('\tconst OUTPUT_FORMATS = ');
	const end = source.indexOf('\n\tfunction getBrowserMode(', start);
	if (start < 0 || end < 0) throw new Error('format helpers not found');
	return source.slice(start, end).trim();
}

const page = `<!doctype html><html><body><script>
const OUTPUT_FORMAT_KEY = 'sc-gate-dl-output-format';
const GM_getValue = (_key, fallback) => fallback;
const GM_setValue = () => {};
// data: URLs have no persistent localStorage; use a real origin instead.
const PANEL_ID = 'sc-gate-dl-panel';
function loadTrackIntoPanel() {}
${formatHelpers()}
function getBrowserMode() { return 'headless'; }
function getWebuiBase() { return 'http://localhost:4321'; }
${linkHelper()}
window.__format = { getOutputFormat, setOutputFormat, buildWebuiSrc };
</script></body></html>`;

test.each(['mp3', 'm4a-aac'])(
	'format %s survives a page reload and stays in the deep link',
	async (format) => {
		const browser = await launchAppBrowser({ headless: true });
		try {
			const pageHandle = await browser.newPage();
			const server = Bun.serve({
				port: 0,
				fetch: () =>
					new Response(page, { headers: { 'Content-Type': 'text/html' } }),
			});
			const url = `http://127.0.0.1:${server.port}/`;
			await pageHandle.goto(url);
			await pageHandle.evaluate((value) => {
				(
					window as unknown as {
						__format: { setOutputFormat(v: string): void };
					}
				).__format.setOutputFormat(value);
			}, format);
			await pageHandle.reload({ waitUntil: 'load' });
			server.stop(true);
			const after = await pageHandle.evaluate(() =>
				(
					window as unknown as { __format: { getOutputFormat(): string } }
				).__format.getOutputFormat(),
			);
			expect(after).toBe(format);
			const link = await pageHandle.evaluate(() =>
				(
					window as unknown as {
						__format: { buildWebuiSrc(u: string): string };
					}
				).__format.buildWebuiSrc('https://soundcloud.com/a/b'),
			);
			expect(new URL(link).searchParams.get('outputFormat')).toBe(format);
			await pageHandle.close();
		} finally {
			await browser.close();
		}
	},
	120_000,
);
