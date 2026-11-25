/** API port from `SC_GATE_DL_PORT`. Unset or blank means 3000. */
export function apiPortFromEnv(value = process.env.SC_GATE_DL_PORT): number {
	const text = value?.trim();
	if (!text) return 3000;
	const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	// Port 0 lets the OS pick one, which clients could not find.
	if (!(port >= 1 && port <= 65535)) {
		throw new Error(
			`SC_GATE_DL_PORT=${text} is not a valid port. Use a number from 1 to 65535, or leave it unset for 3000.`,
		);
	}
	return port;
}
