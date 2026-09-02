const FORBIDDEN_SIDECAR_NAMES = new Set([
	'node.exe',
	'npm.exe',
	'npm.cmd',
	'wrangler.exe',
	'wrangler.cmd',
	'cloudflared.exe',
])

export function findSidecarProcesses(processes, rootPid) {
	const descendants = new Set([rootPid])
	let changed = true
	while (changed) {
		changed = false
		for (const process of processes) {
			if (descendants.has(process.parentPid) && !descendants.has(process.pid)) {
				descendants.add(process.pid)
				changed = true
			}
		}
	}

	return processes
		.filter(
			(process) =>
				process.pid !== rootPid &&
				descendants.has(process.pid) &&
				FORBIDDEN_SIDECAR_NAMES.has(process.name.toLowerCase())
		)
		.sort((left, right) => left.pid - right.pid)
}

export function validateReleaseArtifacts(artifacts) {
	return artifacts
		.filter((artifact) => !artifact.exists || !Number.isFinite(artifact.size) || artifact.size <= 0)
		.map((artifact) => artifact.path)
}
