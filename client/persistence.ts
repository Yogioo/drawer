export interface PersistedScene {
	elements: unknown[]
}

export interface ScenePersistenceOptions {
	delayMs?: number
	setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>
	clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void
}

type SceneStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const EMPTY_SCENE = ''
const DEFAULT_DELAY_MS = 500

export interface ScenePersistence {
	schedule(elements: readonly unknown[]): void
	flush(): void
	cancel(): void
}

export function createScenePersistence(
	storage: SceneStorage,
	key: string,
	options: ScenePersistenceOptions = {}
): ScenePersistence {
	const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
	const scheduleTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis)
	const cancelTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
	let pendingElements: readonly unknown[] | null = null
	let timer: ReturnType<typeof globalThis.setTimeout> | undefined
	let lastScheduledElements: readonly unknown[] | null = null
	let lastSerialized: string | undefined
	try {
		lastSerialized = storage.getItem(key) ?? undefined
	} catch {
		lastSerialized = undefined
	}

	const persistence: ScenePersistence = {
		schedule(elements) {
			if (lastScheduledElements && sameElements(lastScheduledElements, elements)) return
			lastScheduledElements = elements
			pendingElements = elements
			if (timer !== undefined) cancelTimer(timer)
			timer = scheduleTimer(() => persistence.flush(), delayMs)
		},
		flush() {
			if (timer !== undefined) {
				cancelTimer(timer)
				timer = undefined
			}
			if (pendingElements === null) return

			const elements = pendingElements
			pendingElements = null
			if (elements.length === 0) {
				if (lastSerialized !== EMPTY_SCENE) {
					try {
						storage.removeItem(key)
						lastSerialized = EMPTY_SCENE
					} catch {
						lastScheduledElements = null
						// Keep the last valid scene when storage is unavailable.
					}
				}
				return
			}

			let serialized: string
			try {
				serialized = JSON.stringify({ elements })
			} catch {
				lastScheduledElements = null
				return
			}
			if (serialized === lastSerialized) return

			try {
				storage.setItem(key, serialized)
				lastSerialized = serialized
			} catch {
				lastScheduledElements = null
				// Keep the last valid scene when storage is unavailable or full.
			}
		},
		cancel() {
			if (timer !== undefined) cancelTimer(timer)
			timer = undefined
			pendingElements = null
			lastScheduledElements = null
		},
	}

	return persistence
}

function sameElements(left: readonly unknown[], right: readonly unknown[]): boolean {
	return left.length === right.length && left.every((element, index) => element === right[index])
}

export function readPersistedScene(storage: Pick<Storage, 'getItem'>, key: string): PersistedScene | null {
	try {
		const raw = storage.getItem(key)
		if (!raw) return null
		const parsed: unknown = JSON.parse(raw)
		if (!isRecord(parsed) || !Array.isArray(parsed.elements)) return null
		return { elements: parsed.elements }
	} catch {
		return null
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}
