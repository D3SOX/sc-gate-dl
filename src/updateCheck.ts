import { resolve } from 'node:path';

const REPO_DIR = resolve(import.meta.dir, '..');
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export type ServerVersion = {
	/** The commit the server started from, or null outside a Git checkout. */
	commit: string | null;
	/** The newest commit on origin's default branch, or null when unknown. */
	latestCommit: string | null;
	/** Whether the server lacks `latestCommit`. */
	outdated: boolean;
};

async function git(repoDir: string, args: string[]) {
	const proc = Bun.spawn(['git', '-C', repoDir, ...args], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'ignore',
		// Never wait for credentials of a private remote.
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		timeout: 15_000,
	});
	const [stdout, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), exitCode };
}

/** The checked-out commit, or null when `repoDir` isn't a Git checkout. */
export async function readHeadCommit(
	repoDir = REPO_DIR,
): Promise<string | null> {
	try {
		const { stdout, exitCode } = await git(repoDir, ['rev-parse', 'HEAD']);
		return exitCode === 0 && stdout ? stdout : null;
	} catch {
		return null;
	}
}

/**
 * Compares `commit` with origin's default branch. Local commits on top of it
 * count as up to date. A remote commit Git doesn't have yet counts as newer.
 */
export async function checkServerVersion(
	commit: string | null,
	repoDir = REPO_DIR,
): Promise<ServerVersion> {
	if (!commit) return { commit, latestCommit: null, outdated: false };
	try {
		const remote = await git(repoDir, ['ls-remote', 'origin', 'HEAD']);
		const latestCommit = remote.stdout.split(/\s/)[0] || null;
		if (remote.exitCode !== 0 || !latestCommit) {
			return { commit, latestCommit: null, outdated: false };
		}
		if (latestCommit === commit) {
			return { commit, latestCommit, outdated: false };
		}
		const ancestor = await git(repoDir, [
			'merge-base',
			'--is-ancestor',
			latestCommit,
			commit,
		]);
		return { commit, latestCommit, outdated: ancestor.exitCode !== 0 };
	} catch {
		return { commit, latestCommit: null, outdated: false };
	}
}

/** Remembers the startup commit and checks for a newer one at most every 15 minutes. */
export function createVersionChecker(repoDir = REPO_DIR) {
	// Read now, so a `git pull` without a restart still counts as outdated.
	const startupCommit = readHeadCommit(repoDir);
	let cached: { at: number; version: Promise<ServerVersion> } | null = null;
	return (): Promise<ServerVersion> => {
		if (!cached || Date.now() - cached.at > CHECK_INTERVAL_MS) {
			cached = {
				at: Date.now(),
				version: startupCommit.then((commit) =>
					checkServerVersion(commit, repoDir),
				),
			};
		}
		return cached.version;
	};
}
