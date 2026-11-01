import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	pickUniqueDownloadFilename,
	reserveDownloadFilename,
	withDownloadRenameLock,
} from './downloadRename';

describe('pickUniqueDownloadFilename', () => {
	test('returns desired name when free', () => {
		expect(
			pickUniqueDownloadFilename({
				desiredFilename: 'Artist - Title.mp3',
				currentFilename: 'download.mp3',
				jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
				exists: () => false,
				isOwnedByOtherJob: () => false,
			}),
		).toBe('Artist - Title.mp3');
	});

	test('suffixes with job id when destination is taken', () => {
		expect(
			pickUniqueDownloadFilename({
				desiredFilename: 'Artist - Title.mp3',
				currentFilename: 'download.mp3',
				jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
				exists: (filename) => filename === 'Artist - Title.mp3',
				isOwnedByOtherJob: () => false,
			}),
		).toBe('Artist - Title [aaaaaaaa].mp3');
	});
});

describe('withDownloadRenameLock', () => {
	test('serializes concurrent renames that want the same name', async () => {
		const owned = new Set<string>();
		const onDisk = new Set<string>();

		const claim = async (jobId: string, current: string) =>
			withDownloadRenameLock(async () => {
				const finalName = pickUniqueDownloadFilename({
					desiredFilename: 'Artist - Title.mp3',
					currentFilename: current,
					jobId,
					exists: (filename) => onDisk.has(filename),
					isOwnedByOtherJob: (filename) => owned.has(filename),
				});
				await Promise.resolve();
				onDisk.delete(current);
				onDisk.add(finalName);
				owned.add(finalName);
				return finalName;
			});

		onDisk.add('a.mp3');
		onDisk.add('b.mp3');

		const [first, second] = await Promise.all([
			claim('11111111-1111-1111-1111-111111111111', 'a.mp3'),
			claim('22222222-2222-2222-2222-222222222222', 'b.mp3'),
		]);

		expect(first).not.toBe(second);
		expect(new Set([first, second]).has('Artist - Title.mp3')).toBe(true);
		expect(owned.has(first)).toBe(true);
		expect(owned.has(second)).toBe(true);
	});
});

describe('reserveDownloadFilename', () => {
	test('gives concurrent downloads with the same name separate files', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-reserve-'));
		try {
			await Bun.write(join(dir, 'track.mp3'), 'earlier job');
			const names = await Promise.all([
				reserveDownloadFilename(dir, 'track.mp3'),
				reserveDownloadFilename(dir, 'track.mp3'),
			]);

			expect(new Set(names).size).toBe(2);
			expect(names).not.toContain('track.mp3');
			expect(await Bun.file(join(dir, 'track.mp3')).text()).toBe(
				'earlier job',
			);
			expect((await readdir(dir)).sort()).toEqual(
				['track.mp3', ...names].sort(),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
