import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamCanvasAgent } from '../client/agent.ts'
import { AgentService, parseResponse } from '../worker/agent/AgentService.ts'
import { handleWorkerRequest } from '../worker/handler.ts'
import type { Environment } from '../worker/environment.ts'
import { MAX_CANVAS_IMAGE_COUNT } from '../shared/canvas.ts'

const API_KEY = 'test-key-that-must-never-be-logged'
const PROMPT = 'draw a private architecture diagram'

function environment(overrides: Partial<Environment> = {}): Environment {
	return {
		OPENAI_API_KEY: API_KEY,
		OPENAI_BASE_URL: 'https://provider.example/v1',
		OPENAI_MODEL: 'test-model',
		ALLOWED_ORIGINS: 'https://app.example.com',
		AI_UPSTREAM_TIMEOUT_MS: '50',
		AI_UPSTREAM_MAX_RETRIES: '1',
		...overrides,
	}
}

function prompt() {
	return {
		message: PROMPT,
		elements: [
			{
				id: 'private-element',
				type: 'rectangle' as const,
				x: 10,
				y: 20,
				width: 100,
				height: 80,
			},
		],
		selectedElementIds: [],
		viewport: { x: 0, y: 0, w: 800, h: 600 },
		history: [],
	}
}

function imagePrompt(overrides: Record<string, unknown> = {}) {
	return {
		...prompt(),
		message: '分析选中的图片',
		includeImageContext: true,
		elements: [
			{
				id: 'picture',
				type: 'image' as const,
				x: 10,
				y: 20,
				width: 100,
				height: 80,
				image: {
					fileId: 'picture-file',
					mimeType: 'image/png',
					dataUrl: 'data:image/png;base64,aGVsbG8=',
				},
			},
		],
		selectedElementIds: ['picture'],
		...overrides,
	}
}

function upstreamSuccess(): Response {
	const modelOutput = JSON.stringify({
		actions: [{ _type: 'message', text: '已完成' }],
	})
	const body = [
		`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}`,
		`data: ${JSON.stringify({ choices: [{ delta: { content: modelOutput } }] })}`,
		'data: [DONE]',
		'',
	].join('\n\n')
	return new Response(body, {
		headers: { 'Content-Type': 'text/event-stream' },
	})
}

async function responseText(response: Response): Promise<string> {
	return await response.text()
}

test('returns action and terminal SSE events and logs only safe diagnostics', async () => {
	const logs: Record<string, unknown>[] = []
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://app.example.com' },
			body: JSON.stringify(prompt()),
		}),
		environment(),
		{
			fetch: async (_input, init) => {
				assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${API_KEY}`)
				return upstreamSuccess()
			},
			log: (entry) => logs.push(entry),
		}
	)

	const body = await responseText(response)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com')
	assert.match(body, /event: action/)
	assert.match(body, /"text":"已完成"/)
	assert.match(body, /event: done/)
	assert.equal(body.endsWith('\n\n'), true)
	assert.equal(logs.length, 1)
	assert.equal(logs[0].status, 'success')
	assert.equal(logs[0].retries, 0)
	assert.equal(JSON.stringify(logs).includes(API_KEY), false)
	assert.equal(JSON.stringify(logs).includes(PROMPT), false)
	assert.equal(JSON.stringify(logs).includes('private-element'), false)
})

test('sends only bounded viewport context and history to the upstream provider', async () => {
	let upstreamPayload: { messages: Array<{ content: string }> } | undefined
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...prompt(),
				elements: [
					...prompt().elements,
					{ id: 'selected-offscreen', type: 'rectangle', x: 5_000, y: 5_000, width: 10, height: 10 },
					{ id: 'unrelated', type: 'rectangle', x: 9_000, y: 9_000, width: 10, height: 10 },
				],
				selectedElementIds: ['selected-offscreen'],
				history: Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `${index}`.repeat(1_000) })),
			}),
		}),
		environment(),
		{
			fetch: async (_input, init) => {
				upstreamPayload = JSON.parse(String(init?.body)) as typeof upstreamPayload
				return upstreamSuccess()
			},
		}
	)

	await responseText(response)
	assert.ok(upstreamPayload)
	const context = JSON.parse(upstreamPayload.messages[1].content) as {
		elements: Array<{ id: string }>
		history: Array<{ content: string }>
		screenshot?: unknown
	}
	assert.deepEqual(
		context.elements.map((element) => element.id),
		['private-element', 'selected-offscreen']
	)
	assert.equal(context.history.length, 3)
	assert.equal(context.history.reduce((total, entry) => total + entry.content.length, 0), 6_000)
	assert.equal('screenshot' in context, false)
})

test('sends selected image elements as multimodal provider input only when requested', async () => {
	let upstreamPayload: { messages: Array<{ content: unknown }> } | undefined
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(imagePrompt()),
		}),
		environment(),
		{
			fetch: async (_input, init) => {
				upstreamPayload = JSON.parse(String(init?.body)) as typeof upstreamPayload
				return upstreamSuccess()
			},
		}
	)

	await responseText(response)
	assert.ok(upstreamPayload)
	const content = upstreamPayload.messages[1].content as Array<Record<string, unknown>>
	assert.equal(content[0].type, 'text')
	assert.equal(content.some((part) => part.type === 'image_url'), true)
	assert.deepEqual(content.find((part) => part.type === 'image_url'), {
		type: 'image_url',
		image_url: { url: 'data:image/png;base64,aGVsbG8=' },
	})
	assert.equal(String(content[0].text).includes('aGVsbG8='), false)
})

test('rejects missing image data before calling the upstream', async () => {
	let called = false
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(imagePrompt({ elements: [{ ...imagePrompt().elements[0], image: undefined }] })),
		}),
		environment(),
		{
			fetch: async () => {
				called = true
				return upstreamSuccess()
			},
		}
	)

	assert.equal(called, false)
	assert.match(await responseText(response), /图片上下文无效/)
})

test('rejects an explicit image workflow without an in-scope image', async () => {
	let called = false
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(imagePrompt({ elements: [], selectedElementIds: [] })),
		}),
		environment(),
		{
			fetch: async () => {
				called = true
				return upstreamSuccess()
			},
		}
	)

	assert.equal(called, false)
	assert.match(await responseText(response), /没有可分析的图片元素/)
})

test('rejects image context that exceeds the worker image count limit', async () => {
	const elements = Array.from({ length: MAX_CANVAS_IMAGE_COUNT + 1 }, (_, index) => ({
		id: `picture-${index}`,
		type: 'image' as const,
		x: index * 10,
		y: 20,
		width: 100,
		height: 80,
		image: {
			fileId: `file-${index}`,
			mimeType: 'image/png',
			dataUrl: 'data:image/png;base64,aGVsbG8=',
		},
	}))
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(imagePrompt({ elements, selectedElementIds: elements.map((element) => element.id) })),
		}),
		environment()
	)

	assert.match(await responseText(response), /最多分析/)
})

test('rejects oversized image context before calling the upstream', async () => {
	let called = false
	const oversizedDataUrl = `data:image/png;base64,${'a'.repeat(Math.ceil((5 * 1024 * 1024 + 1) * 4 / 3))}`
	const image = imagePrompt()
	const element = image.elements[0] as Record<string, unknown>
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...image,
				elements: [{ ...element, image: { ...(element.image as Record<string, unknown>), dataUrl: oversizedDataUrl } }],
			}),
		}),
		environment(),
		{
			fetch: async () => {
				called = true
				return upstreamSuccess()
			},
		}
	)

	assert.equal(called, false)
	assert.match(await responseText(response), /超过单张大小限制/)
})

test('rejects image payloads without the explicit image workflow marker', async () => {
	let called = false
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(imagePrompt({ includeImageContext: false })),
		}),
		environment(),
		{
			fetch: async () => {
				called = true
				return upstreamSuccess()
			},
		}
	)

	assert.equal(called, false)
	assert.match(await responseText(response), /只能在明确的图片分析请求中发送/)
})

test('reports when the provider does not support image input', async () => {
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(imagePrompt()),
		}),
		environment(),
		{ fetch: async () => new Response('vision is not supported', { status: 400 }) }
	)

	assert.match(await responseText(response), /不支持图片输入/)
})

test('retries transient upstream failures and reports provider errors after the limit', async () => {
	let attempts = 0
	const logs: Record<string, unknown>[] = []
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(prompt()),
		}),
		environment({ AI_UPSTREAM_MAX_RETRIES: '1' }),
		{
			fetch: async () => {
				attempts += 1
				return new Response('upstream unavailable', { status: 503 })
			},
			log: (entry) => logs.push(entry),
			sleep: async () => undefined,
		}
	)

	const body = await responseText(response)
	assert.equal(attempts, 2)
	assert.match(body, /event: error/)
	assert.match(body, /"code":"provider"/)
	assert.match(body, /event: done/)
	assert.equal(logs[0].status, 'error')
	assert.equal(logs[0].retries, 1)
})

test('classifies an upstream timeout and closes the SSE stream', async () => {
	const logs: Record<string, unknown>[] = []
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(prompt()),
		}),
		environment({ AI_UPSTREAM_MAX_RETRIES: '0', AI_UPSTREAM_TIMEOUT_MS: '5' }),
		{
			fetch: async (_input, init) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
				}),
			log: (entry) => logs.push(entry),
		}
	)

	const body = await responseText(response)
	assert.match(body, /"code":"timeout"/)
	assert.match(body, /event: done/)
	assert.equal(logs[0].errorCode, 'timeout')
})

test('distinguishes provider authentication failures from generic provider failures', async () => {
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(prompt()),
		}),
		environment({ AI_UPSTREAM_MAX_RETRIES: '2' }),
		{
			fetch: async () => new Response('unauthorized', { status: 401 }),
			sleep: async () => undefined,
		}
	)

	const body = await responseText(response)
	assert.match(body, /"code":"authentication"/)
	assert.doesNotMatch(body, /"code":"provider"/)
})

test('returns a client error before calling the upstream for an invalid prompt', async () => {
	let called = false
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: '' }),
		}),
		environment(),
		{
			fetch: async () => {
				called = true
				return upstreamSuccess()
			},
		}
	)

	const body = await responseText(response)
	assert.equal(called, false)
	assert.match(body, /"code":"client"/)
})

test('rejects malformed canvas context before calling the upstream', async () => {
	let called = false
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...prompt(), elements: [{ id: 'element', type: 'rectangle' }] }),
		}),
		environment(),
		{
			fetch: async () => {
				called = true
				return upstreamSuccess()
			},
		}
	)

	assert.equal(called, false)
	assert.match(await responseText(response), /"code":"client"/)
})

test('rejects selected element IDs that are missing from the prompt context', async () => {
	let called = false
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...prompt(), selectedElementIds: ['missing'] }),
		}),
		environment(),
		{
			fetch: async () => {
				called = true
				return upstreamSuccess()
			},
		}
	)

	assert.equal(called, false)
	assert.match(await responseText(response), /"code":"client"/)
})

test('does not retry after cancellation during the retry delay', async () => {
	let attempts = 0
	const controller = new AbortController()
	const service = new AgentService(environment({ AI_UPSTREAM_MAX_RETRIES: '2' }), {
		fetch: async () => {
			attempts += 1
			return new Response('upstream unavailable', { status: 503 })
		},
		sleep: async () => controller.abort(),
	})

	await assert.rejects(
		service.getActions(prompt(), controller.signal),
		(error: unknown) => error instanceof Error && 'code' in error && error.code === 'network'
	)
	assert.equal(attempts, 1)
	assert.equal(service.diagnostics.retries, 0)
})

test('rejects malformed update fields instead of passing them to the client', () => {
	assert.throws(
		() =>
			parseResponse(
				JSON.stringify({
					actions: [{ _type: 'update', elementId: 'element', updates: { x: 'not-a-number' } }],
				})
			),
		(error: unknown) => error instanceof Error && 'code' in error && error.code === 'parse'
	)
})

test('repairs only safe JSON punctuation before validating model actions', () => {
	const parsed = parseResponse([
		'Here is the result:',
		'```json',
		'{"actions":[{"_type":"message","text":"已完成",},],}',
		'```',
	].join('\n'))

	assert.deepEqual(parsed.actions, [{ _type: 'message', text: '已完成' }])
})

test('rejects invalid optional fields and unsupported model content clearly', () => {
	assert.throws(
		() => parseResponse(JSON.stringify({ actions: [{ _type: 'message', text: 'ok', intent: 1 }] })),
		(error: unknown) => error instanceof Error && /intent|字段|字符串/.test(error.message)
	)
	assert.throws(
		() => parseResponse(JSON.stringify({ actions: [{ _type: 'create', elements: [{ type: 'image', x: 0, y: 0 }] }] })),
		(error: unknown) => error instanceof Error && /不支持的元素类型/.test(error.message)
	)
	assert.throws(
		() => parseResponse(JSON.stringify({ actions: [{ _type: 'move', elementId: 'one', x: null, y: 0 }] })),
		(error: unknown) => error instanceof Error && /无效的数字/.test(error.message)
	)
	assert.throws(
		() => parseResponse(JSON.stringify({ actions: [{ _type: 'create', elements: [{ type: 'rectangle', x: 0, y: 0, width: -1 }] }] })),
		(error: unknown) => error instanceof Error && /宽度不能为负数/.test(error.message)
	)
	assert.throws(
		() =>
			parseResponse(
				JSON.stringify({
					actions: [{ _type: 'create', elements: [{ type: 'rectangle', x: 0, y: 0, points: [{ x: 0, y: 0 }] }] }],
				})
			),
		(error: unknown) => error instanceof Error && /点数据只支持/.test(error.message)
	)
	assert.throws(
		() =>
			parseResponse(
				JSON.stringify({
					actions: [{ _type: 'create', elements: [{ type: 'line', x: 0, y: 0, points: [{ x: 0, y: 0 }] }] }],
				})
			),
		(error: unknown) => error instanceof Error && /至少需要两个点/.test(error.message)
	)
	assert.throws(
		() =>
			parseResponse(
				JSON.stringify({
					actions: [
						{ _type: 'update', elementId: 'rectangle', updates: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } },
					],
				}),
				{ elements: [{ id: 'rectangle', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] }
			),
		(error: unknown) => error instanceof Error && /只能更新箭头/.test(error.message)
	)
})

test('accepts layout and binding actions only for elements in the canvas context', () => {
	const context = {
		elements: [
			{ id: 'left', type: 'rectangle' as const, x: 0, y: 0, width: 100, height: 80 },
			{ id: 'right', type: 'ellipse' as const, x: 300, y: 0, width: 100, height: 80 },
			{ id: 'arrow', type: 'arrow' as const, x: 0, y: 0, width: 400, height: 80 },
		],
	}
	const parsed = parseResponse(
		JSON.stringify({
			actions: [
				{ _type: 'layout', operation: 'align', elementIds: ['left', 'right'], alignment: 'top' },
				{ _type: 'bind', arrowId: 'arrow', startElementId: 'left', endElementId: 'right' },
			],
		}),
		context
	)
	assert.equal(parsed.actions[0]._type, 'layout')
	assert.equal(parsed.actions[1]._type, 'bind')
	const createdThenBound = parseResponse(
		JSON.stringify({
			actions: [
				{ _type: 'create', elements: [{ id: 'new-arrow', type: 'arrow', x: 100, y: 100 }] },
				{ _type: 'bind', arrowId: 'new-arrow', startElementId: 'left' },
			],
		}),
		context
	)
	assert.equal(createdThenBound.actions[1]._type, 'bind')

	assert.throws(
		() =>
			parseResponse(
				JSON.stringify({
					actions: [{ _type: 'layout', operation: 'sort', elementIds: ['missing'], axis: 'horizontal', direction: 'ascending' }],
				}),
				context
			),
		(error: unknown) => error instanceof Error && 'code' in error && error.code === 'parse'
	)
	assert.throws(
		() =>
			parseResponse(
				JSON.stringify({ actions: [{ _type: 'move', elementId: 'missing', x: 10, y: 20 }] }),
				context
			),
		(error: unknown) => error instanceof Error && 'code' in error && error.code === 'parse'
	)
})

test('rejects disallowed origins without wildcard CORS', async () => {
	const response = await handleWorkerRequest(
		new Request('https://worker.example/stream', {
			method: 'OPTIONS',
			headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
		}),
		environment()
	)

	assert.equal(response.status, 403)
	assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
})

test('surfaces Worker error events and treats a terminal event as completion', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = async () =>
		new Response(
			[
				'event: error',
				'data: {"code":"authentication","message":"认证失败","retryable":false}',
				'',
				'event: done',
				'data: {}',
				'',
			].join('\n'),
			{ headers: { 'Content-Type': 'text/event-stream' } }
		)

	try {
		await assert.rejects(
			streamCanvasAgent(prompt(), new AbortController().signal, () => undefined),
			(error: unknown) =>
				error instanceof Error &&
				'code' in error &&
				error.code === 'authentication'
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})
