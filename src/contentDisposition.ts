export function filenameFromContentDisposition(
	value: string | null,
): string | null {
	if (!value) return null;
	const parameters = new Map<string, string>();
	// Consume complete quoted values: apostrophes and semicolons are filename
	// characters, and backslashes escape the following character.
	for (const match of value.matchAll(
		/(?:^|;)\s*([^=;\s]+)\s*=\s*("(?:\\.|[^"\\])*"|[^;]*)/g,
	)) {
		const name = match[1]?.toLowerCase();
		const raw = match[2]?.trim();
		if (!name || !raw) continue;
		parameters.set(
			name,
			raw.startsWith('"') && raw.endsWith('"')
				? raw.slice(1, -1).replace(/\\(.)/g, '$1')
				: raw,
		);
	}
	const extended = parameters.get('filename*')?.match(/^UTF-8'[^']*'(.*)$/i);
	if (extended?.[1]) {
		try {
			return decodeURIComponent(extended[1]);
		} catch {
			// A malformed extended value must not discard a usable plain filename.
		}
	}
	const plain = parameters.get('filename');
	if (!plain) return null;
	// Some servers send raw UTF-8 in the legacy filename parameter. Fetch exposes
	// these bytes as Latin-1. Only reinterpret them if they are valid UTF-8;
	// genuine Latin-1 and strings already decoded as Unicode stay unchanged.
	if ([...plain].every((character) => character.charCodeAt(0) <= 255)) {
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(
				Buffer.from(plain, 'latin1'),
			);
		} catch {
			// The header contains genuine Latin-1 rather than UTF-8 bytes.
		}
	}
	return plain;
}

function encodeRfc5987Value(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

export function attachmentContentDisposition(filename: string): string {
	const safeFilename = filename.replace(/[\r\n]/g, '_');
	const asciiFallback =
		safeFilename
			.normalize('NFKD')
			.replace(/[^\x20-\x7E]/g, '')
			.replace(/["\\]/g, '_')
			.trim() || 'download';

	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987Value(safeFilename)}`;
}
