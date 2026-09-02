import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CanvasAgentAction, CanvasElementSpec } from '../shared/canvas.ts'
import {
	createCanvasOperationAdapter,
	executeCanvasOperation,
	undoCanvasOperation,
	type CanvasOperationRecord,
} from '../client/canvas-operation.ts'

interface TestElement {
	id: string
	type: string
	x: number
	y: number
	width: number
	height: number
	version: number
}

function element(id: string, x: number, y = 0): TestElement {
	return { id, type: 'rectangle', x, y, width: 100, height: 80, version: 1 }
}

function spec(id: string, x: number): CanvasElementSpec {
	return { id, type: 'rectangle', x, y: 0, width: 100, height: 80 }
}

function adapter() {
	return createCanvasOperationAdapter<TestElement>({
		create: (specs) => specs.map((item) => element(item.id ?? `generated-${Math.random()}`, item.x, item.y)),
		update: (current, updates) => ({
			...current,
			...updates,
			version: current.version + 1,
		}),
		bump: (current) => ({ ...current, version: current.version + 1 }),
	})
}

test('executes an AI operation group atomically before it is committed', () => {
	const actions: CanvasAgentAction[] = [
		{ _type: 'update', elementId: 'one', updates: { x: 200 } },
		{ _type: 'create', elements: [spec('two', 400)] },
	]
	const before = [element('one', 0)]
	const after = executeCanvasOperation(before, actions, adapter())

	assert.deepEqual(
		after.map(({ id, x }) => ({ id, x })),
		[
			{ id: 'one', x: 200 },
			{ id: 'two', x: 400 },
		]
	)
	assert.equal(before[0].x, 0)

	assert.throws(
		() =>
			executeCanvasOperation(
				before,
				[...actions, { _type: 'move', elementId: 'missing', x: 1, y: 1 }],
				adapter()
			),
		/不存在/
	)
	assert.equal(before[0].x, 0)
})

test('undoes an AI group without removing a later user edit', () => {
	const before = [element('one', 0)]
	const after = executeCanvasOperation(
		before,
		[
			{ _type: 'update', elementId: 'one', updates: { x: 200 } },
			{ _type: 'create', elements: [spec('two', 400)] },
		],
		adapter()
	)
	const userEdited = after.map((current) =>
		current.id === 'one' ? { ...current, x: 900, version: current.version + 1 } : current
	)
	const record: CanvasOperationRecord<TestElement> = {
		id: 'ai-1',
		status: 'applied',
		actions: [],
		before,
		after,
	}

	assert.deepEqual(undoCanvasOperation(userEdited, record).map(({ id, x }) => ({ id, x })), [
		{ id: 'one', x: 900 },
	])
})

test('restores deleted and cleared elements while preserving later additions', () => {
	const before = [element('one', 0), element('two', 200)]
	const deleted = executeCanvasOperation(before, [{ _type: 'delete', elementId: 'two' }], adapter())
	const deleteRecord: CanvasOperationRecord<TestElement> = {
		id: 'ai-delete',
		status: 'applied',
		actions: [],
		before,
		after: deleted,
	}
	assert.deepEqual(undoCanvasOperation(deleted, deleteRecord).map(({ id }) => id), ['one', 'two'])

	const cleared = executeCanvasOperation(before, [{ _type: 'clear' }], adapter())
	const withUserAddition = [...cleared, element('user-edit', 700)]
	const clearRecord: CanvasOperationRecord<TestElement> = {
		id: 'ai-clear',
		status: 'applied',
		actions: [],
		before,
		after: cleared,
	}
	assert.deepEqual(undoCanvasOperation(withUserAddition, clearRecord).map(({ id }) => id), [
		'one',
		'two',
		'user-edit',
	])
})

test('restores AI scene ordering without replacing a later user element', () => {
	const before = [element('first', 0), element('second', 100), element('third', 200)]
	const after = executeCanvasOperation(
		before,
		[
			{
				_type: 'layout',
				operation: 'sort',
				elementIds: ['first', 'second', 'third'],
				axis: 'horizontal',
				direction: 'descending',
			},
		],
		adapter()
	)
	const record: CanvasOperationRecord<TestElement> = {
		id: 'ai-sort',
		status: 'applied',
		actions: [],
		before,
		after,
	}

	assert.deepEqual(undoCanvasOperation([...after, element('user-edit', 700)], record).map(({ id }) => id), [
		'first',
		'second',
		'third',
		'user-edit',
	])
	assert.deepEqual(
		undoCanvasOperation([after[0], element('user-middle', 700), ...after.slice(1)], record).map(({ id }) => id),
		['first', 'user-middle', 'second', 'third']
	)
})
