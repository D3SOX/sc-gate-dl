/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
	attachmentContentDisposition,
	filenameFromContentDisposition,
} from './contentDisposition';

describe('filenameFromContentDisposition', () => {
	test('keeps escaped apostrophes and the file extension', () => {
		expect(
			filenameFromContentDisposition(
				String.raw`attachment; filename="CLEOPARD2000 - R\'n\'D.wav"`,
			),
		).toBe("CLEOPARD2000 - R'n'D.wav");
		expect(
			filenameFromContentDisposition(`attachment; filename="Don't You.mp3"`),
		).toBe("Don't You.mp3");
	});

	test('decodes UTF-8 bytes exposed as Latin-1 by HTTP headers', () => {
		for (const filename of [
			'ØSLO - 2 REMEMBER.wav',
			'DJ Ra\u0308ucherlaks - Kinda Girl.wav',
		]) {
			const headerBytes = Buffer.from(filename, 'utf8').toString('latin1');
			expect(
				filenameFromContentDisposition(`attachment; filename="${headerBytes}"`),
			).toBe(filename);
		}
	});

	test('keeps genuine Latin-1 and already decoded Unicode intact', () => {
		for (const filename of ['Räucherlaks.wav', 'ØSLO.wav', '日本語.wav']) {
			expect(
				filenameFromContentDisposition(`attachment; filename="${filename}"`),
			).toBe(filename);
		}
	});

	test('prefers extended filenames with language tags and falls back when malformed', () => {
		expect(
			filenameFromContentDisposition(
				`attachment; filename="fallback.wav"; FILENAME* = UTF-8'en'%C3%98SLO.wav`,
			),
		).toBe('ØSLO.wav');
		expect(
			filenameFromContentDisposition(
				`attachment; filename="fallback.wav"; filename*=UTF-8''bad%ZZ.wav`,
			),
		).toBe('fallback.wav');
		expect(
			filenameFromContentDisposition(`attachment; filename*=UTF-8''bad%ZZ.wav`),
		).toBeNull();
	});

	test('handles semicolons and escaped quotes inside quoted filenames', () => {
		expect(
			filenameFromContentDisposition(
				String.raw`attachment; name="ignored; filename=wrong.wav"; filename="A; B \"mix\".wav"`,
			),
		).toBe('A; B "mix".wav');
		expect(
			filenameFromContentDisposition(
				`attachment; filename = unquoted.wav; size=42`,
			),
		).toBe('unquoted.wav');
		expect(filenameFromContentDisposition(null)).toBeNull();
	});
});

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
