import { readFile, rename, rm, writeFile } from 'node:fs/promises';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvFileOps {
	rename?: typeof rename;
}

/**
 * Set `KEY=value` lines in a dotenv file. Other lines, comments and blank lines
 * stay as they are. The file is replaced atomically with mode 600, so a failed
 * write keeps the old file. Errors never contain a value.
 */
export async function setEnvValues(
	path: string,
	values: Record<string, string>,
	ops: EnvFileOps = {},
): Promise<void> {
	for (const [key, value] of Object.entries(values)) {
		if (!KEY_RE.test(key)) throw new Error('Invalid env key.');
		if (/[\r\n]/.test(value)) throw new Error(`Invalid env value for ${key}.`);
	}

	let lines: string[] = [];
	try {
		const text = await readFile(path, 'utf8');
		lines = text.split('\n');
		if (lines.at(-1) === '') lines.pop();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}

	const pending = new Map(Object.entries(values));
	const next = lines.map((line) => {
		const key = line.match(
			/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/,
		)?.[1];
		if (key && pending.has(key)) {
			const value = pending.get(key) as string;
			pending.delete(key);
			return `${key}=${value}`;
		}
		return line;
	});
	for (const [key, value] of pending) next.push(`${key}=${value}`);

	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${next.join('\n')}\n`, { mode: 0o600 });
		// writeFile applies the mode only on create, which always holds for the unique temp name.
		await (ops.rename ?? rename)(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}
