import { constants, existsSync } from 'node:fs';
import { copyFile, link, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';

const DOWNLOADS_DIR = './downloads';

/**
 * Final CLI output folder from `SC_GATE_DL_CLI_DIR`. Unset means `./downloads`.
 * `~user` is rejected because only the current user's home is expanded.
 */
export function cliDirFromEnv(value = process.env.SC_GATE_DL_CLI_DIR): string {
	const trimmed = value?.trim();
	if (!trimmed) return resolve(DOWNLOADS_DIR);
	if (trimmed === '~' || trimmed.startsWith('~/')) {
		return join(homedir(), trimmed.slice(1));
	}
	if (trimmed.startsWith('~')) {
		throw new Error(
			`SC_GATE_DL_CLI_DIR=${trimmed} is not supported: ~user paths are not supported. Use an absolute path or ~/...`,
		);
	}
	return resolve(trimmed);
}

function errorCode(error: unknown): unknown {
	return error instanceof Error && 'code' in error ? error.code : undefined;
}

async function isInDirectory(path: string, dir: string): Promise<boolean> {
	return (await realpath(dirname(path))) === (await realpath(dir));
}

/**
 * Copy a file under a free name in `dir`, never replacing an existing file.
 * The copy is size-checked before the caller may remove the source.
 */
async function copyIntoDirectory(
	sourcePath: string,
	dir: string,
	filename: string,
): Promise<string> {
	const extension = extname(filename);
	const stem = basename(filename, extension);
	for (let n = 1; ; n += 1) {
		const candidate = n === 1 ? filename : `${stem} (${n})${extension}`;
		const target = join(dir, candidate);
		try {
			await link(sourcePath, target);
			return target;
		} catch (linkError) {
			if (errorCode(linkError) === 'EEXIST') continue;
		}
		try {
			await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
			const [copied, original] = await Promise.all([
				stat(target),
				stat(sourcePath),
			]);
			if (copied.size !== original.size) {
				throw new Error(`Copy of ${sourcePath} is incomplete`);
			}
			return target;
		} catch (copyError) {
			if (errorCode(copyError) === 'EEXIST') continue;
			await rm(target, { force: true });
			throw copyError;
		}
	}
}

/** Put a file into `dir` under a free name, removing the original only after the copy. */
async function placeIn(path: string, dir: string): Promise<string> {
	if (await isInDirectory(path, dir)) return resolve(path);
	const target = await copyIntoDirectory(path, dir, basename(path));
	try {
		await rm(path);
	} catch (removeError) {
		// Keep one copy so a retry cannot add a suffixed duplicate.
		await rm(target, { force: true }).catch(() => {});
		throw removeError;
	}
	return target;
}

/**
 * Deliver the finished CLI output into `destinationDir` and return the final
 * paths. A retained source (`removeSource: false`) is delivered too. A removed
 * source is deleted only after the output is in place. On failure, the error
 * names every file that still exists so the user can recover it.
 */
export async function deliverCliOutput(options: {
	outputPath: string;
	sourcePath: string;
	removeSource: boolean;
	destinationDir: string;
}): Promise<string[]> {
	const { outputPath, sourcePath, removeSource, destinationDir } = options;
	const delivered: string[] = [];
	try {
		await mkdir(destinationDir, { recursive: true });
		delivered.push(await placeIn(outputPath, destinationDir));
		if (resolve(sourcePath) !== resolve(outputPath)) {
			if (removeSource) {
				await rm(sourcePath, { force: true });
			} else {
				delivered.push(await placeIn(sourcePath, destinationDir));
			}
		}
	} catch (error) {
		const survivors = [outputPath, sourcePath, ...delivered]
			.map((path) => resolve(path))
			.filter((path) => existsSync(path));
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Delivery to ${resolve(destinationDir)} failed: ${message}. Files kept: ${[...new Set(survivors)].join(', ')}`,
		);
	}
	return delivered;
}
