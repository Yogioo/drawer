import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createScenePersistence, readPersistedScene } from '../client/persistence.ts'

interface FakeStorage extends Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
	values: Map<string, string>
}

function storage(): FakeStorage {
	const values = new Map<string, string>()
	return {
		values,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	}
}

test('debounces scene writes and flushes the latest valid scene', () => {
	const target = storage()
	let timer: (() => void) | undefined
	let scheduled = 0
	let cleared = 0
	const persistence = createScenePersistence(target, 'scene', {
		setTimeout: (callback) => {
			scheduled += 1
			timer = callback
			return scheduled as unknown as ReturnType<typeof setTimeout>
		},
		clearTimeout: () => {
			cleared += 1
		},
	})

	persistence.schedule([{ id: 'one' }])
	persistence.schedule([{ id: 'two' }])

	assert.equal(target.getItem('scene'), null)
	assert.equal(scheduled, 2)
	assert.equal(cleared, 1)
	timer?.()
	assert.deepEqual(readPersistedScene(target, 'scene'), { elements: [{ id: 'two' }] })

	persistence.schedule([{ id: 'two' }])
	timer?.()
	assert.equal(target.values.size, 1)
})

test('flushes an empty scene by removing the old scene', () => {
	const target = storage()
	target.setItem('scene', JSON.stringify({ elements: [{ id: 'old' }] }))
	const persistence = createScenePersistence(target, 'scene', {
		setTimeout: (callback) => {
			callback()
			return 1 as unknown as ReturnType<typeof setTimeout>
		},
		clearTimeout: () => undefined,
	})

	persistence.schedule([])

	assert.equal(target.getItem('scene'), null)
})

test('retries a scene write after storage becomes available', () => {
	const target = storage()
	let unavailable = true
	const setItem = target.setItem
	target.setItem = (key, value) => {
		if (unavailable) throw new Error('storage unavailable')
		setItem(key, value)
	}
	let timer: (() => void) | undefined
	const persistence = createScenePersistence(target, 'scene', {
		setTimeout: (callback) => {
			timer = callback
			return 1 as unknown as ReturnType<typeof setTimeout>
		},
		clearTimeout: () => undefined,
	})
	const elements = [{ id: 'retry' }]

	persistence.schedule(elements)
	timer?.()
	assert.equal(target.getItem('scene'), null)

	unavailable = false
	persistence.schedule(elements)
	timer?.()
	assert.deepEqual(readPersistedScene(target, 'scene'), { elements })
})
