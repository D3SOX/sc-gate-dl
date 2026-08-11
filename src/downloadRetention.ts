export function deleteAfterDownloadEnabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === 'true';
}

/**
 * Proxy a file stream and run cleanup only after every byte was consumed.
 * Cancelling or failing the response deliberately keeps the source file.
 */
export function streamWithSuccessfulDownloadCleanup(
	source: ReadableStream<Uint8Array>,
	cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let complete = false;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (!result.done) {
					controller.enqueue(result.value);
					return;
				}
				complete = true;
				try {
					await cleanup();
				} catch (error) {
					console.error('Post-download cleanup failed:', error);
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel(reason) {
			if (!complete) await reader.cancel(reason);
		},
	});
}
