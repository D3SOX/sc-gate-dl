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
