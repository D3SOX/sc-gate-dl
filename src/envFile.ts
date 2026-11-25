import { readFile, rename, rm, writeFile } from 'node:fs/promises';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Set `KEY=value` lines in a dotenv file. Other lines, comments and blank lines
 * stay as they are, and so does an `export ` prefix. The file is replaced
 * atomically with mode 600, so a failed write keeps the old file. Errors never
 * contain a value.
 */
export async function setEnvValues(
	path: string,
	values: Record<string, string>,
	ops: { rename?: typeof rename } = {},
): Promise<void> {
	for (const [key, value] of Object.entries(values)) {
		if (!KEY_RE.test(key)) throw new Error('Invalid env key.');
		if (/[\r\n]/.test(value)) throw new Error(`Invalid env value for ${key}.`);
	}

	let lines: string[] = [];
	try {
		lines = (await readFile(path, 'utf8')).split('\n');
		if (lines.at(-1) === '') lines.pop();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}

	const missing = new Set(Object.keys(values));
	const next = lines.map((line) => {
		const match = line.match(
			/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/,
		);
		const key = match?.[2];
		if (!key || !Object.hasOwn(values, key)) return line;
		missing.delete(key);
		return `${match[1]}${key}=${values[key]}`;
	});
	for (const key of missing) next.push(`${key}=${values[key]}`);

	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		// The mode applies on create, which always holds for the unique temp name.
		await writeFile(temporary, `${next.join('\n')}\n`, { mode: 0o600 });
		await (ops.rename ?? rename)(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}
