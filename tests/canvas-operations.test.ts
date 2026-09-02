import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	applyCanvasBinding,
	applyCanvasLayout,
	type CanvasBindingElement,
	type CanvasLayoutAction,
} from '../shared/canvas.ts'

function element(
	id: string,
	type: CanvasBindingElement['type'],
	x: number,
	y: number,
	width = 100,
	height = 50
): CanvasBindingElement {
	return { id, type, x, y, width, height }
}

test('aligns and distributes mixed canvas elements in place', () => {
	const elements = [
		element('rectangle', 'rectangle', 20, 40),
		element('text', 'text', 220, 100, 60, 30),
		element('arrow', 'arrow', 420, 10, 40, 20),
	]

	const aligned = applyCanvasLayout(elements, {
		_type: 'layout',
		operation: 'align',
		elementIds: ['rectangle', 'text', 'arrow'],
		alignment: 'middle',
	})
	assert.deepEqual(
		aligned.map(({ id, x, y }) => ({ id, x, y })),
		[
			{ id: 'rectangle', x: 20, y: 45 },
			{ id: 'text', x: 220, y: 55 },
			{ id: 'arrow', x: 420, y: 60 },
		]
	)

	const distributed = applyCanvasLayout(elements, {
		_type: 'layout',
		operation: 'distribute',
		elementIds: ['rectangle', 'text', 'arrow'],
		axis: 'horizontal',
	})
	assert.deepEqual(
		distributed.map(({ id, x }) => ({ id, x })),
		[
			{ id: 'rectangle', x: 20 },
			{ id: 'text', x: 240 },
			{ id: 'arrow', x: 420 },
		]
	)
})

test('sorts selected elements without changing unselected scene content', () => {
	const elements = [
		element('first', 'rectangle', 300, 0),
		element('unselected', 'ellipse', 0, 0),
		element('second', 'text', 100, 0),
	]

	const sorted = applyCanvasLayout(elements, {
		_type: 'layout',
		operation: 'sort',
		elementIds: ['first', 'second'],
		axis: 'horizontal',
		direction: 'ascending',
	})
	assert.deepEqual(sorted.map(({ id }) => id), ['second', 'unselected', 'first'])
})

test('leaves empty, single-element, and invalid selections unchanged', () => {
	const elements = [element('one', 'rectangle', 10, 20), element('two', 'ellipse', 80, 120)]
	const action: CanvasLayoutAction = {
		_type: 'layout',
		operation: 'distribute',
		elementIds: ['one', 'missing'],
		axis: 'vertical',
	}

	assert.deepEqual(applyCanvasLayout(elements, action), elements)
	assert.deepEqual(
		applyCanvasLayout(elements, { ...action, elementIds: [] }),
		elements
	)
	assert.deepEqual(
		applyCanvasLayout(elements, { ...action, elementIds: ['one'] }),
		elements
	)
})

test('binds both arrow endpoints and keeps target reverse references', () => {
	const elements: CanvasBindingElement[] = [
		{ ...element('left', 'rectangle', 0, 0), boundElements: [{ id: 'label', type: 'text' }] },
		{ ...element('right', 'ellipse', 300, 0), boundElements: null },
		{
			...element('arrow', 'arrow', 0, 0, 300, 50),
			points: [{ x: 0, y: 25 }, { x: 300, y: 25 }],
			startBinding: null,
			endBinding: null,
			boundElements: null,
		},
	]

	const bound = applyCanvasBinding(elements, {
		_type: 'bind',
		arrowId: 'arrow',
		startElementId: 'left',
		endElementId: 'right',
	})
	const arrow = bound.find(({ id }) => id === 'arrow')
	assert.equal(arrow?.startBinding?.elementId, 'left')
	assert.equal(arrow?.endBinding?.elementId, 'right')
	assert.deepEqual(bound.find(({ id }) => id === 'left')?.boundElements, [
		{ id: 'label', type: 'text' },
		{ id: 'arrow', type: 'arrow' },
	])
	assert.deepEqual(bound.find(({ id }) => id === 'right')?.boundElements, [{ id: 'arrow', type: 'arrow' }])
})

test('updates an existing binding without leaving a stale reverse reference', () => {
	const elements: CanvasBindingElement[] = [
		{ ...element('old', 'rectangle', 0, 0), boundElements: [{ id: 'arrow', type: 'arrow' }] },
		{ ...element('new', 'diamond', 300, 0), boundElements: null },
		{
			...element('arrow', 'arrow', 0, 0, 300, 50),
			points: [{ x: 0, y: 25 }, { x: 300, y: 25 }],
			startBinding: { elementId: 'old', focus: 0, gap: 1 },
			endBinding: null,
			boundElements: null,
		},
	]

	const updated = applyCanvasBinding(elements, {
		_type: 'bind',
		arrowId: 'arrow',
		startElementId: 'new',
		endElementId: null,
	})
	assert.equal(updated.find(({ id }) => id === 'arrow')?.startBinding?.elementId, 'new')
	assert.deepEqual(updated.find(({ id }) => id === 'old')?.boundElements, [])
	assert.deepEqual(updated.find(({ id }) => id === 'new')?.boundElements, [{ id: 'arrow', type: 'arrow' }])
})
