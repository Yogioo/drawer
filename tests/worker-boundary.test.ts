import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamCanvasAgent } from '../client/agent.ts'
import { AgentService, parseResponse } from '../worker/agent/AgentService.ts'
import { handleWorkerRequest } from '../worker/handler.ts'
import type { Environment } from '../worker/environment.ts'

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
