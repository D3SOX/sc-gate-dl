import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setEnvValues } from './envFile';

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'sc-gate-env-'));
	file = join(dir, '.env');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('setEnvValues', () => {
	test('replaces only the named keys and keeps comments and other lines', async () => {
		await writeFile(
			file,
			'# my notes\nSC_COMMENT=hello world\n\nSC_REFRESH_TOKEN=old\n# trailing\nOTHER=1\n',
		);

		await setEnvValues(file, { SC_REFRESH_TOKEN: 'new' });

		expect(await readFile(file, 'utf8')).toBe(
			'# my notes\nSC_COMMENT=hello world\n\nSC_REFRESH_TOKEN=new\n# trailing\nOTHER=1\n',
		);
	});

	test('keeps an export prefix and updates every copy of a key', async () => {
		await writeFile(
			file,
			'export SC_REFRESH_TOKEN=old\nSC_REFRESH_TOKEN=dup\n',
		);
		await setEnvValues(file, { SC_REFRESH_TOKEN: 'new' });
		expect(await readFile(file, 'utf8')).toBe(
			'export SC_REFRESH_TOKEN=new\nSC_REFRESH_TOKEN=new\n',
		);
	});

	test('appends a key that is not there yet', async () => {
		await writeFile(file, 'A=1\n');
		await setEnvValues(file, { B: '2' });
		expect(await readFile(file, 'utf8')).toBe('A=1\nB=2\n');
	});

	test('creates the file with mode 600 when it does not exist', async () => {
		await setEnvValues(file, { A: '1' });
		expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
	});

	test('tightens a file that was readable by others', async () => {
		await writeFile(file, 'A=1\n', { mode: 0o644 });
		await setEnvValues(file, { A: '2' });
		expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
	});

	test('leaves no temporary file behind', async () => {
		await writeFile(file, 'A=1\n');
		await setEnvValues(file, { A: '2' });
		expect(await readdir(dir)).toEqual(['.env']);
	});

	test('keeps the original untouched when the write fails', async () => {
		await writeFile(file, 'A=1\n');
		await expect(
			setEnvValues(
				file,
				{ A: 'x' },
				{
					rename: async () => {
						throw new Error('disk full');
					},
				},
			),
		).rejects.toThrow('disk full');
		expect(await readFile(file, 'utf8')).toBe('A=1\n');
		expect(await readdir(dir)).toEqual(['.env']);
	});

	test('rejects a key or value that would break the file format', async () => {
		await writeFile(file, 'A=1\n');
		await expect(setEnvValues(file, { 'A B': '1' })).rejects.toThrow('key');
		await expect(setEnvValues(file, { A: 'line1\nline2' })).rejects.toThrow(
			'value',
		);
		expect(await readFile(file, 'utf8')).toBe('A=1\n');
	});

	test('never puts the value in an error message', async () => {
		await writeFile(file, 'A=1\n');
		const error = await setEnvValues(file, { A: 'secret\nvalue' }).catch(
			(e: Error) => e,
		);
		expect(String((error as Error).message)).not.toContain('secret');
	});
});
