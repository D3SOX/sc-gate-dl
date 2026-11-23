import { describe, expect, test } from 'bun:test';

const source = await Bun.file(
	new URL('./sc-gate-dl.user.js', import.meta.url),
).text();

function loadFormatHelpers(stored: { gm: unknown; local: string | null }) {
	const start = source.indexOf('\tconst OUTPUT_FORMATS = ');
	const end = source.indexOf('\n\tfunction getBrowserMode(', start);
	if (start < 0 || end < 0) throw new Error('format helpers not found');
	const body = source.slice(start, end).trim();
	return Function(
		'stored',
		`"use strict";
		const OUTPUT_FORMAT_KEY = 'sc-gate-dl-output-format';
		const GM_getValue = (_key, fallback) => (stored.gm ?? fallback);
		const GM_setValue = (_key, value) => { stored.gm = value; };
		const localStorage = {
			getItem: () => stored.local,
			setItem: (_key, value) => { stored.local = value; },
		};
		const PANEL_ID = 'sc-gate-dl-panel';
		const document = { getElementById: () => null, querySelector: () => null };
		function loadTrackIntoPanel() {}
		class HTMLSelectElement {}
		${body}
		return { getOutputFormat, setOutputFormat };`,
	)(stored) as {
		getOutputFormat(): string;
		setOutputFormat(value: string): void;
	};
}

describe('userscript output format selection', () => {
	test.each(['mp3', 'm4a-aac'])(
		'stores and restores the configurable %s format',
		(format) => {
			const stored = { gm: null, local: null } as {
				gm: unknown;
				local: string | null;
			};
			const { setOutputFormat, getOutputFormat } = loadFormatHelpers(stored);

			setOutputFormat(format);

			expect(getOutputFormat()).toBe(format);
		},
	);

	test('still restores the legacy mp3-320 selection', () => {
		const stored = { gm: null, local: 'mp3-320' } as {
			gm: unknown;
			local: string | null;
		};
		const { getOutputFormat } = loadFormatHelpers(stored);

		expect(getOutputFormat()).toBe('mp3-320');
	});

	test('rejects an unknown format and keeps the default', () => {
		const stored = { gm: null, local: null } as {
			gm: unknown;
			local: string | null;
		};
		const { setOutputFormat, getOutputFormat } = loadFormatHelpers(stored);

		setOutputFormat('ogg');

		expect(getOutputFormat()).toBe('mp3-320');
	});
});

describe('userscript format options are selectable', () => {
	const dialogStart = source.indexOf('\tfunction openFormatDialog()');
	const dialogEnd = source.indexOf(
		'\n\tfunction openBrowserModeDialog()',
		dialogStart,
	);
	const panelStart = source.indexOf('\t\t\tconst format = getOutputFormat();');
	const panelEnd = source.indexOf(
		'</select>',
		source.indexOf('class="sc-gate-dl-format"', panelStart),
	);
	const dialogSource = source.slice(dialogStart, dialogEnd);
	const panelSource = source.slice(panelStart, panelEnd);

	test.each(['mp3', 'm4a-aac'])('the format dialog offers %s', (format) => {
		expect(dialogSource).toContain(`value="${format}"`);
	});

	test.each(['mp3', 'm4a-aac'])('the panel selector offers %s', (format) => {
		expect(panelSource).toContain(`value="${format}"`);
	});
});
