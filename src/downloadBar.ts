import { Presets, SingleBar } from 'cli-progress';

export interface DownloadBar {
	update(receivedBytes: number): void;
	stop(): void;
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
	if (totalBytes > 0) {
		const bar = new SingleBar(
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
		);
		bar.start(totalBytes, 0, {
			current_mb: 0,
			total_mb: mb(totalBytes),
		});
		return {
			update: (received) =>
				bar.update(received, {
					current_mb: mb(received),
					total_mb: mb(totalBytes),
				}),
			stop: () => bar.stop(),
		};
	}

	let last = 0;
	let received = 0;
	return {
		update: (bytes) => {
			received = bytes;
			if (now() - last < 5_000) return;
			last = now();
			write(`Downloading... ${mb(received)} MB`);
		},
		stop: () => write(`Downloaded ${mb(received)} MB`),
	};
}
