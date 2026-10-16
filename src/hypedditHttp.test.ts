import { expect, spyOn, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HypedditHttpDownloader } from './hypedditHttp';

test('HTTP downloads confine remote filenames to downloads and preserve Unicode', async () => {
	const originalDirectory = process.cwd();
	const root = await mkdtemp(join(tmpdir(), 'sc-gate-filename-test-'));
	await mkdir(join(root, 'downloads'));
	const gatePage = `<meta name="csrf-token" content="test">
		${Object.entries({
			gvt: 'test',
			current_download_file_listner: 'test',
			nwSteps: 'email',
			wrndk: 'test',
			fan_gate_id: 'test',
		})
			.map(([id, value]) => `<input id="${id}" value="${value}">`)
			.join('')}`;
	const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 255]);
	let header: string | null = null;
	let fileUrl = 'https://files.example.test/audio';
	const fetchMock = Object.assign(
		async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === fileUrl)
				return new Response(bytes, {
					headers: header ? { 'Content-Disposition': header } : {},
				});
			if (url.endsWith('/gate/download/ul'))
				return Response.json({ download_status: true, URL: fileUrl });
			if (url === 'https://hypeddit.com/test') return new Response(gatePage);
			return Response.json({});
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetch = spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
	process.chdir(root);
	try {
		await writeFile(join(root, 'outside.mp3'), 'keep existing file');
		const fixtures = [
			{
				header: 'attachment; filename="../outside.mp3"',
				expected: 'outside.mp3',
			},
			{
				header: `attachment; filename*=UTF-8''..%2Foutside.mp3`,
				expected: 'outside.mp3',
			},
			{
				header: null,
				suggested: '../outside.mp3',
				expected: 'outside.mp3',
			},
			{
				header: String.raw`attachment; filename="CLEOPARD2000 - R\'n\'D.wav"`,
				expected: "CLEOPARD2000 - R'n'D.wav",
			},
			{
				header: `attachment; filename="${Buffer.from('ØSLO - 2 REMEMBER.wav').toString('latin1')}"`,
				expected: 'ØSLO - 2 REMEMBER.wav',
			},
			{
				header: null,
				expected: "DJ Ra\u0308ucherlaks - Round 'n' Round & Again.wav",
			},
		];
		for (const fixture of fixtures) {
			header = fixture.header;
			const url = new URL('https://files.example.test/audio');
			if (!header)
				url.searchParams.set(
					'response-content-disposition',
					`attachment; filename="${fixture.suggested ?? fixture.expected}"`,
				);
			fileUrl = url.toString();
			const downloader = new HypedditHttpDownloader({
				comment: 'test',
				browserMode: 'headless',
				email: 'test@example.test',
			});
			try {
				const filename = await downloader.tryDownload(
					'https://hypeddit.com/test',
				);
				expect(await readFile(join(root, 'outside.mp3'), 'utf8')).toBe(
					'keep existing file',
				);
				expect(filename).toBe(fixture.expected);
				expect(
					await readFile(join(root, 'downloads', fixture.expected)),
				).toEqual(Buffer.from(bytes));
			} finally {
				await downloader.close();
			}
		}
		expect((await readdir(join(root, 'downloads'))).length).toBe(
			new Set(fixtures.map((fixture) => fixture.expected)).size,
		);
	} finally {
		process.chdir(originalDirectory);
		fetch.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});
