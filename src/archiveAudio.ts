import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { lookpath } from 'find-bin';
import { safeDownloadBasename } from './downloadCleanup';
import {
	pickUniqueDownloadFilename,
	withDownloadRenameLock,
} from './downloadRename';

const MAX_EXTRACTED_AUDIO_BYTES = 512 * 1024 * 1024;
const AUDIO_EXTENSION_PRIORITY = [
	'.flac',
	'.wav',
	'.aiff',
	'.aif',
	'.ape',
	'.wv',
	'.alac',
	'.mp3',
	'.m4a',
	'.aac',
	'.ogg',
	'.opus',
	'.webm',
] as const;

/** ZIP signatures for regular, empty, and spanned archives. */
export function hasZipSignature(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		((bytes[2] === 0x03 && bytes[3] === 0x04) ||
			(bytes[2] === 0x05 && bytes[3] === 0x06) ||
			(bytes[2] === 0x07 && bytes[3] === 0x08))
	);
}

function audioPriority(member: string): number {
	const extension = extname(member).toLowerCase();
	return AUDIO_EXTENSION_PRIORITY.indexOf(
		extension as (typeof AUDIO_EXTENSION_PRIORITY)[number],
	);
}

/** Pick one audio payload, preferring known lossless formats. */
export function selectArchiveAudioMember(members: string[]): string | null {
	const candidates = members
		.filter((member) => {
			const parts = member.split(/[\\/]/);
			const memberBase = parts.at(-1) ?? '';
			return (
				memberBase.length > 0 &&
				!member.endsWith('/') &&
				!parts.includes('__MACOSX') &&
				!memberBase.startsWith('._')
			);
		})
		.map((member) => ({ member, priority: audioPriority(member) }))
		.filter((candidate) => candidate.priority >= 0)
		.sort(
			(a, b) =>
				a.priority - b.priority ||
				a.member.split(/[\\/]/).length - b.member.split(/[\\/]/).length ||
				a.member.localeCompare(b.member),
		);
	return candidates[0]?.member ?? null;
}

function safeExtractedFilename(member: string): string {
	const memberBase = basename(member.replace(/\\/g, '/'));
	const withoutControlCharacters = [...memberBase]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 31 && code !== 127;
		})
		.join('');
	const cleaned = withoutControlCharacters
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned || `extracted-audio${extname(member)}`;
}

async function runForText(bin: string, args: string[]): Promise<string> {
	const process = Bun.spawn([bin, ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || `unzip exited with code ${exitCode}`);
	}
	return stdout;
}

async function allocateExtractedPath(
	downloadsDir: string,
	member: string,
): Promise<string> {
	return withDownloadRenameLock(async () => {
		const allocationId = crypto.randomUUID();
		const outputFilename = pickUniqueDownloadFilename({
			desiredFilename: safeExtractedFilename(member),
			// Extraction must never reuse the archive path, even when a ZIP is
			// misleadingly named with the same extension as its audio member.
			currentFilename: '',
			jobId: allocationId,
			exists: (name) => existsSync(join(downloadsDir, name)),
			isOwnedByOtherJob: () => false,
		});
		const outputPath = join(downloadsDir, outputFilename);
		await Bun.write(outputPath, new Uint8Array());
		return outputPath;
	});
}

async function extractMember(
	unzipBin: string,
	archivePath: string,
	member: string,
	outputPath: string,
): Promise<void> {
	const process = Bun.spawn([unzipBin, '-p', archivePath, member], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const stderrPromise = new Response(process.stderr).text();
	const writer = Bun.file(outputPath).writer();
	let extractedBytes = 0;
	try {
		for await (const chunk of process.stdout) {
			extractedBytes += chunk.byteLength;
			if (extractedBytes > MAX_EXTRACTED_AUDIO_BYTES) {
				process.kill();
				throw new Error(
					`Audio file in ZIP is too large (max ${MAX_EXTRACTED_AUDIO_BYTES} bytes)`,
				);
			}
			writer.write(chunk);
		}
		await writer.end();
		const stderr = await stderrPromise;
		const exitCode = await process.exited;
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `unzip exited with code ${exitCode}`);
		}
		if (extractedBytes === 0) {
			throw new Error('Selected audio file in ZIP is empty');
		}
	} catch (error) {
		process.kill();
		try {
			await writer.end();
		} catch {
			// Ignore a second close after extraction failure.
		}
		await Promise.allSettled([process.exited, stderrPromise]);
		await Bun.file(outputPath)
			.delete()
			.catch(() => {});
		throw error;
	}
}

/**
 * Return the original filename for normal downloads. For a ZIP, extract the
 * best audio member and remove the archive only after extraction succeeds.
 */
export async function resolveDownloadedAudio(
	filename: string,
	downloadsDir = './downloads',
): Promise<string> {
	const archiveFilename = safeDownloadBasename(filename);
	if (!archiveFilename) throw new Error('Downloaded filename is unsafe');
	const archivePath = join(downloadsDir, archiveFilename);
	const signature = new Uint8Array(
		await Bun.file(archivePath).slice(0, 4).arrayBuffer(),
	);
	if (!hasZipSignature(signature)) return archiveFilename;

	const unzipBin = await lookpath('unzip');
	if (!unzipBin) {
		throw new Error(
			'The downloaded file is a ZIP, but unzip is not installed or not in PATH.',
		);
	}

	const listing = await runForText(unzipBin, ['-Z1', archivePath]);
	const member = selectArchiveAudioMember(listing.split(/\r?\n/));
	if (!member) {
		throw new Error(
			'The downloaded ZIP does not contain a supported audio file',
		);
	}

	const outputPath = await allocateExtractedPath(downloadsDir, member);
	await extractMember(unzipBin, archivePath, member, outputPath);
	await Bun.file(archivePath).delete();
	console.log(`Extracted ${member} from ${archiveFilename}`);
	return basename(outputPath);
}
