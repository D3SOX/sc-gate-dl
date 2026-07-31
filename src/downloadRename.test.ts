import { describe, expect, test } from 'bun:test';
import {
	pickUniqueDownloadFilename,
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
