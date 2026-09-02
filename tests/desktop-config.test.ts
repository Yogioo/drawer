import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
	productName: string
	identifier: string
	build: {
		frontendDist: string
		devUrl: string
		beforeDevCommand: string
		beforeBuildCommand: string
	}
	app: {
		windows: Array<{
			label: string
			title: string
			width: number
			height: number
			minWidth: number
			minHeight: number
		}>
	}
	bundle: { targets: string[]; icon: string[] }
}
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	scripts: Record<string, string>
}
const smokeTest = readFileSync(new URL('../scripts/smoke-test.mjs', import.meta.url), 'utf8')

test('configures Tauri to use the browser build and a stable desktop window', () => {
	assert.equal(config.productName, 'Drawer')
	assert.equal(config.identifier, 'com.yogioo.drawer')
	assert.deepEqual(config.build, {
		frontendDist: '../dist/client',
		devUrl: 'http://localhost:1420',
		beforeDevCommand: 'npm run dev -- --port 1420',
		beforeBuildCommand: 'npm run build',
	})
	assert.deepEqual(config.app.windows[0], {
		label: 'main',
		title: 'Drawer',
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 600,
		resizable: true,
		fullscreen: false,
	})
})

test('configures Windows installers and single-instance startup', () => {
	assert.deepEqual(config.bundle.targets, ['nsis', 'msi'])
	assert.ok(config.bundle.icon.includes('icons/icon.ico'))
	const cargoToml = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
	const libRs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
	assert.match(cargoToml, /tauri-plugin-single-instance/)
	assert.match(libRs, /tauri_plugin_single_instance::init/)
})

test('exposes browser and desktop lifecycle commands', () => {
	assert.equal(packageJson.scripts.dev, 'vite --host')
	assert.equal(packageJson.scripts['desktop:dev'], 'tauri dev')
	assert.equal(packageJson.scripts['desktop:build'], 'tauri build')
	assert.equal(packageJson.scripts['desktop:build:debug'], 'tauri build --debug')
	assert.equal(packageJson.scripts['test:smoke'], 'node scripts/smoke-test.mjs')
	assert.match(smokeTest, /desktop:dev/)
	assert.match(smokeTest, /desktop:build/)
})
