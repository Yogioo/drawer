import type { CanvasAgentErrorEvent } from '../shared/canvas'
import type { Environment } from './environment.ts'
import {
	AgentBoundaryError,
	AgentService,
	type AgentServiceOptions,
	type RequestDiagnostics,
} from './agent/AgentService.ts'

const STREAM_PATH = '/stream'

export interface WorkerDependencies extends Omit<AgentServiceOptions, 'requestId'> {
	log?: (entry: RequestLog) => void
	requestId?: () => string
}

export interface RequestLog extends RequestDiagnostics {
	event: 'ai_request'
}

export async function handleWorkerRequest(
	request: Request,
	env: Environment,
	dependencies: WorkerDependencies = {}
): Promise<Response> {
	const origin = request.headers.get('Origin')
	const cors = getCorsHeaders(env, origin)
	if (origin && !isAllowedOrigin(env, origin)) {
		return jsonErrorResponse(
			new AgentBoundaryError('cors', '请求来源未被允许。'),
			403,
			{ Vary: 'Origin' }
		)
	}

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: cors })
	}
	if (new URL(request.url).pathname !== STREAM_PATH) {
		return new Response('Not found', { status: 404, headers: cors })
	}
	if (request.method !== 'POST') {
		return jsonErrorResponse(
			new AgentBoundaryError('client', 'AI Worker 只接受 POST 请求。'),
			405,
			cors
		)
	}
	const contentType = request.headers.get('Content-Type')?.toLowerCase() ?? ''
	if (!contentType.includes('application/json')) {
		return jsonErrorResponse(
			new AgentBoundaryError('client', '请求必须使用 application/json。'),
			415,
			cors
		)
	}

	const requestId = dependencies.requestId?.() ?? crypto.randomUUID()
	const service = new AgentService(env, {
		fetch: dependencies.fetch,
		sleep: dependencies.sleep,
		now: dependencies.now,
		requestId,
	})
	const encoder = new TextEncoder()
	const executionController = new AbortController()
	const abortExecution = () => executionController.abort()
	request.signal.addEventListener('abort', abortExecution, { once: true })
	let closed = false
	let diagnostics: RequestDiagnostics = {
		status: 'error',
		durationMs: 0,
		retries: 0,
		requestId,
	}

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			void runStream(controller)
		},
		cancel() {
			closed = true
			executionController.abort()
		},
	})

	async function runStream(controller: ReadableStreamDefaultController<Uint8Array>) {
		const startedAt = dependencies.now?.() ?? Date.now()
		try {
			let payload: unknown
			try {
				payload = await request.json()
			} catch {
				throw new AgentBoundaryError('client', '请求体不是有效的 JSON。')
			}

			const actions = await service.getActions(payload, executionController.signal)
			for (const action of actions) {
				if (closed) break
				send(controller, encoder, 'action', action)
			}
			diagnostics = service.diagnostics
		} catch (error) {
			const boundaryError = normalizeError(error)
			diagnostics = {
				...service.diagnostics,
				status: 'error',
				durationMs: elapsedMs(startedAt, dependencies.now?.() ?? Date.now()),
				errorCode: boundaryError.code,
				requestId,
			}
			if (!closed && !request.signal.aborted) {
				const event: CanvasAgentErrorEvent = {
					code: boundaryError.code,
					message: boundaryError.message,
					retryable: boundaryError.retryable,
					requestId,
				}
				send(controller, encoder, 'error', event)
			}
		} finally {
			diagnostics = {
				...diagnostics,
				durationMs: diagnostics.durationMs || elapsedMs(startedAt, dependencies.now?.() ?? Date.now()),
				requestId,
			}
			if (!closed) {
				send(controller, encoder, 'done', { requestId })
				closed = true
				controller.close()
			}
			;(dependencies.log ?? defaultLog)({ event: 'ai_request', ...diagnostics })
			request.signal.removeEventListener('abort', abortExecution)
		}
	}

	return new Response(readable, {
		status: 200,
		headers: {
			...cors,
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
			'X-Request-ID': requestId,
		},
	})
}

function send(
	controller: ReadableStreamDefaultController<Uint8Array>,
	encoder: TextEncoder,
	event: string,
	data: unknown
) {
	controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
}

function jsonErrorResponse(error: AgentBoundaryError, status: number, cors: HeadersInit): Response {
	const body: CanvasAgentErrorEvent = {
		code: error.code,
		message: error.message,
		retryable: error.retryable,
	}
	return new Response(JSON.stringify({ error: body }), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
	})
}

function getCorsHeaders(env: Environment, origin: string | null): HeadersInit {
	const headers: Record<string, string> = { Vary: 'Origin' }
	if (origin && isAllowedOrigin(env, origin)) headers['Access-Control-Allow-Origin'] = origin
	if (origin) {
		headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
		headers['Access-Control-Allow-Headers'] = 'Content-Type'
		headers['Access-Control-Max-Age'] = '600'
	}
	return headers
}

function isAllowedOrigin(env: Environment, origin: string): boolean {
	const configured = env.ALLOWED_ORIGINS ?? env.CORS_ORIGINS ?? ''
	return configured
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean)
		.some((allowed) => allowed !== '*' && allowed === origin)
}

function normalizeError(error: unknown): AgentBoundaryError {
	if (error instanceof AgentBoundaryError) return error
	return new AgentBoundaryError('network', 'AI 请求失败，请稍后重试。')
}

function elapsedMs(startedAt: number, endedAt: number): number {
	return Math.max(0, Math.round(endedAt - startedAt))
}

function defaultLog(entry: RequestLog) {
	console.log(JSON.stringify(entry))
}
