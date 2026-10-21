import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { libraryDirFromEnv, moveIntoLibrary } from './libraryDestination';

describe('libraryDirFromEnv', () => {
	test('is null when unset or blank', () => {
		expect(libraryDirFromEnv(undefined)).toBeNull();
		expect(libraryDirFromEnv('  ')).toBeNull();
	});

	test('resolves to an absolute path', () => {
		expect(libraryDirFromEnv('music')).toBe(resolve('music'));
	});
});

describe('moveIntoLibrary', () => {
	let root: string;
	let downloads: string;
	let library: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'sc-gate-library-'));
		downloads = join(root, 'downloads');
		library = join(root, 'Music', 'SoundCloud');
		await Bun.write(join(downloads, '.keep'), '');
	});

	afterEach(async () => {
		await chmod(downloads, 0o755);
		await rm(root, { recursive: true, force: true });
	});

	test('creates the folder and moves the file', async () => {
		const source = join(downloads, 'Artist - Title.mp3');
		await writeFile(source, 'audio');

		expect(await moveIntoLibrary(source, library)).toBe('Artist - Title.mp3');
		expect(existsSync(source)).toBe(false);
		expect(await readFile(join(library, 'Artist - Title.mp3'), 'utf8')).toBe(
			'audio',
		);
	});

	test('never replaces an existing library file', async () => {
		await Bun.write(join(library, 'Artist - Title.mp3'), 'first');
		await Bun.write(join(library, 'Artist - Title (2).mp3'), 'second');
		const source = join(downloads, 'Artist - Title.mp3');
		await writeFile(source, 'third');

		expect(await moveIntoLibrary(source, library)).toBe(
			'Artist - Title (3).mp3',
		);
		expect(await readFile(join(library, 'Artist - Title.mp3'), 'utf8')).toBe(
			'first',
		);
		expect(
			await readFile(join(library, 'Artist - Title (3).mp3'), 'utf8'),
		).toBe('third');
	});

	test('keeps no library copy when the source cannot be removed', async () => {
		const source = join(downloads, 'Artist - Title.mp3');
		await writeFile(source, 'audio');
		await chmod(downloads, 0o555);

		await expect(moveIntoLibrary(source, library)).rejects.toThrow();
		expect(existsSync(join(library, 'Artist - Title.mp3'))).toBe(false);
		expect(existsSync(source)).toBe(true);
	});
});
