import { constants, existsSync } from 'node:fs';
import { copyFile, link, mkdir, rename, rm } from 'node:fs/promises';
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

export type LibraryFs = {
	link: typeof link;
	copyFile: typeof copyFile;
	rename: typeof rename;
};

/**
 * Move a finished file into the library folder without replacing an existing
 * file. A taken name gets a ` (2)`, ` (3)`, … suffix. Returns the final name.
 * From another filesystem, the file is copied next to the target first, so the
 * library never shows a partial file.
 */
export async function moveIntoLibrary(
	sourcePath: string,
	libraryDir: string,
	filename = basename(sourcePath),
	fs: LibraryFs = { link, copyFile, rename },
): Promise<string> {
	await mkdir(libraryDir, { recursive: true });
	const extension = extname(filename);
	const stem = basename(filename, extension);
	let staging: string | null = null;

	/** Claim [target] without replacing a file; false when the name is taken. */
	async function placeAt(target: string): Promise<boolean> {
		try {
			// A hard link claims the name atomically and never exposes a partial file.
			await fs.link(staging ?? sourcePath, target);
			return true;
		} catch (linkError) {
			if (errorCode(linkError) === 'EEXIST') return false;
			if (!staging) {
				// Another filesystem or device.
				staging = join(
					libraryDir,
					`.${filename}.${crypto.randomUUID()}.partial`,
				);
				await fs.copyFile(sourcePath, staging, constants.COPYFILE_EXCL);
				return placeAt(target);
			}
			// The library filesystem has no hard links.
			if (existsSync(target)) return false;
			await fs.rename(staging, target);
			staging = null;
			return true;
		}
	}

	try {
		for (let n = 1; ; n += 1) {
			const candidate = n === 1 ? filename : `${stem} (${n})${extension}`;
			const target = join(libraryDir, candidate);
			if (!(await placeAt(target))) continue;
			try {
				await rm(sourcePath, { force: true });
			} catch (removeError) {
				// Keep one copy so a retry cannot add a suffixed duplicate.
				await rm(target, { force: true }).catch(() => {});
				throw removeError;
			}
			return candidate;
		}
	} finally {
		if (staging) await rm(staging, { force: true });
	}
}
