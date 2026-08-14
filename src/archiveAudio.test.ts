import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookpath } from 'find-bin';
import {
	hasZipSignature,
	resolveDownloadedAudio,
	selectArchiveAudioMember,
} from './archiveAudio';

describe('ZIP audio resolution', () => {
	test('recognizes ZIP signatures instead of relying on the extension', () => {
		expect(
			hasZipSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
		).toBeTrue();
		expect(
			hasZipSignature(new Uint8Array([0x50, 0x4b, 0x05, 0x06])),
		).toBeTrue();
		expect(
			hasZipSignature(new Uint8Array([0x49, 0x44, 0x33, 0x04])),
		).toBeFalse();
	});

	test('prefers a lossless audio member over lossy alternatives', () => {
		expect(
			selectArchiveAudioMember([
				'cover.jpg',
				'Track.mp3',
				'__MACOSX/._Track.flac',
				'Track.flac',
			]),
		).toBe('Track.flac');
	});

	test('accepts supported lossy audio when no lossless member exists', () => {
		expect(selectArchiveAudioMember(['notes.txt', 'audio/song.m4a'])).toBe(
			'audio/song.m4a',
		);
	});

	test('returns null when the archive has no supported audio', () => {
		expect(selectArchiveAudioMember(['cover.png', 'README.txt'])).toBeNull();
	});

	test('extracts the preferred audio from an extensionless ZIP', async () => {
		const zipBin = await lookpath('zip');
		const unzipBin = await lookpath('unzip');
		if (!zipBin || !unzipBin) return;

		const directory = await mkdtemp(join(tmpdir(), 'sc-gate-dl-archive-test-'));
		const sourceDirectory = join(directory, 'source');
		try {
			await mkdir(sourceDirectory);
			await Bun.write(join(sourceDirectory, 'song.mp3'), 'lossy');
			await Bun.write(join(sourceDirectory, 'song.flac'), 'lossless');
			const archivePath = join(directory, 'download.bin');
			const zip = Bun.spawnSync(
				[zipBin, '-q', archivePath, 'song.mp3', 'song.flac'],
				{ cwd: sourceDirectory },
			);
			expect(zip.exitCode).toBe(0);

			const extracted = await resolveDownloadedAudio('download.bin', directory);
			expect(extracted).toBe('song.flac');
			expect(await Bun.file(join(directory, extracted)).text()).toBe(
				'lossless',
			);
			expect(await Bun.file(archivePath).exists()).toBeFalse();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('does not overwrite a ZIP named like its audio member', async () => {
		const zipBin = await lookpath('zip');
		const unzipBin = await lookpath('unzip');
		if (!zipBin || !unzipBin) return;

		const directory = await mkdtemp(join(tmpdir(), 'sc-gate-dl-archive-test-'));
		const sourceDirectory = join(directory, 'source');
		try {
			await mkdir(sourceDirectory);
			await Bun.write(join(sourceDirectory, 'track.flac'), 'lossless');
			const archivePath = join(directory, 'track.flac');
			const zip = Bun.spawnSync([zipBin, '-q', archivePath, 'track.flac'], {
				cwd: sourceDirectory,
			});
			expect(zip.exitCode).toBe(0);

			const extracted = await resolveDownloadedAudio('track.flac', directory);
			expect(extracted).not.toBe('track.flac');
			expect(await Bun.file(join(directory, extracted)).text()).toBe(
				'lossless',
			);
			expect(await Bun.file(archivePath).exists()).toBeFalse();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
