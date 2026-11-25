import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PathLike } from 'node:fs';
import { existsSync } from 'node:fs';
import {
	chmod,
	copyFile,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	libraryDirFromEnv,
	moveIntoLibrary,
	moveIntoLibraryUnlessCancelled,
} from './libraryDestination';

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

	test('keeps an existing library file when the source is missing', async () => {
		await Bun.write(join(library, 'Artist - Title.mp3'), 'mine');
		const source = join(downloads, 'Artist - Title.mp3');

		await expect(moveIntoLibrary(source, library)).rejects.toThrow();
		expect(await readFile(join(library, 'Artist - Title.mp3'), 'utf8')).toBe(
			'mine',
		);
	});

	test('keeps no library copy when the source cannot be removed', async () => {
		const source = join(downloads, 'Artist - Title.mp3');
		await writeFile(source, 'audio');
		await chmod(downloads, 0o555);

		await expect(moveIntoLibrary(source, library)).rejects.toThrow();
		expect(existsSync(join(library, 'Artist - Title.mp3'))).toBe(false);
		expect(existsSync(source)).toBe(true);
	});

	test('keeps no partial library file when publication fails', async () => {
		const source = join(downloads, 'Artist - Title.mp3');
		await writeFile(source, 'audio');
		const transfer = {
			link: async () => {
				throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
			},
			copyFile: async (from: PathLike, to: PathLike, mode?: number) => {
				if (String(to).endsWith('Artist - Title.mp3')) {
					await writeFile(to, 'par');
					throw new Error('publish failed');
				}
				return copyFile(from, to, mode);
			},
		};

		await expect(
			moveIntoLibrary(source, library, undefined, transfer),
		).rejects.toThrow('publish failed');
		expect(await readFile(source, 'utf8')).toBe('audio');
		expect(await readdir(library)).toEqual([]);
	});

	test('removing a cancelled library copy never touches an existing library file', async () => {
		await Bun.write(join(library, 'Artist - Title.mp3'), 'existing');
		const source = join(downloads, 'Artist - Title.mp3');
		await writeFile(source, 'new');

		const copied = await moveIntoLibrary(source, library);
		expect(copied).toBe('Artist - Title (2).mp3');
		await rm(join(library, copied), { force: true });

		expect(await readFile(join(library, 'Artist - Title.mp3'), 'utf8')).toBe(
			'existing',
		);
		expect(existsSync(join(library, 'Artist - Title (2).mp3'))).toBe(false);
	});

	test('keeps two concurrent moves of the same name under distinct names', async () => {
		const first = join(downloads, 'first.mp3');
		const second = join(downloads, 'second.mp3');
		await writeFile(first, 'first');
		await writeFile(second, 'second');
		await Bun.write(join(library, 'Artist - Title.mp3'), 'mine');
		const transfer = {
			link: async () => {
				throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
			},
			copyFile,
		};

		const names = await Promise.all([
			moveIntoLibrary(first, library, 'Artist - Title.mp3', transfer),
			moveIntoLibrary(second, library, 'Artist - Title.mp3', transfer),
		]);

		expect(new Set(names).size).toBe(2);
		expect(names).not.toContain('Artist - Title.mp3');
		expect(await readFile(join(library, 'Artist - Title.mp3'), 'utf8')).toBe(
			'mine',
		);
		const contents = await Promise.all(
			names.map((name) => readFile(join(library, name), 'utf8')),
		);
		expect(contents.sort()).toEqual(['first', 'second']);
	});

	test('a job cancelled during the move leaves no library copy and keeps an existing file', async () => {
		await Bun.write(join(library, 'Artist - Title.mp3'), 'existing');
		const source = join(downloads, 'Artist - Title.mp3');
		await writeFile(source, 'new');

		await expect(
			moveIntoLibraryUnlessCancelled(source, library, () => true),
		).rejects.toThrow('Download cancelled');

		expect(await readdir(library)).toEqual(['Artist - Title.mp3']);
		expect(await readFile(join(library, 'Artist - Title.mp3'), 'utf8')).toBe(
			'existing',
		);
	});

	test('a job that is not cancelled keeps its library copy', async () => {
		const source = join(downloads, 'Song.mp3');
		await writeFile(source, 'audio');

		const name = await moveIntoLibraryUnlessCancelled(
			source,
			library,
			() => false,
		);

		expect(name).toBe('Song.mp3');
		expect(await readdir(library)).toEqual(['Song.mp3']);
	});
});
