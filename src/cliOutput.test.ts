import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cliOutputFromEnv } from './cliOutput';

describe('cliOutputFromEnv', () => {
	test('defaults to MP3 at 320 kbps in ./downloads with tag review', () => {
		expect(cliOutputFromEnv({})).toEqual({
			format: 'mp3-320',
			bitrateKbps: 320,
			dir: null,
			reviewTags: true,
		});
		expect(
			cliOutputFromEnv({
				SC_GATE_DL_CLI_FORMAT: ' ',
				SC_GATE_DL_CLI_DIR: '',
				SC_GATE_DL_REVIEW_TAGS: '',
			}).format,
		).toBe('mp3-320');
	});

	test('reads format, bitrate, folder and review switch', () => {
		expect(
			cliOutputFromEnv({
				SC_GATE_DL_CLI_FORMAT: 'M4A-AAC',
				SC_GATE_DL_BITRATE: '256',
				SC_GATE_DL_CLI_DIR: '~/Music',
				SC_GATE_DL_REVIEW_TAGS: 'FALSE',
			}),
		).toEqual({
			format: 'm4a-aac',
			bitrateKbps: 256,
			dir: join(homedir(), 'Music'),
			reviewTags: false,
		});
		expect(cliOutputFromEnv({ SC_GATE_DL_CLI_DIR: 'out' }).dir).toBe(
			resolve('out'),
		);
	});

	test('rejects unknown values with the setting named', () => {
		expect(() => cliOutputFromEnv({ SC_GATE_DL_CLI_FORMAT: 'wav' })).toThrow(
			'SC_GATE_DL_CLI_FORMAT',
		);
		expect(() => cliOutputFromEnv({ SC_GATE_DL_REVIEW_TAGS: 'yes' })).toThrow(
			'SC_GATE_DL_REVIEW_TAGS',
		);
		expect(() => cliOutputFromEnv({ SC_GATE_DL_BITRATE: '500' })).toThrow(
			'SC_GATE_DL_BITRATE',
		);
	});
});
