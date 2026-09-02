import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { handleWorkerRequest } from '../worker/handler.ts'

const TEST_TOKEN = 'test-redacted-token'

test('completes a Worker request against a controlled OpenAI-compatible stream', async () => {
	let payload: Record<string, unknown> | undefined
	let authorization: string | undefined
	const upstream = createServer((request, response) => {
		const chunks: Buffer[] = []
		request.on('data', (chunk: Buffer) => chunks.push(chunk))
		request.on('end', () => {
			payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
			authorization = request.headers.authorization
			response.writeHead(200, { 'Content-Type': 'text/event-stream' })
			response.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
			response.write(
				'data: {"choices":[{"delta":{"content":"{\\"actions\\":[{\\"_type\\":\\"message\\",\\"text\\":\\"已完成\\"}]}"}}]}\n\n'
			)
			response.end('data: [DONE]\n\n')
		})
	})
	upstream.listen(0, '127.0.0.1')
	await once(upstream, 'listening')
	const address = upstream.address()
	assert.ok(address && typeof address === 'object')

	try {
		const response = await handleWorkerRequest(
			new Request('https://worker.example/stream', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: 'https://app.example.com' },
				body: JSON.stringify({
					message: '报告状态',
					elements: [],
					selectedElementIds: [],
					viewport: { x: 0, y: 0, w: 800, h: 600 },
					history: [],
				}),
			}),
			{
				OPENAI_API_KEY: TEST_TOKEN,
				OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
				OPENAI_MODEL: 'controlled-test-model',
				ALLOWED_ORIGINS: 'https://app.example.com',
				AI_UPSTREAM_MAX_RETRIES: '0',
			},
			{ fetch }
		)

		const body = await response.text()
		assert.equal(response.status, 200)
		assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com')
		assert.equal(authorization, `Bearer ${TEST_TOKEN}`)
		assert.match(body, /event: done/)
		assert.match(body, /已完成/)
		assert.equal(payload?.model, 'controlled-test-model')
		assert.equal(payload?.stream, true)
		assert.equal(body.includes(TEST_TOKEN), false)
	} finally {
		upstream.close()
		await once(upstream, 'close').catch(() => undefined)
	}
})
