import {
	boundCanvasSelectedElementIds,
	boundCanvasHistory,
	isCanvasBindableElementType,
	MAX_CANVAS_SELECTED_IDS,
	selectCanvasContextElements,
} from '../../shared/canvas.ts'
import type {
	CanvasAgentAction,
	CanvasAgentErrorCode,
	CanvasAgentResponse,
	CanvasBindAction,
	CanvasLayoutAction,
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
- {"_type":"layout","operation":"align","elementIds":["id"],"alignment":"left|center|right|top|middle|bottom","intent":"..."} - align selected elements.
- {"_type":"layout","operation":"distribute","elementIds":["id"],"axis":"horizontal|vertical","intent":"..."} - distribute selected elements evenly.
- {"_type":"layout","operation":"sort","elementIds":["id"],"axis":"horizontal|vertical","direction":"ascending|descending","intent":"..."} - sort selected elements in scene order.
- {"_type":"bind","arrowId":"arrow-id","startElementId":"element-id|null","endElementId":"element-id|null","intent":"..."} - bind or unbind an arrow endpoint. Omit an endpoint to keep its current binding.

ElementSpec fields:
- type: rectangle, ellipse, diamond, text, arrow, line, or freedraw.
- x and y are scene coordinates. rectangle/ellipse/diamond/text use x,y,width,height.
- text is used for text elements and labels inside geometric elements.
- arrow/line/freedraw use points as [{"x":0,"y":0},{"x":100,"y":0}] relative to x,y.
- Optional styling: strokeColor, backgroundColor, strokeWidth, strokeStyle, roughness.

Rules:
- Use the existing element IDs when updating, moving, or deleting.
- For layout requests, prefer the IDs in selectedElementIds and copy them exactly into elementIds.
- Use a stable id when creating an element that will be referenced by a later bind or layout action in the same response.
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
			const actions = parseResponse(result.text, prompt).actions
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

export function parseResponse(value: string, prompt?: Pick<CanvasPrompt, 'elements'>): CanvasAgentResponse {
	const repaired = repairModelJson(value)

	let parsed: unknown
	try {
		parsed = JSON.parse(repaired) as Partial<CanvasAgentResponse>
	} catch {
		throw new AgentBoundaryError('parse', '模型返回的 JSON 无法解析。')
	}
	if (!isRecord(parsed)) throw new AgentBoundaryError('parse', '模型返回的 JSON 必须是对象。')
	rejectUnknownFields(parsed, ['actions'])
	if (!Array.isArray(parsed.actions)) {
		throw new AgentBoundaryError('parse', '模型返回的 JSON 缺少 actions 数组。')
	}

	const actions = parsed.actions.map(validateAction)
	if (prompt) validateActionReferences(actions, prompt.elements)
	return { actions }
}

export function repairModelJson(value: string): string {
	const normalized = value.trim().replace(/^\uFEFF/, '')
	const withoutFence = normalized
		.replace(/^```[^\r\n]*(?:\r?\n|$)/i, '')
		.replace(/(?:\r?\n|^)```\s*$/i, '')
	const start = withoutFence.indexOf('{')
	if (start === -1) throw new AgentBoundaryError('parse', '模型没有返回有效的 JSON。')
	const object = extractJsonObject(withoutFence, start)
	if (!object) throw new AgentBoundaryError('parse', '模型没有返回完整的 JSON。')
	return removeTrailingCommas(object)
}

function extractJsonObject(value: string, start: number): string | null {
	let depth = 0
	let inString = false
	let escaped = false
	for (let index = start; index < value.length; index += 1) {
		const character = value[index]
		if (inString) {
			if (escaped) escaped = false
			else if (character === '\\') escaped = true
			else if (character === '"') inString = false
			continue
		}
		if (character === '"') {
			inString = true
			continue
		}
		if (character === '{') depth += 1
		if (character === '}') {
			depth -= 1
			if (depth === 0) return value.slice(start, index + 1)
			if (depth < 0) return null
		}
	}
	return null
}

function removeTrailingCommas(value: string): string {
	let result = ''
	let inString = false
	let escaped = false
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]
		if (inString) {
			result += character
			if (escaped) escaped = false
			else if (character === '\\') escaped = true
			else if (character === '"') inString = false
			continue
		}
		if (character === '"') {
			inString = true
			result += character
			continue
		}
		if (character === ',') {
			let next = index + 1
			while (/\s/.test(value[next] ?? '')) next += 1
			if (value[next] === '}' || value[next] === ']') continue
		}
		result += character
	}
	return result
}

function validateAction(action: unknown): CanvasAgentAction {
	if (!action || typeof action !== 'object' || !('_type' in action)) {
		throw new AgentBoundaryError('parse', '模型返回了无效的画布操作。')
	}

	const candidate = action as Record<string, unknown>
	const type = candidate._type
	if (type === 'message') {
		rejectUnknownFields(candidate, ['_type', 'text'])
		if (typeof candidate.text !== 'string') throw new AgentBoundaryError('parse', '模型返回了无效的消息文本。')
		return { _type: 'message', text: candidate.text }
	}
	if (type === 'clear') {
		rejectUnknownFields(candidate, ['_type', 'intent'])
		return { _type: 'clear', intent: optionalString(candidate.intent, 'intent') }
	}
	if (type === 'delete') {
		rejectUnknownFields(candidate, ['_type', 'elementId', 'intent'])
		return {
			_type: 'delete',
			elementId: requiredId(candidate.elementId, '元素 ID'),
			intent: optionalString(candidate.intent, 'intent'),
		}
	}
	if (type === 'move') {
		rejectUnknownFields(candidate, ['_type', 'elementId', 'x', 'y', 'intent'])
		return {
			_type: 'move',
			elementId: requiredId(candidate.elementId, '元素 ID'),
			x: numberValue(candidate.x),
			y: numberValue(candidate.y),
			intent: optionalString(candidate.intent, 'intent'),
		}
	}
	if (type === 'update') {
		rejectUnknownFields(candidate, ['_type', 'elementId', 'updates', 'intent'])
		if (!isRecord(candidate.updates)) throw new AgentBoundaryError('parse', '模型返回了无效的元素更新。')
		return {
			_type: 'update',
			elementId: requiredId(candidate.elementId, '元素 ID'),
			updates: validateUpdates(candidate.updates),
			intent: optionalString(candidate.intent, 'intent'),
		}
	}
	if (type === 'create') {
		rejectUnknownFields(candidate, ['_type', 'elements', 'intent'])
		if (!Array.isArray(candidate.elements)) throw new AgentBoundaryError('parse', '模型返回了无效的元素数组。')
		return {
			_type: 'create',
			elements: candidate.elements.map(validateElement),
			intent: optionalString(candidate.intent, 'intent'),
		}
	}
	if (type === 'layout') return validateLayoutAction(candidate)
	if (type === 'bind') return validateBindAction(candidate)

	throw new AgentBoundaryError('parse', `模型返回了无效的操作类型：${String(type)}`)
}

function validateLayoutAction(candidate: Record<string, unknown>): CanvasLayoutAction {
	rejectUnknownFields(candidate, [
		'_type',
		'operation',
		'elementIds',
		'alignment',
		'axis',
		'direction',
		'intent',
	])
	if (
		(candidate.operation !== 'align' && candidate.operation !== 'distribute' && candidate.operation !== 'sort') ||
		!Array.isArray(candidate.elementIds) ||
		!candidate.elementIds.every((id) => typeof id === 'string' && id.length > 0) ||
		candidate.elementIds.length > MAX_CANVAS_SELECTED_IDS
	) {
		throw new AgentBoundaryError('parse', '模型返回了无效的布局操作。')
	}
	if (candidate.operation === 'align') {
		if (
			candidate.alignment !== 'left' &&
			candidate.alignment !== 'center' &&
			candidate.alignment !== 'right' &&
			candidate.alignment !== 'top' &&
			candidate.alignment !== 'middle' &&
			candidate.alignment !== 'bottom'
		) {
			throw new AgentBoundaryError('parse', '模型返回了无效的对齐方式。')
		}
		return {
			_type: 'layout',
			operation: 'align',
			elementIds: candidate.elementIds as string[],
			alignment: candidate.alignment,
			intent: optionalString(candidate.intent, 'intent'),
		}
	}
	if (candidate.axis !== 'horizontal' && candidate.axis !== 'vertical') {
		throw new AgentBoundaryError('parse', '模型返回了无效的布局方向。')
	}
	if (candidate.operation === 'distribute') {
		return {
			_type: 'layout',
			operation: 'distribute',
			elementIds: candidate.elementIds as string[],
			axis: candidate.axis,
			intent: optionalString(candidate.intent, 'intent'),
		}
	}
	if (candidate.direction !== 'ascending' && candidate.direction !== 'descending') {
		throw new AgentBoundaryError('parse', '模型返回了无效的排序方向。')
	}
	return {
		_type: 'layout',
		operation: 'sort',
		elementIds: candidate.elementIds as string[],
		axis: candidate.axis,
		direction: candidate.direction,
		intent: optionalString(candidate.intent, 'intent'),
	}
}

function validateBindAction(candidate: Record<string, unknown>): CanvasBindAction {
	rejectUnknownFields(candidate, ['_type', 'arrowId', 'startElementId', 'endElementId', 'intent'])
	const hasStart = Object.prototype.hasOwnProperty.call(candidate, 'startElementId')
	const hasEnd = Object.prototype.hasOwnProperty.call(candidate, 'endElementId')
	if ((!hasStart && !hasEnd)) {
		throw new AgentBoundaryError('parse', '模型返回了无效的箭头绑定操作。')
	}
	return {
		_type: 'bind',
		arrowId: requiredId(candidate.arrowId, '箭头 ID'),
		...(hasStart ? { startElementId: optionalBindingId(candidate.startElementId) } : {}),
		...(hasEnd ? { endElementId: optionalBindingId(candidate.endElementId) } : {}),
		intent: optionalString(candidate.intent, 'intent'),
	}
}

function optionalBindingId(value: unknown): string | null {
	if (value === null) return null
	if (typeof value === 'string' && value.length > 0) return value
	throw new AgentBoundaryError('parse', '模型返回了无效的绑定元素 ID。')
}

function validateActionReferences(
	actions: readonly CanvasAgentAction[],
	elements: readonly CanvasElementSummary[]
) {
	const elementsById = new Map<string, { type: string }>(elements.map((element) => [element.id, element]))
	for (const action of actions) {
		if (action._type === 'create') {
			for (const element of action.elements) {
				if (!element.id) continue
				if (elementsById.has(element.id)) {
					throw new AgentBoundaryError('parse', '模型创建了重复的画布元素 ID。')
				}
				elementsById.set(element.id, element)
			}
			continue
		}
		if (action._type === 'layout') {
			for (const elementId of action.elementIds) {
				if (!elementsById.has(elementId)) throw new AgentBoundaryError('parse', '模型引用了不存在的画布元素。')
			}
			continue
		}
		if (action._type === 'update' || action._type === 'move' || action._type === 'delete') {
			const target = elementsById.get(action.elementId)
			if (!target) {
				throw new AgentBoundaryError('parse', '模型引用了不存在的画布元素。')
			}
			if (action._type === 'update' && action.updates.points && !isLinearCanvasElementType(target.type)) {
				throw new AgentBoundaryError('parse', '模型只能更新箭头、线条或自由笔迹的点数据。')
			}
			if (action._type === 'delete') elementsById.delete(action.elementId)
			continue
		}
		if (action._type === 'clear') {
			elementsById.clear()
			continue
		}
		if (action._type !== 'bind') continue
		const arrow = elementsById.get(action.arrowId)
		if (!arrow || arrow.type !== 'arrow') throw new AgentBoundaryError('parse', '模型引用了无效的箭头。')
		for (const elementId of [action.startElementId, action.endElementId]) {
			if (elementId === undefined || elementId === null) continue
			const target = elementsById.get(elementId)
			if (!target || !isCanvasBindableElementType(target.type)) {
				throw new AgentBoundaryError('parse', '模型引用了无效的箭头绑定目标。')
			}
		}
	}
}

function validateElement(value: unknown): CanvasElementSpec {
	if (!isRecord(value)) throw new AgentBoundaryError('parse', '模型返回了无效的画布元素。')
	rejectUnknownFields(value, [
		'id',
		'type',
		'x',
		'y',
		'width',
		'height',
		'text',
		'points',
		'strokeColor',
		'backgroundColor',
		'strokeWidth',
		'strokeStyle',
		'roughness',
	])
	const type = value.type
	if (!isCanvasElementType(type)) {
		throw new AgentBoundaryError('parse', `模型返回了不支持的元素类型：${String(type)}`)
	}
	const points = optionalPoints(value.points)
	if (points && !isLinearCanvasElementType(type)) {
		throw new AgentBoundaryError('parse', '模型返回的点数据只支持箭头、线条和自由笔迹。')
	}
	if (points && points.length < 2) {
		throw new AgentBoundaryError('parse', '模型返回的线条至少需要两个点。')
	}

	return {
		id: value.id === undefined ? undefined : requiredId(value.id, '元素 ID'),
		type: type as CanvasElementSpec['type'],
		x: numberValue(value.x),
		y: numberValue(value.y),
		width: optionalNonNegativeNumber(value.width, '宽度'),
		height: optionalNonNegativeNumber(value.height, '高度'),
		text: optionalString(value.text, '元素文本'),
		points,
		strokeColor: optionalString(value.strokeColor, '描边颜色'),
		backgroundColor: optionalString(value.backgroundColor, '填充颜色'),
		strokeWidth: optionalNonNegativeNumber(value.strokeWidth, '描边宽度'),
		strokeStyle: optionalStrokeStyle(value.strokeStyle),
		roughness: optionalNonNegativeNumber(value.roughness, '粗糙度'),
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
			case 'type':
				throw new AgentBoundaryError('parse', '元素 ID 和类型不可通过 update 修改。')
			case 'x':
				updates.x = numberValue(field)
				break
			case 'y':
				updates.y = numberValue(field)
				break
			case 'width':
				updates.width = nonNegativeNumber(field, '宽度')
				break
			case 'height':
				updates.height = nonNegativeNumber(field, '高度')
				break
			case 'text':
				if (typeof field !== 'string') throw new AgentBoundaryError('parse', '模型返回了无效的元素文本。')
				updates.text = field
				break
			case 'points':
				if (!Array.isArray(field)) throw new AgentBoundaryError('parse', '模型返回了无效的自由笔迹点。')
				if (field.length < 2) throw new AgentBoundaryError('parse', '模型返回的线条至少需要两个点。')
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
				updates.strokeWidth = nonNegativeNumber(field, '描边宽度')
				break
			case 'strokeStyle':
				if (field !== 'solid' && field !== 'dashed' && field !== 'dotted') {
					throw new AgentBoundaryError('parse', '模型返回了无效的描边样式。')
				}
				updates.strokeStyle = field
				break
			case 'roughness':
				updates.roughness = nonNegativeNumber(field, '粗糙度')
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
	const elementIds = new Set<string>()
	for (const element of value.elements as CanvasElementSummary[]) {
		if (elementIds.has(element.id)) throw new AgentBoundaryError('client', '画布元素 ID 重复。')
		elementIds.add(element.id)
	}
	const viewport = value.viewport
	if (!isRecord(viewport) || !['x', 'y', 'w', 'h'].every((key) => finiteNumber(viewport[key]))) {
		throw new AgentBoundaryError('client', '画布视口无效。')
	}
	if (!value.selectedElementIds.every((id) => typeof id === 'string')) {
		throw new AgentBoundaryError('client', '选中的元素 ID 无效。')
	}
	if ((value.selectedElementIds as unknown[]).some((id) => !elementIds.has(id as string))) {
		throw new AgentBoundaryError('client', '选中的元素不存在。')
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
		value.id.length === 0 ||
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
	if (value.startBindingElementId !== undefined && typeof value.startBindingElementId !== 'string') return false
	if (value.endBindingElementId !== undefined && typeof value.endBindingElementId !== 'string') return false
	if (
		value.boundElementIds !== undefined &&
		(!Array.isArray(value.boundElementIds) || !value.boundElementIds.every((id) => typeof id === 'string'))
	) return false
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

function numberValue(value: unknown, label = '数字'): number {
	if (!finiteNumber(value)) throw new AgentBoundaryError('parse', `模型返回了无效的${label}。`)
	return value
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
	return value === undefined ? undefined : nonNegativeNumber(value, label)
}

function nonNegativeNumber(value: unknown, label: string): number {
	const parsed = numberValue(value, label)
	if (parsed < 0) throw new AgentBoundaryError('parse', `模型返回的${label}不能为负数。`)
	return parsed
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined
	if (typeof value === 'string') return value
	throw new AgentBoundaryError('parse', `模型返回的${label}必须是字符串。`)
}

function optionalStrokeStyle(value: unknown): CanvasElementSpec['strokeStyle'] | undefined {
	if (value === undefined) return undefined
	if (value === 'solid' || value === 'dashed' || value === 'dotted') return value
	throw new AgentBoundaryError('parse', '模型返回了无效的描边样式。')
}

function optionalPoints(value: unknown): CanvasElementSpec['points'] | undefined {
	if (value === undefined) return undefined
	if (!Array.isArray(value)) throw new AgentBoundaryError('parse', '模型返回了无效的自由笔迹点。')
	return value.map(validatePoint)
}

function requiredId(value: unknown, label: string): string {
	if (typeof value === 'string' && value.length > 0) return value
	throw new AgentBoundaryError('parse', `模型返回了无效的${label}。`)
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]) {
	const allowedFields = new Set(allowed)
	const unknown = Object.keys(value).find((key) => !allowedFields.has(key))
	if (unknown) throw new AgentBoundaryError('parse', `模型返回了不支持的字段：${unknown}`)
}

function isLocalHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function isCanvasElementType(value: unknown): value is CanvasElementSpec['type'] {
	return typeof value === 'string' && CANVAS_ELEMENT_TYPES.has(value)
}

function isLinearCanvasElementType(type: string): boolean {
	return type === 'arrow' || type === 'line' || type === 'freedraw'
}
