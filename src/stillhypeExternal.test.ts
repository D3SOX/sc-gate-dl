import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectDownloader } from './directDownload';
import * as outbound from './safeOutboundUrl';
import { StillhypeDownloader } from './stillhype';

type Internals = {
	externalDownload: boolean;
	saveUnlockedFile(url: string): Promise<string>;
};

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function downloader(external: boolean) {
	const instance = new StillhypeDownloader({
		browserMode: 'headless',
		comment: '',
	});
	const internals = instance as unknown as Internals;
	internals.externalDownload = external;
	return internals;
}

test('an external download hands a share link to the direct downloader', async () => {
	const direct = spyOn(
		DirectDownloader.prototype,
		'downloadAudio',
	).mockResolvedValue('Schnelle Beats.wav');
	restores.push(() => direct.mockRestore());
	const filename = await downloader(true).saveUnlockedFile(
		// Shape of the link the nachtwasser gate unlocks.
		'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=drive_link',
	);
	expect(filename).toBe('Schnelle Beats.wav');
	expect(direct).toHaveBeenCalledWith(
		'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQrStUv&export=download&confirm=t',
	);
});

test('a web page is never saved as audio', async () => {
	const root = await mkdtemp(join(tmpdir(), 'stillhype-html-'));
	const cwd = process.cwd();
	process.chdir(root);
	const fetch = spyOn(outbound, 'safeFetch').mockImplementation(
		async (url: string) => ({
			url,
			response: new Response('<!doctype html><title>File</title>', {
				headers: { 'content-type': 'text/html; charset=utf-8' },
			}),
		}),
	);
	restores.push(() => fetch.mockRestore());
	try {
		await expect(
			downloader(false).saveUnlockedFile('https://files.example.test/view'),
		).rejects.toThrow(
			'StillHype download returned a web page instead of a file',
		);
		expect(await readdir(join(root, 'downloads'))).toEqual([]);
	} finally {
		process.chdir(cwd);
		await rm(root, { recursive: true, force: true });
	}
});
