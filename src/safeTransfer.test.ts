import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PathLike } from 'node:fs';
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeIntoDirectory } from './safeTransfer';

const crossDevice = {
	link: async () => {
		throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
	},
	copyFile,
};

describe('placeIntoDirectory', () => {
	let root: string;
	let source: string;
	let dir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'sc-gate-transfer-'));
		source = join(root, 'Song.mp3');
		dir = join(root, 'out');
		await mkdir(dir);
		await writeFile(source, 'audio');
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('moves the source to the requested name', async () => {
		expect(await placeIntoDirectory({ sourcePath: source, dir })).toBe(
			join(dir, 'Song.mp3'),
		);
		expect(await Bun.file(join(dir, 'Song.mp3')).text()).toBe('audio');
		expect(await readdir(root)).toEqual(['out']);
	});

	test('takes a suffixed name and never replaces an existing file', async () => {
		await writeFile(join(dir, 'Song.mp3'), 'mine');

		expect(await placeIntoDirectory({ sourcePath: source, dir })).toBe(
			join(dir, 'Song (2).mp3'),
		);
		expect(await Bun.file(join(dir, 'Song.mp3')).text()).toBe('mine');
	});

	test('copies through exclusive staging when hard links are unavailable', async () => {
		const target = await placeIntoDirectory({
			sourcePath: source,
			dir,
			transfer: crossDevice,
		});

		expect(await Bun.file(target).text()).toBe('audio');
		expect(await readdir(root)).toEqual(['out']);
		expect(await readdir(dir)).toEqual(['Song.mp3']);
	});

	test('keeps the source and leaves no partial target when publication fails', async () => {
		const transfer = {
			link: crossDevice.link,
			copyFile: async (from: PathLike, to: PathLike, mode?: number) => {
				if (String(to).endsWith('.mp3')) {
					await writeFile(to, 'par');
					throw new Error('disk full');
				}
				return copyFile(from, to, mode);
			},
		};

		await expect(
			placeIntoDirectory({ sourcePath: source, dir, transfer }),
		).rejects.toThrow('disk full');

		expect(await Bun.file(source).text()).toBe('audio');
		expect(await readdir(dir)).toEqual([]);
	});

	test('keeps the source when placement is not asked to remove it', async () => {
		expect(
			await placeIntoDirectory({
				sourcePath: source,
				dir,
				removeSource: false,
				transfer: crossDevice,
			}),
		).toBe(join(dir, 'Song.mp3'));
		expect(await Bun.file(source).text()).toBe('audio');
		expect(await Bun.file(join(dir, 'Song.mp3')).text()).toBe('audio');
	});

	test('keeps a file that appears at the target during the copy', async () => {
		const transfer = {
			link: crossDevice.link,
			copyFile: async (from: PathLike, to: PathLike, mode?: number) => {
				if (String(to) === join(dir, 'Song.mp3')) {
					await writeFile(to, 'racer');
				}
				return copyFile(from, to, mode);
			},
		};

		expect(
			await placeIntoDirectory({ sourcePath: source, dir, transfer }),
		).toBe(join(dir, 'Song (2).mp3'));
		expect(await Bun.file(join(dir, 'Song.mp3')).text()).toBe('racer');
		expect(await Bun.file(join(dir, 'Song (2).mp3')).text()).toBe('audio');
	});

	test('keeps two concurrent moves of the same name under distinct names', async () => {
		const other = join(root, 'other.mp3');
		await writeFile(other, 'second');
		await writeFile(join(dir, 'Song.mp3'), 'mine');

		const names = await Promise.all([
			placeIntoDirectory({ sourcePath: source, dir, transfer: crossDevice }),
			placeIntoDirectory({
				sourcePath: other,
				dir,
				filename: 'Song.mp3',
				transfer: crossDevice,
			}),
		]);

		expect(new Set(names).size).toBe(2);
		expect(names).not.toContain(join(dir, 'Song.mp3'));
		const contents = await Promise.all(
			names.map((name) => Bun.file(name).text()),
		);
		expect(contents.sort()).toEqual(['audio', 'second']);
		expect(await Bun.file(join(dir, 'Song.mp3')).text()).toBe('mine');
		expect(await readdir(dir)).toHaveLength(3);
	});
});
