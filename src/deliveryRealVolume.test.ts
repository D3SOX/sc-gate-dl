import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deliverCliOutput } from './cliDestination';

const secondVolume = process.env.SC_GATE_DL_SECOND_VOLUME;

describe.skipIf(!secondVolume)('delivery across a real second volume', () => {
	test('moves a file onto another filesystem and removes the source only after the copy', async () => {
		const sourceDir = await mkdtemp(join(process.cwd(), '.cross-src-'));
		const destination = join(secondVolume as string, 'sc-gate-dl-test');
		try {
			const source = join(sourceDir, 'Song.mp3');
			await writeFile(source, 'real cross-device payload');
			await mkdir(destination, { recursive: true });

			const delivered = await deliverCliOutput({
				outputPath: source,
				sourcePath: source,
				removeSource: true,
				destinationDir: destination,
			});

			expect(delivered).toEqual([join(destination, 'Song.mp3')]);
			expect(readFileSync(delivered[0] as string, 'utf8')).toBe(
				'real cross-device payload',
			);
			expect(existsSync(source)).toBe(false);
		} finally {
			await rm(sourceDir, { recursive: true, force: true });
			await rm(destination, { recursive: true, force: true });
		}
	});
});
