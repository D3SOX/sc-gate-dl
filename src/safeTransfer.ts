import { constants } from 'node:fs';
import { copyFile, link, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export type FileTransfer = { link: typeof link; copyFile: typeof copyFile };

const nodeTransfer: FileTransfer = { link, copyFile };

function errorCode(error: unknown): unknown {
	return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** Copy `from` to a new `to`. A failure after `to` was created removes it. */
async function publish(
	from: string,
	to: string,
	transfer: FileTransfer,
): Promise<void> {
	try {
		await transfer.copyFile(from, to, constants.COPYFILE_EXCL);
	} catch (error) {
		if (errorCode(error) !== 'EEXIST') {
			await rm(to, { force: true }).catch(() => {});
		}
		throw error;
	}
}

/**
 * Place `sourcePath` into `dir` under a free name, never replacing an existing
 * file. The source is removed only after the target is in place, unless
 * `removeSource` is false. The target is removed if the source cannot be removed.
 */
export async function placeIntoDirectory(options: {
	sourcePath: string;
	dir: string;
	filename?: string;
	removeSource?: boolean;
	transfer?: FileTransfer;
}): Promise<string> {
	const {
		sourcePath,
		dir,
		filename = basename(options.sourcePath),
		removeSource = true,
		transfer = nodeTransfer,
	} = options;
	const extension = extname(filename);
	const stem = basename(filename, extension);
	for (let n = 1; ; n += 1) {
		const candidate = n === 1 ? filename : `${stem} (${n})${extension}`;
		const target = join(dir, candidate);
		try {
			await transfer.link(sourcePath, target);
		} catch (linkError) {
			if (errorCode(linkError) === 'EEXIST') continue;
			const staging = join(
				dir,
				`.${stem}.${crypto.randomUUID()}${extension}.partial`,
			);
			try {
				await transfer.copyFile(sourcePath, staging, constants.COPYFILE_EXCL);
				const [copied, original] = await Promise.all([
					stat(staging),
					stat(sourcePath),
				]);
				if (copied.size !== original.size) {
					throw new Error(`Copy of ${sourcePath} is incomplete`);
				}
				await publish(staging, target, transfer);
			} catch (copyError) {
				if (errorCode(copyError) === 'EEXIST') continue;
				throw copyError;
			} finally {
				await rm(staging, { force: true });
			}
		}
		if (removeSource) {
			try {
				await rm(sourcePath);
			} catch (removeError) {
				await rm(target, { force: true }).catch(() => {});
				throw removeError;
			}
		}
		return target;
	}
}
