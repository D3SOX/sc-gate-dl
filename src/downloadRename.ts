import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/** Serialize destination allocation + rename + ownership claim. */
let renameChain: Promise<unknown> = Promise.resolve();

export function withDownloadRenameLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = renameChain.then(fn, fn);
	renameChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** Choose a downloads/ filename that is free on disk and not owned by another job. */
export function pickUniqueDownloadFilename(options: {
	desiredFilename: string;
	currentFilename: string;
	jobId: string;
	exists: (filename: string) => boolean;
	isOwnedByOtherJob: (filename: string, jobId: string) => boolean;
}): string {
	const { desiredFilename, currentFilename, jobId, exists, isOwnedByOtherJob } =
		options;

	if (desiredFilename === currentFilename) {
		return currentFilename;
	}

	let finalName = desiredFilename;
	const blocked =
		isOwnedByOtherJob(finalName, jobId) ||
		(exists(finalName) && finalName !== currentFilename);

	if (!blocked) {
		return finalName;
	}

	const ext = extname(desiredFilename);
	const stem = basename(desiredFilename, ext);
	const shortId = jobId.slice(0, 8);
	finalName = `${stem} [${shortId}]${ext}`;
	let n = 2;
	while (exists(finalName) || isOwnedByOtherJob(finalName, jobId)) {
		finalName = `${stem} [${shortId}] (${n})${ext}`;
		n += 1;
	}
	return finalName;
}

/**
 * Atomically allocate a destination, rename the file, and claim it on the job.
 * Concurrent callers are serialized so two jobs cannot race onto the same name.
 */
export async function renameDownloadFileExclusive(options: {
	downloadsDir: string;
	jobId: string;
	currentFilename: string;
	desiredFilename: string;
	isOwnedByOtherJob: (filename: string, jobId: string) => boolean;
	claimFilenames: (jobId: string, filename: string) => void;
}): Promise<string> {
	const {
		downloadsDir,
		jobId,
		currentFilename,
		desiredFilename,
		isOwnedByOtherJob,
		claimFilenames,
	} = options;

	return withDownloadRenameLock(async () => {
		if (currentFilename === desiredFilename) {
			claimFilenames(jobId, currentFilename);
			return currentFilename;
		}

		const finalName = pickUniqueDownloadFilename({
			desiredFilename,
			currentFilename,
			jobId,
			exists: (filename) => existsSync(join(downloadsDir, filename)),
			isOwnedByOtherJob,
		});

		await rename(
			join(downloadsDir, currentFilename),
			join(downloadsDir, finalName),
		);
		claimFilenames(jobId, finalName);
		return finalName;
	});
}
