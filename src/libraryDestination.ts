import { mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type FileTransfer, placeIntoDirectory } from './safeTransfer';

/** Absolute library folder from `SC_GATE_DL_LIBRARY_DIR`, or null when unset. */
export function libraryDirFromEnv(
	value = process.env.SC_GATE_DL_LIBRARY_DIR,
): string | null {
	const trimmed = value?.trim();
	return trimmed ? resolve(trimmed) : null;
}

/**
 * Move a finished file into the library folder without replacing an existing
 * file. A taken name gets a ` (2)`, ` (3)`, … suffix. Returns the final name.
 */
export async function moveIntoLibrary(
	sourcePath: string,
	libraryDir: string,
	filename = basename(sourcePath),
	transfer?: FileTransfer,
): Promise<string> {
	await mkdir(libraryDir, { recursive: true });
	const target = await placeIntoDirectory({
		sourcePath,
		dir: libraryDir,
		filename,
		transfer,
	});
	return basename(target);
}

/**
 * Move into the library, then undo the copy when the job was cancelled in the
 * meantime. Only the copy this call created is removed, never an older file.
 */
export async function moveIntoLibraryUnlessCancelled(
	sourcePath: string,
	libraryDir: string,
	isCancelled: () => boolean,
): Promise<string> {
	const name = await moveIntoLibrary(sourcePath, libraryDir);
	if (isCancelled()) {
		await rm(join(libraryDir, name), { force: true });
		throw new Error('Download cancelled');
	}
	return name;
}
