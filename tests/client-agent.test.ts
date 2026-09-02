import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppState } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { createCanvasPrompt } from '../client/agent.ts'
import { MAX_CANVAS_CONTEXT_ELEMENTS, MAX_CANVAS_IMAGE_COUNT } from '../shared/canvas.ts'

function appState(selectedElementIds: Record<string, boolean> = {}): AppState {
	return {
		selectedElementIds,
		scrollX: 0,
		scrollY: 0,
		width: 800,
		height: 600,
		zoom: { value: 1 },
	} as AppState
}

function rectangle(id: string, x: number, y: number): ExcalidrawElement {
	return {
		id,
		type: 'rectangle',
		x,
		y,
		width: 100,
		height: 80,
		isDeleted: false,
		strokeColor: '#000000',
		backgroundColor: 'transparent',
		strokeWidth: 1,
		strokeStyle: 'solid',
		roughness: 1,
	} as ExcalidrawElement
}

function image(id: string, fileId = `${id}-file`, x = 100): ExcalidrawElement {
	return {
		...rectangle(id, x, 100),
		type: 'image',
		fileId,
		status: 'saved',
		scale: [1, 1],
		crop: null,
	} as ExcalidrawElement
}

function imageFiles(fileIds: readonly string[], dataUrl = 'data:image/png;base64,aGVsbG8=') {
	return Object.fromEntries(
		fileIds.map((id) => [
			id,
			{ id, mimeType: 'image/png', dataURL: dataUrl, created: 0 },
		])
	)
}

test('includes viewport elements and selected elements without uploading unrelated canvas content', () => {
	const prompt = createCanvasPrompt(
		'describe the current view',
		[rectangle('inside', 100, 100), rectangle('selected', 2_000, 2_000), rectangle('unrelated', 20_000, 20_000)],
		appState({ selected: true }),
		[]
	)

	assert.deepEqual(
		prompt.elements.map((element) => element.id),
		['inside', 'selected']
	)
	assert.deepEqual(prompt.selectedElementIds, ['selected'])
	assert.deepEqual(prompt.viewport, { x: 0, y: 0, w: 800, h: 600 })
})

test('bounds conversation history and element detail in the AI context', () => {
	const longText = (index: number) => String(index).repeat(1_500)
	const prompt = createCanvasPrompt(
		'keep context small',
		[rectangle('inside', 100, 100)],
		appState(),
		Array.from({ length: 10 }, (_, index) => ({
			role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
			content: longText(index),
		}))
	)

	assert.equal(prompt.history.length, 4)
	assert.equal(prompt.history[0].content.startsWith('6'), true)
	assert.equal(prompt.history.at(-1)?.content.length, 1_500)
	assert.equal(prompt.history.reduce((total, entry) => total + entry.content.length, 0), 6_000)
})

test('keeps selected elements when the viewport contains more than the context budget', () => {
	const prompt = createCanvasPrompt(
		'keep the selected item',
		[
			...Array.from({ length: 150 }, (_, index) => rectangle(`viewport-${index}`, index, index)),
			rectangle('selected-offscreen', 5_000, 5_000),
		],
		appState({ 'selected-offscreen': true }),
		[]
	)

	assert.equal(prompt.elements.length, 120)
	assert.equal(prompt.elements.some((element) => element.id === 'selected-offscreen'), true)
})

test('includes arrow binding relationships in the AI canvas context', () => {
	const prompt = createCanvasPrompt(
		'keep the connection attached',
		[
			rectangle('source', 100, 100),
			rectangle('target', 400, 100),
			{
				...rectangle('arrow', 100, 100),
				type: 'arrow',
				points: [[0, 40], [300, 40]],
				startBinding: { elementId: 'source', focus: 0, gap: 0 },
				endBinding: { elementId: 'target', focus: 0, gap: 0 },
				boundElements: null,
			} as ExcalidrawElement,
		],
		appState(),
		[]
	)

	const arrow = prompt.elements.find((element) => element.id === 'arrow')
	assert.equal(arrow?.startBindingElementId, 'source')
	assert.equal(arrow?.endBindingElementId, 'target')
})

test('omits selected elements that are outside the shared canvas protocol', () => {
	const prompt = createCanvasPrompt(
		'keep the supported selection',
		[
			rectangle('supported', 100, 100),
			{ ...rectangle('image', 200, 100), type: 'image' } as ExcalidrawElement,
		],
		appState({ supported: true, image: true }),
		[]
	)

	assert.deepEqual(prompt.selectedElementIds, ['supported'])
	assert.deepEqual(prompt.elements.map((element) => element.id), ['supported'])
})

test('includes selected image data only for an explicit image analysis request', () => {
	const prompt = createCanvasPrompt(
		'请分析选中的图片内容',
		[image('picture')],
		appState({ picture: true }),
		[],
		imageFiles(['picture-file'])
	)

	assert.equal(prompt.includeImageContext, true)
	assert.deepEqual(prompt.elements.map((element) => element.id), ['picture'])
	assert.deepEqual(prompt.elements[0].image, {
		fileId: 'picture-file',
		mimeType: 'image/png',
		dataUrl: 'data:image/png;base64,aGVsbG8=',
	})
})

test('keeps image context when the element budget is full', () => {
	const imageElement = image('picture', 'picture-file', 2_000)
	const selectedElements = [
		imageElement,
		...Array.from({ length: MAX_CANVAS_CONTEXT_ELEMENTS }, (_, index) => rectangle('shape-' + index, 100, 100)),
	]
	const prompt = createCanvasPrompt(
		'帮我看看这张图',
		selectedElements,
		appState(Object.fromEntries(selectedElements.map((element) => [element.id, true]))),
		[],
		imageFiles(['picture-file'])
	)

	assert.equal(prompt.elements.length, MAX_CANVAS_CONTEXT_ELEMENTS)
	assert.equal(prompt.elements.some((element) => element.id === 'picture'), true)
})

test('keeps image data private for ordinary canvas requests', () => {
	const prompt = createCanvasPrompt(
		'请在图片旁边画一个矩形',
		[image('picture')],
		appState({ picture: true }),
		[],
		imageFiles(['picture-file'])
	)

	assert.equal(prompt.includeImageContext, undefined)
	assert.deepEqual(prompt.elements, [])
})

test('reports a missing selected image file before sending a request', () => {
	assert.throws(
		() => createCanvasPrompt('描述这张图片', [image('picture')], appState({ picture: true }), [], {}),
		(error: unknown) => error instanceof Error && /图片文件缺失/.test(error.message)
	)
})

test('rejects image analysis that exceeds the image count limit', () => {
	const images = Array.from({ length: MAX_CANVAS_IMAGE_COUNT + 1 }, (_, index) => image(`picture-${index}`, `file-${index}`))

	assert.throws(
		() => createCanvasPrompt('分析这些图片', images, appState(Object.fromEntries(images.map((item) => [item.id, true]))), [], imageFiles(images.map((item) => item.fileId as string))),
		(error: unknown) => error instanceof Error && /最多分析/.test(error.message)
	)
})

test('rejects an image that exceeds the single-image size limit', () => {
	const oversizedDataUrl = `data:image/png;base64,${'a'.repeat(Math.ceil((5 * 1024 * 1024 + 1) * 4 / 3))}`

	assert.throws(
		() => createCanvasPrompt('分析这张图片', [image('picture')], appState({ picture: true }), [], imageFiles(['picture-file'], oversizedDataUrl)),
		(error: unknown) => error instanceof Error && /超过单张大小限制/.test(error.message)
	)
})
