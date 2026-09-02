import {
	boundCanvasSelectedElementIds,
	boundCanvasHistory,
	selectCanvasContextElements,
} from '../../shared/canvas.ts'
import type {
	CanvasAgentAction,
	CanvasAgentErrorCode,
	CanvasAgentResponse,
	CanvasElementSummary,
	CanvasElementSpec,
	CanvasPrompt,
} from '../../shared/canvas'
import type { Environment } from '../environment'

const MODEL_NAME = 'grok-4.6'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 250
const MAX_RETRIES = 3
const MAX_TIMEOUT_MS = 120_000
const MAX_RETRY_DELAY_MS = 10_000
const CANVAS_ELEMENT_TYPES = new Set([
	'rectangle',
	'ellipse',
	'diamond',
	'text',
	'arrow',
	'line',
	'freedraw',
])

const SYSTEM_PROMPT = `You are a precise AI assistant for an infinite whiteboard.

Return ONLY valid JSON in this exact shape:
{"actions":[...]}

Available actions:
- {"_type":"message","text":"..."} - send a short user-facing status or answer.
- {"_type":"create","elements":[ElementSpec],"intent":"..."} - create one or more elements.
- {"_type":"update","elementId":"id","updates":{},"intent":"..."} - update an existing element.
- {"_type":"move","elementId":"id","x":0,"y":0,"intent":"..."} - move an element's top-left corner.
- {"_type":"delete","elementId":"id","intent":"..."} - delete one element.
- {"_type":"clear","intent":"..."} - delete every element.

ElementSpec fields:
- type: rectangle, ellipse, diamond, text, arrow, line, or freedraw.
- x and y are scene coordinates. rectangle/ellipse/diamond/text use x,y,width,height.
- text is used for text elements and labels inside geometric elements.
- arrow/line/freedraw use points as [{"x":0,"y":0},{"x":100,"y":0}] relative to x,y.
- Optional styling: strokeColor, backgroundColor, strokeWidth, strokeStyle, roughness.

Rules:
- Use the existing element IDs when updating, moving, or deleting.
- Keep IDs stable and unique when creating elements. If omitted, the client generates them.
- Prefer several simple elements over an overly complex drawing.
- Coordinates should stay near the user's viewport unless the user asks otherwise.
- Always include a message action explaining what you did when the request changes the canvas.
- Never use markdown fences, commentary outside the JSON object, or unknown action types.`

export interface RequestDiagnostics {
	status: 'success' | 'error'
	durationMs: number
	retries: number
	requestId?: string
	upstreamStatus?: number
	errorCode?: CanvasAgentErrorCode
}

export interface AgentServiceOptions {
	fetch?: typeof fetch
	sleep?: (milliseconds: number) => Promise<void>
	now?: () => number
	requestId?: string
}

export class AgentBoundaryError extends Error {
	readonly code: CanvasAgentErrorCode
	readonly retryable: boolean
	readonly upstreamStatus?: number

	constructor(
		code: CanvasAgentErrorCode,
		message: string,
		retryable = false,
		upstreamStatus?: number
	) {
		super(message)
		this.name = 'AgentBoundaryError'
		this.code = code
		this.retryable = retryable
		this.upstreamStatus = upstreamStatus
	}
}

interface AgentConfig {
	apiKey: string
	endpoint: string
	model: string
	timeoutMs: number
	maxRetries: number
	retryDelayMs: number
}

interface AttemptResult {
	text: string
	upstreamStatus: number
}

export class AgentService {
	private readonly env: Environment
	private readonly fetchImpl: typeof fetch
	private readonly sleep: (milliseconds: number) => Promise<void>
	private readonly now: () => number
	private readonly requestId?: string
	private requestDiagnostics: RequestDiagnostics = {
		status: 'error',
		durationMs: 0,
		retries: 0,
	}

	constructor(env: Environment, options: AgentServiceOptions = {}) {
		this.env = env
		this.fetchImpl = options.fetch ?? fetch
		this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
		this.now = options.now ?? Date.now
		this.requestId = options.requestId
	}

	get diagnostics(): RequestDiagnostics {
		return { ...this.requestDiagnostics }
	}

	async getActions(input: unknown, signal?: AbortSignal): Promise<CanvasAgentAction[]> {
		const startedAt = this.now()
		let retries = 0
		try {
			const config = readConfig(this.env)
			const prompt = validateCanvasPrompt(input)
			const result = await this.requestWithRetry(config, prompt, signal)
			retries = result.retries
			const actions = parseResponse(result.text).actions
			this.requestDiagnostics = {
				status: 'success',
				durationMs: elapsedMs(startedAt, this.now()),
				retries,
				requestId: this.requestId,
				upstreamStatus: result.upstreamStatus,
			}
			return actions
		} catch (error) {
			const boundaryError = toBoundaryError(error)
			if (error instanceof RetryCountError) retries = error.retries
			this.requestDiagnostics = {
				status: 'error',
				durationMs: elapsedMs(startedAt, this.now()),
				retries,
				requestId: this.requestId,
				upstreamStatus: boundaryError.upstreamStatus,
				errorCode: boundaryError.code,
			}
			throw boundaryError
		}
	}

	private async requestWithRetry(
		config: AgentConfig,
		prompt: CanvasPrompt,
		signal?: AbortSignal
	): Promise<AttemptResult & { retries: number }> {
		for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
			if (signal?.aborted) throw interruptedRequest(attempt)
			try {
				const result = await this.requestOnce(config, prompt, signal)
				return { ...result, retries: attempt }
			} catch (error) {
				const boundaryError = toBoundaryError(error)
				if (!boundaryError.retryable || attempt === config.maxRetries) {
					throw new RetryCountError(boundaryError, attempt)
				}
				if (signal?.aborted) throw interruptedRequest(attempt)
				await this.sleep(config.retryDelayMs * 2 ** attempt)
				if (signal?.aborted) throw interruptedRequest(attempt)
			}
		}

		throw new AgentBoundaryError('network', 'AI 请求失败，请稍后重试。')
	}

	private async requestOnce(
		config: AgentConfig,
		prompt: CanvasPrompt,
		externalSignal?: AbortSignal
	): Promise<AttemptResult> {
		if (externalSignal?.aborted) throw new AgentBoundaryError('network', 'AI 请求已中断。')
		const controller = new AbortController()
		let timedOut = false
		const abortRequest = () => controller.abort()
		externalSignal?.addEventListener('abort', abortRequest, { once: true })
		const timeout = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, config.timeoutMs)

		try {
			const response = await this.fetchImpl(config.endpoint, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: config.model,
					stream: true,
					temperature: 0,
					max_tokens: 8192,
					messages: [
						{
							role: 'system',
							content: SYSTEM_PROMPT,
						},
						{
							role: 'user',
							content: JSON.stringify({
								request: prompt.message,
								viewport: prompt.viewport,
								selectedElementIds: prompt.selectedElementIds,
								elements: prompt.elements,
								history: prompt.history,
							}),
						},
					],
				}),
				signal: controller.signal,
			})

			if (!response.ok) throw await upstreamError(response, timedOut)
			if (!response.body) {
				throw new AgentBoundaryError('provider', 'AI Provider 没有返回数据流。', true, response.status)
			}

			return {
				text: await readCompletion(response.body, controller.signal, () => timedOut),
				upstreamStatus: response.status,
			}
		} catch (error) {
			if (timedOut) {
				throw new AgentBoundaryError('timeout', 'AI Provider 请求超时，请稍后重试。', true)
			}
			if (error instanceof AgentBoundaryError) throw error
			if (externalSignal?.aborted) throw new AgentBoundaryError('network', 'AI 请求已中断。')
			throw new AgentBoundaryError('network', '无法连接 AI Provider，请检查网络。', true)
		} finally {
			clearTimeout(timeout)
			externalSignal?.removeEventListener('abort', abortRequest)
		}
	}
}

function interruptedRequest(retries: number): RetryCountError {
	return new RetryCountError(new AgentBoundaryError('network', 'AI 请求已中断。'), retries)
}

class RetryCountError extends Error {
	override readonly cause: AgentBoundaryError
	readonly retries: number

	constructor(cause: AgentBoundaryError, retries: number) {
		super(cause.message)
		this.name = 'RetryCountError'
		this.cause = cause
		this.retries = retries
	}
}

async function upstreamError(response: Response, timedOut: boolean): Promise<AgentBoundaryError> {
	if (timedOut) return new AgentBoundaryError('timeout', 'AI Provider 请求超时，请稍后重试。', true)
	const retryable = response.status === 408 || response.status === 429 || response.status >= 500
	if (response.status === 401 || response.status === 403) {
		return new AgentBoundaryError('authentication', 'AI Provider 认证失败，请检查 Worker 配置。', false, response.status)
	}
	return new AgentBoundaryError(
		'provider',
		`AI Provider 返回 HTTP ${response.status}，请稍后重试。`,
		retryable,
		response.status
	)
}

async function readCompletion(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	isTimedOut: () => boolean
): Promise<string> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	let output = ''

	try {
		while (true) {
			const { value, done } = await reader.read()
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
			const events = buffer.split(/\r?\n\r?\n/)
			buffer = events.pop() ?? ''
			for (const event of events) output += parseCompletionEvent(event)
			if (done) break
		}
		if (buffer.trim()) output += parseCompletionEvent(buffer)
		if (isTimedOut()) throw new AgentBoundaryError('timeout', 'AI Provider 请求超时，请稍后重试。', true)
		return output
	} catch (error) {
		if (isTimedOut()) {
			throw new AgentBoundaryError('timeout', 'AI Provider 请求超时，请稍后重试。', true)
		}
		if (isAbortError(error) && signal.aborted) throw new AgentBoundaryError('network', 'AI 请求已中断。')
		if (error instanceof AgentBoundaryError) throw error
		if (signal.aborted) throw new AgentBoundaryError('network', 'AI 请求已中断。')
		throw new AgentBoundaryError('network', '读取 AI Provider 响应失败，请稍后重试。', true)
	} finally {
		reader.releaseLock()
	}
}

function parseCompletionEvent(event: string): string {
	const data = event
		.split(/\r?\n/)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())
		.join('\n')
	if (!data || data === '[DONE]') return ''
	try {
		const parsed = JSON.parse(data) as {
			choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>
		}
		if (!Array.isArray(parsed.choices)) throw new AgentBoundaryError('parse', 'AI Provider 返回了无效的 SSE 数据。')
		const choice = parsed.choices?.[0]
		const content = choice?.delta?.content ?? choice?.message?.content
		return typeof content === 'string' ? content : ''
	} catch (error) {
		if (error instanceof AgentBoundaryError) throw error
		throw new AgentBoundaryError('parse', 'AI Provider 返回了无效的 SSE 数据。')
	}
}

export function parseResponse(value: string): CanvasAgentResponse {
	const withoutFence = value
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
	const start = withoutFence.indexOf('{')
	const end = withoutFence.lastIndexOf('}')
	if (start === -1 || end <= start) throw new AgentBoundaryError('parse', '模型没有返回有效的 JSON。')

	let parsed: Partial<CanvasAgentResponse>
	try {
		parsed = JSON.parse(withoutFence.slice(start, end + 1)) as Partial<CanvasAgentResponse>
	} catch {
		throw new AgentBoundaryError('parse', '模型返回的 JSON 无法解析。')
	}
	if (!Array.isArray(parsed.actions)) {
		throw new AgentBoundaryError('parse', '模型返回的 JSON 缺少 actions 数组。')
	}

	return { actions: parsed.actions.map(validateAction) }
}

function validateAction(action: unknown): CanvasAgentAction {
	if (!action || typeof action !== 'object' || !('_type' in action)) {
		throw new AgentBoundaryError('parse', '模型返回了无效的画布操作。')
	}

	const candidate = action as Record<string, unknown>
	const type = candidate._type
	if (type === 'message' && typeof candidate.text === 'string') return { _type: 'message', text: candidate.text }
	if (type === 'clear') return { _type: 'clear', intent: optionalString(candidate.intent) }
	if (type === 'delete' && typeof candidate.elementId === 'string') {
		return { _type: 'delete', elementId: candidate.elementId, intent: optionalString(candidate.intent) }
	}
	if (type === 'move' && typeof candidate.elementId === 'string') {
		return {
			_type: 'move',
			elementId: candidate.elementId,
			x: numberValue(candidate.x),
			y: numberValue(candidate.y),
			intent: optionalString(candidate.intent),
		}
	}
	if (type === 'update' && typeof candidate.elementId === 'string' && isRecord(candidate.updates)) {
		return {
			_type: 'update',
			elementId: candidate.elementId,
			updates: validateUpdates(candidate.updates),
			intent: optionalString(candidate.intent),
		}
	}
	if (type === 'create' && Array.isArray(candidate.elements)) {
		return {
			_type: 'create',
			elements: candidate.elements.map(validateElement),
			intent: optionalString(candidate.intent),
		}
	}

	throw new AgentBoundaryError('parse', `模型返回了无效的操作类型：${String(type)}`)
}

function validateElement(value: unknown): CanvasElementSpec {
	if (!isRecord(value)) throw new AgentBoundaryError('parse', '模型返回了无效的画布元素。')
	const type = value.type
	if (!isCanvasElementType(type)) {
		throw new AgentBoundaryError('parse', `模型返回了不支持的元素类型：${String(type)}`)
	}

	return {
		id: optionalString(value.id),
		type: type as CanvasElementSpec['type'],
		x: numberValue(value.x),
		y: numberValue(value.y),
		width: optionalNumber(value.width),
		height: optionalNumber(value.height),
		text: optionalString(value.text),
		points: Array.isArray(value.points) ? value.points.map(validatePoint) : undefined,
		strokeColor: optionalString(value.strokeColor),
		backgroundColor: optionalString(value.backgroundColor),
		strokeWidth: optionalNumber(value.strokeWidth),
		strokeStyle: optionalStrokeStyle(value.strokeStyle),
		roughness: optionalNumber(value.roughness),
	}
}

function validatePoint(value: unknown) {
	if (!isRecord(value)) throw new AgentBoundaryError('parse', '模型返回了无效的自由笔迹点。')
	return { x: numberValue(value.x), y: numberValue(value.y) }
}

function validateUpdates(value: Record<string, unknown>): Partial<CanvasElementSpec> {
	const updates: Partial<CanvasElementSpec> = {}
	for (const [key, field] of Object.entries(value)) {
		switch (key) {
			case 'id':
				if (typeof field !== 'string') throw new AgentBoundaryError('parse', '模型返回了无效的元素 ID。')
				updates.id = field
				break
			case 'type':
				if (!isCanvasElementType(field)) throw new AgentBoundaryError('parse', '模型返回了无效的元素类型。')
				updates.type = field
				break
			case 'x':
				updates.x = numberValue(field)
				break
			case 'y':
				updates.y = numberValue(field)
				break
			case 'width':
				updates.width = numberValue(field)
				break
			case 'height':
				updates.height = numberValue(field)
				break
			case 'text':
				if (typeof field !== 'string') throw new AgentBoundaryError('parse', '模型返回了无效的元素文本。')
				updates.text = field
				break
			case 'points':
				if (!Array.isArray(field)) throw new AgentBoundaryError('parse', '模型返回了无效的自由笔迹点。')
				updates.points = field.map(validatePoint)
				break
			case 'strokeColor':
				if (typeof field !== 'string') throw new AgentBoundaryError('parse', '模型返回了无效的描边颜色。')
				updates.strokeColor = field
				break
			case 'backgroundColor':
				if (typeof field !== 'string') throw new AgentBoundaryError('parse', '模型返回了无效的填充颜色。')
				updates.backgroundColor = field
				break
			case 'strokeWidth':
				updates.strokeWidth = numberValue(field)
				break
			case 'strokeStyle':
				if (field !== 'solid' && field !== 'dashed' && field !== 'dotted') {
					throw new AgentBoundaryError('parse', '模型返回了无效的描边样式。')
				}
				updates.strokeStyle = field
				break
			case 'roughness':
				updates.roughness = numberValue(field)
				break
			default:
				throw new AgentBoundaryError('parse', `模型返回了未知的元素更新字段：${key}`)
		}
	}
	return updates
}

export function validateCanvasPrompt(value: unknown): CanvasPrompt {
	if (!isRecord(value)) throw new AgentBoundaryError('client', '请求体必须是 JSON 对象。')
	if (typeof value.message !== 'string' || value.message.trim().length === 0) {
		throw new AgentBoundaryError('client', '请求需要一条非空消息。')
	}
	if (value.message.length > 4_000) throw new AgentBoundaryError('client', '消息过长，请缩短后重试。')
	if (!Array.isArray(value.elements) || !Array.isArray(value.selectedElementIds) || !Array.isArray(value.history)) {
		throw new AgentBoundaryError('client', '画布请求缺少有效的上下文。')
	}
	if (!value.elements.every(isCanvasElementSummary)) {
		throw new AgentBoundaryError('client', '画布元素上下文无效。')
	}
	const viewport = value.viewport
	if (!isRecord(viewport) || !['x', 'y', 'w', 'h'].every((key) => finiteNumber(viewport[key]))) {
		throw new AgentBoundaryError('client', '画布视口无效。')
	}
	if (!value.selectedElementIds.every((id) => typeof id === 'string')) {
		throw new AgentBoundaryError('client', '选中的元素 ID 无效。')
	}
	if (
		!value.history.every(
			(entry) =>
				isRecord(entry) &&
				(entry.role === 'user' || entry.role === 'assistant') &&
				typeof entry.content === 'string'
		)
	) {
		throw new AgentBoundaryError('client', '对话历史无效。')
	}
	const selectedElementIds = boundCanvasSelectedElementIds(value.selectedElementIds as string[])
	const elements = value.elements as CanvasElementSummary[]
	const history = value.history as CanvasPrompt['history']
	const validViewport = viewport as unknown as CanvasPrompt['viewport']
	return {
		message: value.message,
		elements: selectCanvasContextElements(elements, selectedElementIds, validViewport),
		selectedElementIds,
		viewport: validViewport,
		history: boundCanvasHistory(history),
	}
}

function isCanvasElementSummary(value: unknown): value is CanvasElementSummary {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		!isCanvasElementType(value.type) ||
		!finiteNumber(value.x) ||
		!finiteNumber(value.y) ||
		!finiteNumber(value.width) ||
		!finiteNumber(value.height)
	) {
		return false
	}
	if (value.text !== undefined && typeof value.text !== 'string') return false
	if (value.points !== undefined && (!Array.isArray(value.points) || !value.points.every(isCanvasPoint))) return false
	if (value.strokeColor !== undefined && typeof value.strokeColor !== 'string') return false
	if (value.backgroundColor !== undefined && typeof value.backgroundColor !== 'string') return false
	if (value.strokeWidth !== undefined && !finiteNumber(value.strokeWidth)) return false
	if (value.strokeStyle !== undefined && !isStrokeStyle(value.strokeStyle)) return false
	if (value.roughness !== undefined && !finiteNumber(value.roughness)) return false
	return true
}

function isCanvasPoint(value: unknown): value is { x: number; y: number } {
	return isRecord(value) && finiteNumber(value.x) && finiteNumber(value.y)
}

function isStrokeStyle(value: unknown): value is NonNullable<CanvasElementSpec['strokeStyle']> {
	return value === 'solid' || value === 'dashed' || value === 'dotted'
}

function readConfig(env: Environment): AgentConfig {
	const apiKey = env.OPENAI_API_KEY?.trim()
	if (!apiKey) throw new AgentBoundaryError('configuration', 'AI Worker 未配置 API key。')

	const baseUrl = env.OPENAI_BASE_URL?.trim()
	if (!baseUrl) throw new AgentBoundaryError('configuration', 'AI Worker 未配置 Provider 地址。')
	let endpoint: URL
	try {
		endpoint = new URL(baseUrl)
	} catch {
		throw new AgentBoundaryError('configuration', 'AI Worker 的 Provider 地址无效。')
	}
	const localHttp = endpoint.protocol === 'http:' && isLocalHost(endpoint.hostname)
	if (endpoint.protocol !== 'https:' && !localHttp) {
		throw new AgentBoundaryError('configuration', '生产 Provider 地址必须使用 HTTPS。')
	}
	const pathname = endpoint.pathname.replace(/\/+$/, '')
	if (!pathname.endsWith('/chat/completions')) {
		endpoint.pathname = `${pathname}/chat/completions`
	} else {
		endpoint.pathname = pathname
	}

	const model = env.OPENAI_MODEL?.trim() || MODEL_NAME
	const timeoutMs = boundedInteger(
		env.AI_UPSTREAM_TIMEOUT_MS,
		DEFAULT_TIMEOUT_MS,
		1,
		MAX_TIMEOUT_MS,
		'超时'
	)
	const maxRetries = boundedInteger(env.AI_UPSTREAM_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES, '重试')
	const retryDelayMs = boundedInteger(
		env.AI_UPSTREAM_RETRY_DELAY_MS,
		DEFAULT_RETRY_DELAY_MS,
		0,
		MAX_RETRY_DELAY_MS,
		'重试间隔'
	)
	return { apiKey, endpoint: endpoint.toString(), model, timeoutMs, maxRetries, retryDelayMs }
}

function boundedInteger(
	value: string | undefined,
	fallback: number,
	min: number,
	max: number,
	label: string
): number {
	if (value === undefined || value.trim() === '') return fallback
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new AgentBoundaryError('configuration', `AI Worker 的${label}配置无效。`)
	}
	return parsed
}

function toBoundaryError(error: unknown): AgentBoundaryError {
	if (error instanceof RetryCountError) return error.cause
	if (error instanceof AgentBoundaryError) return error
	return new AgentBoundaryError('network', 'AI 请求失败，请稍后重试。')
}

function elapsedMs(startedAt: number, endedAt: number): number {
	return Math.max(0, Math.round(endedAt - startedAt))
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function numberValue(value: unknown): number {
	if (!finiteNumber(value)) throw new AgentBoundaryError('parse', '模型返回了无效的数字。')
	return value
}

function optionalNumber(value: unknown): number | undefined {
	return value === undefined ? undefined : numberValue(value)
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function optionalStrokeStyle(value: unknown): CanvasElementSpec['strokeStyle'] | undefined {
	return value === 'solid' || value === 'dashed' || value === 'dotted' ? value : undefined
}

function isLocalHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function isCanvasElementType(value: unknown): value is CanvasElementSpec['type'] {
	return typeof value === 'string' && CANVAS_ELEMENT_TYPES.has(value)
}
