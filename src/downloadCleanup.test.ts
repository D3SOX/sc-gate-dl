import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { cleanupCancelledDownloadArtifacts } from './downloadCleanup';

describe('cleanupCancelledDownloadArtifacts', () => {
	let dir: string;

	afterEach(async () => {
		if (!dir) return;
		for await (const entry of new Bun.Glob('*').scan({
			cwd: dir,
			onlyFiles: true,
		})) {
			await Bun.file(join(dir, entry))
				.delete()
				.catch(() => {});
		}
		await $`rmdir ${dir}`.quiet().nothrow();
	});

	async function setup() {
		dir = join(tmpdir(), `sc-gate-dl-cleanup-${crypto.randomUUID()}`);
		await $`mkdir -p ${dir}`.quiet();
		return dir;
	}

	async function readEntries(path: string): Promise<string[]> {
		const entries: string[] = [];
		for await (const entry of new Bun.Glob('*').scan({
			cwd: path,
			onlyFiles: true,
		})) {
			entries.push(entry);
		}
		return entries.sort();
	}

	test('removes known job files and matching incomplete temps', async () => {
		const downloadsDir = await setup();
		await Bun.write(join(downloadsDir, 'track.mp3'), 'done');
		await Bun.write(join(downloadsDir, 'track.mp3.crdownload'), 'partial');
		await Bun.write(join(downloadsDir, 'keep.mp3'), 'keep');

		const removed = await cleanupCancelledDownloadArtifacts({
			downloadsDir,
			filenames: ['track.mp3'],
		});

		expect(removed).toContain('track.mp3');
		expect(removed).toContain('track.mp3.crdownload');
		expect(await readEntries(downloadsDir)).toEqual(['keep.mp3']);
	});

	test('sweeps orphan .crdownload and .part files', async () => {
		const downloadsDir = await setup();
		await Bun.write(join(downloadsDir, 'Unconfirmed 123.crdownload'), 'chrome');
		await Bun.write(join(downloadsDir, 'song.flac.part'), 'ytdlp');
		await Bun.write(join(downloadsDir, 'finished.wav'), 'ok');

		await cleanupCancelledDownloadArtifacts({ downloadsDir });

		expect(await readEntries(downloadsDir)).toEqual(['finished.wav']);
	});

	test('ignores path traversal in filenames', async () => {
		const downloadsDir = await setup();
		await Bun.write(join(downloadsDir, 'safe.mp3'), 'ok');

		const removed = await cleanupCancelledDownloadArtifacts({
			downloadsDir,
			filenames: ['../safe.mp3', '..', '', 'nested/safe.mp3'],
		});

		expect(removed).toEqual([]);
		expect(await Bun.file(join(downloadsDir, 'safe.mp3')).exists()).toBeTrue();
	});

	test('can preserve unrelated incomplete files outside an active queue slot', async () => {
		const downloadsDir = await setup();
		await Bun.write(join(downloadsDir, 'cancelled.wav'), 'done');
		await Bun.write(join(downloadsDir, 'other.crdownload'), 'active');

		await cleanupCancelledDownloadArtifacts({
			downloadsDir,
			filenames: ['cancelled.wav'],
			sweepIncomplete: false,
		});

		expect(await readEntries(downloadsDir)).toEqual(['other.crdownload']);
	});
});
