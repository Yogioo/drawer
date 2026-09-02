import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig(() => {
	return {
		base: './',
		plugins: [cloudflare(), react()],
		server: {
			strictPort: Boolean(process.env.TAURI_ENV_PLATFORM),
			watch: {
				ignored: ['**/src-tauri/**'],
			},
		},
		build: process.env.TAURI_ENV_PLATFORM === 'windows' ? { target: 'chrome105' } : undefined,
	}
})
