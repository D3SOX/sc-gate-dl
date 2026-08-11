// @ts-check
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	server: {
		host: true,
	},
	devToolbar: {
		enabled: false,
	},
	integrations: [react()],
	vite: {
		server: {
			fs: {
				allow: ['.', '../src/types.ts'],
			},
			// Allow embedding from SoundCloud via the userscript overlay iframe
			headers: {
				'Access-Control-Allow-Private-Network': 'true',
			},
		},
	},
});
