export function resolveApiBase(
	location: Pick<Location, 'origin'> | undefined,
	configuredBase?: string,
): string {
	const configured = configuredBase?.trim().replace(/\/$/, '');
	if (configured) return configured;
	if (!location) return 'http://localhost:3000';

	const url = new URL(location.origin);
	url.port = '3000';
	return url.origin;
}
