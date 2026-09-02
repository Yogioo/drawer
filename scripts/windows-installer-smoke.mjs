import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { findSidecarProcesses } from './release-assertions.mjs'

if (process.platform !== 'win32') {
	console.log('Windows installer smoke test skipped on non-Windows.')
	process.exit(0)
}

const installer = resolve('src-tauri', 'target', 'release', 'bundle', 'nsis', 'Drawer_0.1.0_x64-setup.exe')
assert.ok(existsSync(installer), `NSIS installer does not exist: ${installer}`)
const installDirectory = mkdtempSync(join(tmpdir(), 'drawer-release-'))

try {
	const installResult = spawnSync(installer, ['/S', `/D=${installDirectory}`], {
		encoding: 'utf8',
		windowsHide: true,
		stdio: 'ignore',
	})
	assert.equal(installResult.status, 0, 'NSIS installer failed')

	const binary = join(installDirectory, 'drawer.exe')
	const uninstaller = join(installDirectory, 'uninstall.exe')
	assert.ok(existsSync(binary), `installed application does not exist: ${binary}`)
	assert.ok(existsSync(uninstaller), `uninstaller does not exist: ${uninstaller}`)

	const child = spawn(binary, [], { windowsHide: true, stdio: 'ignore' })
	try {
		await waitForProcess(binary, child)
		assert.deepEqual(findSidecarProcesses(readProcessSnapshot(), child.pid), [])
	} finally {
		await stopProcess(child)
	}

	const uninstallResult = spawnSync(uninstaller, ['/S'], {
		encoding: 'utf8',
		windowsHide: true,
		stdio: 'ignore',
	})
	assert.equal(uninstallResult.status, 0, 'NSIS uninstaller failed')
	await waitForPathRemoved(binary)
	console.log('Windows NSIS install, startup, sidecar, and uninstall smoke tests passed.')
} finally {
	if (existsSync(installDirectory)) rmSync(installDirectory, { recursive: true, force: true })
}

async function waitForProcess(binary, child) {
	const deadline = Date.now() + 30_000
	const name = basename(binary)
	let startupError
	child.once('error', (error) => {
		startupError = error
	})
	while (Date.now() < deadline) {
		if (startupError) throw startupError
		if (isProcessRunning(name)) return
		if (child.exitCode !== null) throw new Error(`desktop process exited with code ${child.exitCode} before startup`)
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	throw new Error(`desktop process ${name} did not start within 30 seconds`)
}

async function waitForPathRemoved(path) {
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		if (!existsSync(path)) return
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	throw new Error(`installed application still exists after uninstall: ${path}`)
}

function isProcessRunning(name) {
	const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
		encoding: 'utf8',
		windowsHide: true,
	})
	return result.status === 0 && result.stdout.toLowerCase().includes(`"${name.toLowerCase()}"`)
}

function readProcessSnapshot() {
	const result = spawnSync(
		'powershell.exe',
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
		],
		{ encoding: 'utf8', windowsHide: true }
	)
	assert.equal(result.status, 0, `could not inspect the Windows process tree: ${result.stderr}`)
	const value = result.stdout.trim() ? JSON.parse(result.stdout) : []
	return (Array.isArray(value) ? value : [value]).map((process) => ({
		pid: Number(process.ProcessId),
		parentPid: Number(process.ParentProcessId),
		name: String(process.Name),
	}))
}

async function stopProcess(child) {
	let resolveExit
	const exited = new Promise((resolve) => {
		resolveExit = resolve
		child.once('exit', resolve)
	})
	if (child.exitCode !== null || child.signalCode !== null) {
		resolveExit()
		await exited
		return
	}
	if (child.pid) {
		const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
			windowsHide: true,
			stdio: 'ignore',
		})
		await once(killer, 'exit').catch(() => undefined)
	}
	await exited
}
