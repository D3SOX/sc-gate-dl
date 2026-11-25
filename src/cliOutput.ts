import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { outputBitrateFromEnv } from './audioProcessor';
import { reviewTagsFromEnv } from './jobOptions';
import type { OutputFormat } from './types';

const CLI_FORMATS: Record<string, OutputFormat> = {
	mp3: 'mp3-320',
	'm4a-aac': 'm4a-aac',
	flac: 'flac',
	original: 'original',
};

export interface CliOutput {
	format: OutputFormat;
	bitrateKbps: number;
	/** Folder finished files are moved to, or null to leave them in ./downloads. */
	dir: string | null;
	reviewTags: boolean;
}

/** CLI output settings. Unset or blank values mean the default; others throw. */
export function cliOutputFromEnv(
	env: Record<string, string | undefined> = process.env,
): CliOutput {
	const formatValue = env.SC_GATE_DL_CLI_FORMAT?.trim().toLowerCase() || 'mp3';
	const format = Object.hasOwn(CLI_FORMATS, formatValue)
		? CLI_FORMATS[formatValue]
		: undefined;
	if (!format) {
		throw new Error(
			`SC_GATE_DL_CLI_FORMAT=${formatValue} is not supported. Use ${Object.keys(CLI_FORMATS).join(', ')}.`,
		);
	}

	const dirValue = env.SC_GATE_DL_CLI_DIR?.trim();
	const dir = !dirValue
		? null
		: resolve(
				dirValue === '~' || dirValue.startsWith('~/')
					? join(homedir(), dirValue.slice(1))
					: dirValue,
			);

	return {
		format,
		bitrateKbps: outputBitrateFromEnv(env.SC_GATE_DL_BITRATE ?? ''),
		dir,
		reviewTags: reviewTagsFromEnv(env.SC_GATE_DL_REVIEW_TAGS ?? ''),
	};
}
