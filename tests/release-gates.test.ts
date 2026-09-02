import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	findSidecarProcesses,
	validateReleaseArtifacts,
} from '../scripts/release-assertions.mjs'

test('detects forbidden descendants without flagging unrelated processes', () => {
	const processes = [
		{ pid: 100, parentPid: 1, name: 'drawer.exe' },
		{ pid: 101, parentPid: 100, name: 'WebView2.exe' },
		{ pid: 102, parentPid: 101, name: 'node.exe' },
		{ pid: 103, parentPid: 1, name: 'node.exe' },
	]

	assert.deepEqual(findSidecarProcesses(processes, 100), [{ pid: 102, parentPid: 101, name: 'node.exe' }])
})

test('requires non-empty release artifacts for every configured Windows target', () => {
	assert.deepEqual(
		validateReleaseArtifacts([
			{ path: 'Drawer-setup.exe', exists: true, size: 10 },
			{ path: 'Drawer.msi', exists: true, size: 20 },
		]),
		[]
	)
	assert.deepEqual(
		validateReleaseArtifacts([
			{ path: 'Drawer-setup.exe', exists: true, size: 10 },
			{ path: 'Drawer.msi', exists: false, size: 0 },
		]),
		['Drawer.msi']
	)
})
