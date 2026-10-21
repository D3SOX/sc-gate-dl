import { constants } from 'node:fs';
import { copyFile, link, mkdir, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

/** Absolute library folder from `SC_GATE_DL_LIBRARY_DIR`, or null when unset. */
export function libraryDirFromEnv(
	value = process.env.SC_GATE_DL_LIBRARY_DIR,
): string | null {
	const trimmed = value?.trim();
	return trimmed ? resolve(trimmed) : null;
}

function errorCode(error: unknown): unknown {
	return error instanceof Error && 'code' in error ? error.code : undefined;
}

/**
 * Move a finished file into the library folder without replacing an existing
 * file. A taken name gets a ` (2)`, ` (3)`, … suffix. Returns the final name.
 */
export async function moveIntoLibrary(
	sourcePath: string,
	libraryDir: string,
	filename = basename(sourcePath),
): Promise<string> {
	await mkdir(libraryDir, { recursive: true });
	const extension = extname(filename);
	const stem = basename(filename, extension);
	for (let n = 1; ; n += 1) {
		const candidate = n === 1 ? filename : `${stem} (${n})${extension}`;
		const target = join(libraryDir, candidate);
		try {
			// A hard link claims the name atomically and never exposes a partial file.
			await link(sourcePath, target);
		} catch (linkError) {
			if (errorCode(linkError) === 'EEXIST') continue;
			// Other filesystems or devices, or no hard-link support.
			try {
				await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
			} catch (copyError) {
				if (errorCode(copyError) === 'EEXIST') continue;
				await rm(target, { force: true });
				throw copyError;
			}
		}
		await rm(sourcePath, { force: true });
		return candidate;
	}
}
