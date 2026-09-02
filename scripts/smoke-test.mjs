import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { basename, resolve } from 'node:path'
import { findSidecarProcesses, validateReleaseArtifacts } from './release-assertions.mjs'

const host = '127.0.0.1'
const devPort = 1420
const previewPort = 4173

await runCommand('build')
await withServer(
	['run', 'dev', '--', '--host', host, '--port', String(devPort), '--strictPort'],
	devPort
)
await withServer(
	['run', 'preview', '--', '--host', host, '--port', String(previewPort), '--strictPort'],
	previewPort
)

if (process.platform === 'win32') {
	await withDesktopDev()
	await runCommand('desktop:build')
	await withDesktopBinary(resolve('src-tauri', 'target', 'release', 'drawer.exe'))
	assertWindowsReleaseArtifacts()
}

console.log('Browser startup smoke tests passed.')
if (process.platform === 'win32') console.log('Tauri development and production startup smoke tests passed.')

async function runCommand(script) {
	await new Promise((resolve, reject) => {
		const child = spawnNpm(['run', script], { stdio: 'inherit' })
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) resolve()
			else reject(new Error(`${script} exited with ${signal ?? `code ${code}`}`))
		})
	})
}

async function withServer(args, port) {
	const child = spawnNpm(args, { stdio: 'inherit' })
	try {
		const response = await waitForHttp(port, child)
		assert.equal(response.statusCode, 200)
		assert.match(response.body, /<div id="root"><\/div>/)
	} finally {
		await stopProcess(child)
	}
}

async function withDesktopDev() {
	const binary = resolve('src-tauri', 'target', 'debug', 'drawer.exe')
	assertProcessStopped(binary)
	const child = spawnNpm(['run', 'desktop:dev'], { stdio: 'inherit' })
	try {
		await waitForProcess(binary, child)
	} finally {
		await stopProcess(child)
	}
}

async function withDesktopBinary(binary) {
	assert.ok(existsSync(binary), `desktop binary does not exist: ${binary}`)
	assertProcessStopped(binary)
	const child = spawn(binary, [], { windowsHide: true, stdio: 'ignore' })
	try {
		await waitForProcess(binary, child)
		assert.deepEqual(findSidecarProcesses(readProcessSnapshot(), child.pid), [], 'release binary started an unexpected sidecar')
	} finally {
		await stopProcess(child)
	}
}

function assertWindowsReleaseArtifacts() {
	const paths = [
		resolve('src-tauri', 'target', 'release', 'bundle', 'nsis', 'Drawer_0.1.0_x64-setup.exe'),
		resolve('src-tauri', 'target', 'release', 'bundle', 'msi', 'Drawer_0.1.0_x64_en-US.msi'),
	]
	const invalid = validateReleaseArtifacts(
		paths.map((path) => ({ path, exists: existsSync(path), size: existsSync(path) ? statSync(path).size : 0 }))
	)
	assert.deepEqual(invalid, [], `missing or empty Windows release artifacts: ${invalid.join(', ')}`)
}

function spawnNpm(args, options) {
	const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
	const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...args] : args
	return spawn(command, commandArgs, spawnOptions(options))
}

function spawnOptions(options) {
	return {
		...options,
		windowsHide: true,
	}
}

async function waitForHttp(port, child) {
	const deadline = Date.now() + 30_000
	let lastError
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`server process exited with code ${child.exitCode} before startup`)
		}
		try {
			return await requestOnce(port)
		} catch (error) {
			lastError = error
			await new Promise((resolve) => setTimeout(resolve, 250))
		}
	}
	throw new Error(`server on port ${port} did not start: ${lastError?.message ?? 'unknown error'}`)
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
		if (child.exitCode !== null) {
			throw new Error(`desktop process exited with code ${child.exitCode} before startup`)
		}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	throw new Error(`desktop process ${name} did not start within 30 seconds`)
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

function assertProcessStopped(binary) {
	const name = basename(binary)
	assert.equal(isProcessRunning(name), false, `desktop process ${name} is already running`)
}

function requestOnce(port) {
	return new Promise((resolve, reject) => {
		const req = request({ host, port, path: '/', method: 'GET' }, (response) => {
			let body = ''
			response.setEncoding('utf8')
			response.on('data', (chunk) => (body += chunk))
			response.on('end', () => resolve({ statusCode: response.statusCode, body }))
		})
		req.once('error', reject)
		req.end()
	})
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
	if (process.platform === 'win32' && child.pid) {
		const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
			windowsHide: true,
			stdio: 'ignore',
		})
		await once(killer, 'exit').catch(() => undefined)
	} else {
		child.kill('SIGTERM')
	}
	await exited
}
