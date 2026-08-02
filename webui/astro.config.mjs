// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
	devToolbar: {
		enabled: false,
	},
	integrations: [react()],
	vite: {
		server: {
			// Allow embedding from SoundCloud via the userscript overlay iframe
			headers: {
				'Access-Control-Allow-Private-Network': 'true',
			},
		},
	},
});
