/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { attachmentContentDisposition } from './contentDisposition';

describe('attachmentContentDisposition', () => {
	test('uses an ASCII fallback and UTF-8 filename for decomposed Unicode', () => {
		const header = attachmentContentDisposition('Kama\u0308leon.mp3');

		expect(header).toBe(
			'attachment; filename="Kamaleon.mp3"; filename*=UTF-8\'\'Kama%CC%88leon.mp3',
		);
		expect(() => new Headers({ 'Content-Disposition': header })).not.toThrow();
	});

	test('prevents quotes and line breaks from escaping the header', () => {
		const header = attachmentContentDisposition('bad"name\r\n.mp3');

		expect(header).toBe(
			'attachment; filename="bad_name__.mp3"; filename*=UTF-8\'\'bad%22name__.mp3',
		);
		expect(() => new Headers({ 'Content-Disposition': header })).not.toThrow();
	});
});
