import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import {
	boundCanvasSelectedElementIds,
	boundCanvasHistory,
	canvasImageDataUrlByteLength,
	canvasImageDataUrlMimeType,
	intersectsCanvasViewport,
	isExplicitCanvasImageRequest,
	isSupportedCanvasImageMimeType,
	MAX_CANVAS_IMAGE_BYTES,
	MAX_CANVAS_IMAGE_CONTEXT_BYTES,
	MAX_CANVAS_IMAGE_COUNT,
	MAX_CANVAS_CONTEXT_POINTS,
	selectCanvasContextElements,
} from '../shared/canvas.ts'
import type {
	CanvasAgentAction,
	CanvasAgentErrorCode,
	CanvasElementSummary,
	CanvasPrompt,
	CanvasViewport,
} from '../shared/canvas'

export interface ChatEntry {
	role: 'user' | 'assistant'
	content: string
}

export { isExplicitCanvasImageRequest } from '../shared/canvas.ts'

export class CanvasAgentClientError extends Error {
	readonly code: CanvasAgentErrorCode
	readonly retryable: boolean

	constructor(code: CanvasAgentErrorCode, message: string, retryable = false) {
		super(message)
		this.name = 'CanvasAgentClientError'
		this.code = code
		this.retryable = retryable
	}
}

export function createCanvasPrompt(
	message: string,
	elements: readonly ExcalidrawElement[],
	appState: AppState,
	history: readonly ChatEntry[],
	files?: BinaryFiles
): CanvasPrompt {
	const visibleElements = elements.filter((element) => !element.isDeleted)
	const selectedElementIds = boundCanvasSelectedElementIds(
		Object.entries(appState.selectedElementIds)
			.filter(([, selected]) => selected)
			.map(([id]) => id)
	)
	const viewport = getViewport(appState)
	const selected = new Set(selectedElementIds)
	const contextCandidates = visibleElements.filter(
		(element) => selected.has(element.id) || intersectsCanvasViewport(element, viewport)
	)
	const includeImageContext = isExplicitCanvasImageRequest(message)
	const imageCandidates = contextCandidates.filter((element) => element.type === 'image')
	if (includeImageContext && imageCandidates.length === 0) {
		throw new CanvasAgentClientError(
			'client',
			'当前视口或选区没有可分析的图片元素，请选择或移入一张图片后重试。'
		)
	}
	const summaries = contextCandidates
		.map((element) => toSummary(element, includeImageContext, files ?? {}))
		.filter((summary): summary is CanvasElementSummary => !!summary)
	if (includeImageContext) validateImageContext(summaries)
	const supportedElementIds = new Set(summaries.map((summary) => summary.id))
	const supportedSelectedElementIds = selectedElementIds.filter((id) => supportedElementIds.has(id))
	return {
		message,
		elements: selectCanvasContextElements(summaries, supportedSelectedElementIds, viewport),
		selectedElementIds: supportedSelectedElementIds,
		viewport,
		history: boundCanvasHistory(history),
		...(includeImageContext ? { includeImageContext: true } : {}),
	}
}

export async function streamCanvasAgent(
	prompt: CanvasPrompt,
	signal: AbortSignal,
	onAction: (action: CanvasAgentAction) => void | Promise<void>
): Promise<void> {
	let response: Response
	try {
		response = await fetch(getWorkerStreamUrl(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(prompt),
			signal,
		})
	} catch (error) {
		if (signal.aborted) throw error
		throw new CanvasAgentClientError('network', '无法连接 AI Worker，请检查网络或请求地址。', true)
	}

	if (!response.ok) throw await readHttpError(response)
	if (!response.body) throw new CanvasAgentClientError('network', 'AI Worker 没有返回数据流。', true)

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	let completed = false

	try {
		while (true) {
			const { value, done } = await reader.read()
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
			const events = buffer.split(/\r?\n\r?\n/)
			buffer = events.pop() ?? ''

			for (const event of events) completed = (await consumeEvent(event, onAction)) || completed
			if (done) break
		}

		if (buffer.trim()) completed = (await consumeEvent(buffer, onAction)) || completed
		if (!completed) throw new CanvasAgentClientError('network', 'AI Worker 连接意外关闭，请重试。', true)
	} finally {
		if (!completed) await reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

async function consumeEvent(
	event: string,
	onAction: (action: CanvasAgentAction) => void | Promise<void>
): Promise<boolean> {
	const lines = event.split(/\r?\n/)
	const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? ''
	const data = lines
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())
		.join('\n')
	if (!data) return eventName === 'done'
	if (eventName === 'done') return true

	try {
		const parsed = JSON.parse(data) as
			| CanvasAgentAction
			| { error: string }
			| { code: CanvasAgentErrorCode; message: string; retryable?: boolean }
		if (eventName === 'error') {
			if (!isErrorEvent(parsed)) throw new CanvasAgentClientError('parse', 'AI Worker 返回了无效的错误事件。')
			throw new CanvasAgentClientError(parsed.code, parsed.message, parsed.retryable === true)
		}
		if ('error' in parsed) throw new CanvasAgentClientError('provider', parsed.error)
		await onAction(parsed as CanvasAgentAction)
		return false
	} catch (error) {
		if (error instanceof CanvasAgentClientError) throw error
		throw new CanvasAgentClientError('parse', 'AI Worker 返回了无效的数据。')
	}
}

function isErrorEvent(
	value: CanvasAgentAction | { error: string } | { code: CanvasAgentErrorCode; message: string; retryable?: boolean }
): value is { code: CanvasAgentErrorCode; message: string; retryable?: boolean } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'code' in value &&
		'message' in value &&
		isCanvasAgentErrorCode(value.code) &&
		typeof value.message === 'string'
	)
}

function isCanvasAgentErrorCode(value: unknown): value is CanvasAgentErrorCode {
	return (
		value === 'configuration' ||
		value === 'authentication' ||
		value === 'network' ||
		value === 'timeout' ||
		value === 'provider' ||
		value === 'parse' ||
		value === 'client' ||
		value === 'cors'
	)
}

async function readHttpError(response: Response): Promise<CanvasAgentClientError> {
	try {
		const body = (await response.json()) as {
			error?: { code?: CanvasAgentErrorCode; message?: string; retryable?: boolean }
		}
		const error = body.error
		if (error?.code && error.message && isCanvasAgentErrorCode(error.code)) {
			return new CanvasAgentClientError(error.code, error.message, error.retryable === true)
		}
	} catch {
		// Fall back to a status-only message for non-Worker responses.
	}
	return new CanvasAgentClientError('network', `AI Worker 返回 HTTP ${response.status}。`, response.status >= 500)
}

export function getWorkerStreamUrl(): string {
	const configured = import.meta.env?.VITE_AI_WORKER_URL?.trim()
	if (!configured) {
		if (isDesktopRuntime()) {
			throw new CanvasAgentClientError('configuration', '桌面版需要配置远程 AI Worker 地址。')
		}
		return '/stream'
	}

	let url: URL
	try {
		url = new URL(configured, window.location.origin)
	} catch {
		throw new CanvasAgentClientError('client', 'AI Worker 地址配置无效。')
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
		throw new CanvasAgentClientError('client', '远程 AI Worker 地址必须使用 HTTPS。')
	}
	if (url.pathname === '/' || url.pathname === '') url.pathname = '/stream'
	return url.toString()
}

function isLocalHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function isDesktopRuntime(): boolean {
	return (
		typeof window !== 'undefined' &&
		(window.location.hostname === 'tauri.localhost' || window.location.protocol === 'tauri:')
	)
}

function toSummary(element: ExcalidrawElement, includeImageContext: boolean, files: BinaryFiles): CanvasElementSummary | null {
	const supportedType = getSupportedType(element.type)
	if (!supportedType) return null
	if (element.type === 'image' && !includeImageContext) return null

	const summary: CanvasElementSummary = {
		id: element.id,
		type: supportedType,
		x: Math.round(element.x),
		y: Math.round(element.y),
		width: Math.round(element.width),
		height: Math.round(element.height),
		strokeColor: element.strokeColor,
		backgroundColor: element.backgroundColor,
		strokeWidth: element.strokeWidth,
		strokeStyle: element.strokeStyle,
		roughness: element.roughness,
	}

	if (element.type === 'text') summary.text = element.text
	if ('points' in element) {
		summary.points = element.points
			.slice(0, MAX_CANVAS_CONTEXT_POINTS)
			.map(([x, y]) => ({ x, y }))
	}
	if ('containerId' in element && element.containerId) summary.text = summary.text || ''
	if (element.type === 'arrow') {
		if (element.startBinding) summary.startBindingElementId = element.startBinding.elementId
		if (element.endBinding) summary.endBindingElementId = element.endBinding.elementId
	}
	if (element.boundElements?.length) summary.boundElementIds = element.boundElements.map(({ id }) => id)
	if (element.type === 'image') {
		const fileId = element.fileId
		if (!fileId || !files[fileId]) {
			throw new CanvasAgentClientError('client', `图片文件缺失：${element.id}，请重新插入图片后重试。`)
		}
		const file = files[fileId]
		const dataUrl = String(file.dataURL)
		const mimeType = String(file.mimeType).toLowerCase()
		if (!isSupportedCanvasImageMimeType(mimeType)) {
			throw new CanvasAgentClientError('client', `图片 ${element.id} 的格式不受支持，请转换后重试。`)
		}
		const bytes = canvasImageDataUrlByteLength(dataUrl)
		if (bytes === null || bytes === 0) {
			throw new CanvasAgentClientError('client', `图片 ${element.id} 的数据无效，请重新插入图片后重试。`)
		}
		if (bytes > MAX_CANVAS_IMAGE_BYTES) {
			throw new CanvasAgentClientError('client', `图片 ${element.id} 超过单张大小限制，请压缩图片后重试。`)
		}
		if (canvasImageDataUrlMimeType(dataUrl) !== mimeType) {
			throw new CanvasAgentClientError('client', `图片 ${element.id} 的格式无效，请重新插入图片后重试。`)
		}
		summary.image = { fileId, mimeType, dataUrl }
	}
	return summary
}

function getSupportedType(type: ExcalidrawElement['type']): CanvasElementSummary['type'] | null {
	if (
		type === 'rectangle' ||
		type === 'ellipse' ||
		type === 'diamond' ||
		type === 'text' ||
		type === 'arrow' ||
		type === 'line' ||
		type === 'freedraw' ||
		type === 'image'
	) {
		return type
	}
	return null
}

function validateImageContext(elements: readonly CanvasElementSummary[]) {
	const images = elements.filter((element) => element.type === 'image')
	if (images.length > MAX_CANVAS_IMAGE_COUNT) {
		throw new CanvasAgentClientError(
			'client',
			`一次最多分析 ${MAX_CANVAS_IMAGE_COUNT} 张图片，请减少选区后重试。`
		)
	}
	let totalBytes = 0
	for (const element of images) {
		const bytes = canvasImageDataUrlByteLength(element.image?.dataUrl ?? '')
		if (bytes === null || bytes === 0) {
			throw new CanvasAgentClientError('client', `图片 ${element.id} 的数据无效，请重新插入图片后重试。`)
		}
		totalBytes += bytes
	}
	if (totalBytes > MAX_CANVAS_IMAGE_CONTEXT_BYTES) {
		throw new CanvasAgentClientError('client', '图片上下文总大小超出限制，请减少图片数量或压缩图片后重试。')
	}
}

function getViewport(appState: AppState): CanvasViewport {
	const zoom = appState.zoom.value || 1
	return {
		x: roundedCoordinate(-appState.scrollX / zoom),
		y: roundedCoordinate(-appState.scrollY / zoom),
		w: Math.round(appState.width / zoom),
		h: Math.round(appState.height / zoom),
	}
}

function roundedCoordinate(value: number): number {
	const rounded = Math.round(value)
	return rounded === 0 ? 0 : rounded
}
