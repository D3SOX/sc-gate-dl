import { rename, rm } from 'node:fs/promises';
import { Presets, SingleBar } from 'cli-progress';
import { AUDIO_OR_ARCHIVE_EXT_RE } from './directLinkRules';
import type { ProgressCallback } from './hypeddit';
import type { JobProgress } from './types';

/** Cap for streamed downloads (audio files and zip packages). */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
	'audio/mpeg': '.mp3',
	'audio/mp3': '.mp3',
	'audio/wav': '.wav',
	'audio/wave': '.wav',
	'audio/x-wav': '.wav',
	'audio/vnd.wave': '.wav',
	'audio/flac': '.flac',
	'audio/x-flac': '.flac',
	'audio/aiff': '.aiff',
	'audio/x-aiff': '.aiff',
	'audio/mp4': '.m4a',
	'audio/x-m4a': '.m4a',
	'audio/aac': '.aac',
	'audio/ogg': '.ogg',
	'audio/opus': '.opus',
	'application/zip': '.zip',
	'application/x-zip-compressed': '.zip',
};

/**
 * Add the extension the Content-Type names when the filename has no known
 * audio or archive extension (`Track.Remix` has none). Without a recognizable
 * type the name stays as it is instead of guessing a format.
 */
export function withContentTypeExtension(
	filename: string,
	contentType: string | null,
): string {
	if (AUDIO_OR_ARCHIVE_EXT_RE.test(filename)) return filename;
	const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
	return `${filename}${EXTENSION_BY_CONTENT_TYPE[type] ?? ''}`;
}

export interface DownloadBar {
	update(receivedBytes: number): void;
	/** Pass false when the download failed or was cancelled. Only the first call counts. */
	stop(completed?: boolean): void;
}

const mb = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(2));

/**
 * Terminal progress for a streamed download. Without a known size (no
 * Content-Length) a bar cannot show a percentage, so it prints a throttled MB
 * line instead; either way a long download no longer looks like a hang.
 */
export function createDownloadBar(
	totalBytes: number,
	write: (line: string) => void = (line) => console.log(line),
	now: () => number = Date.now,
): DownloadBar {
	let stopped = false;
	let received = 0;
	let lastLine = 0;
	const bar =
		totalBytes > 0
			? new SingleBar(
					{
						format:
							'Downloading {bar} {percentage}% | {current_mb}/{total_mb} MB | ETA: {eta_formatted}',
						hideCursor: true,
					},
					{
						barCompleteChar: '█',
						barIncompleteChar: '░',
						format: Presets.shades_classic.format,
					},
				)
			: null;
	bar?.start(totalBytes, 0, { current_mb: 0, total_mb: mb(totalBytes) });

	return {
		update: (bytes) => {
			if (stopped) return;
			received = bytes;
			if (bar) {
				bar.update(bytes, { current_mb: mb(bytes), total_mb: mb(totalBytes) });
				return;
			}
			if (now() - lastLine < 5_000) return;
			lastLine = now();
			write(`Downloading... ${mb(received)} MB`);
		},
		stop: (completed = true) => {
			if (stopped) return;
			stopped = true;
			bar?.stop();
			if (!completed) write(`Download stopped at ${mb(received)} MB`);
			else if (!bar) write(`Downloaded ${mb(received)} MB`);
		},
	};
}

/** Report streamed bytes as Web UI `downloading` progress. */
export function downloadProgressReporter(
	callback: ProgressCallback | null | undefined,
	extra?: Partial<JobProgress>,
): (receivedBytes: number, totalBytes: number) => void {
	return (receivedBytes, totalBytes) => {
		const received = (receivedBytes / 1024 / 1024).toFixed(1);
		callback?.(
			'downloading',
			totalBytes > 0
				? `Downloading... ${received} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`
				: `Downloading... ${received} MB`,
			totalBytes > 0 ? Math.min(100, (receivedBytes / totalBytes) * 100) : 0,
			{
				...extra,
				downloadBytes: receivedBytes,
				...(totalBytes > 0 && { totalBytes }),
			},
		);
	};
}

/**
 * Stream a download body to `destPath` through a `.part` file that is renamed
 * into place only once the whole body arrived. On failure or cancel the partial
 * file and the reserved `destPath` are removed.
 */
export async function saveDownloadStream(
	body: ReadableStream<Uint8Array>,
	destPath: string,
	options: {
		/** From Content-Length; 0 when unknown. */
		totalBytes: number;
		signal?: AbortSignal;
		maxBytes?: number;
		/** Called at most every 250 ms while bytes arrive. */
		onProgress?: (receivedBytes: number, totalBytes: number) => void;
	},
): Promise<number> {
	const {
		totalBytes,
		signal,
		maxBytes = MAX_DOWNLOAD_BYTES,
		onProgress,
	} = options;
	const tempPath = `${destPath}.${crypto.randomUUID()}.part`;
	const writer = Bun.file(tempPath).writer();
	const reader = body.getReader();
	const bar = createDownloadBar(totalBytes);
	let received = 0;
	let lastProgress = 0;
	let completed = false;
	try {
		while (true) {
			if (signal?.aborted) throw new Error('Download cancelled');
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maxBytes) {
				throw new Error(
					`Download too large (${received} bytes; max ${maxBytes})`,
				);
			}
			writer.write(value);
			bar.update(received);
			const now = Date.now();
			if (onProgress && now - lastProgress >= 250) {
				lastProgress = now;
				onProgress(received, totalBytes);
			}
		}
		await writer.end();
		if (signal?.aborted) throw new Error('Download cancelled');
		await rename(tempPath, destPath);
		completed = true;
	} finally {
		bar.stop(completed);
		if (!completed) {
			await reader.cancel().catch(() => {});
			try {
				await writer.end();
			} catch {
				// Writer may already be closed.
			}
			await rm(tempPath, { force: true }).catch(() => {});
			await rm(destPath, { force: true }).catch(() => {});
		}
	}
	return received;
}
