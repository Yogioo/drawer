import type { AppState } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import {
	CanvasAgentAction,
	CanvasElementSummary,
	CanvasPrompt,
	CanvasViewport,
} from '../shared/canvas'

export interface ChatEntry {
	role: 'user' | 'assistant'
	content: string
}

export function createCanvasPrompt(
	message: string,
	elements: readonly ExcalidrawElement[],
	appState: AppState,
	history: readonly ChatEntry[]
): CanvasPrompt {
	const visibleElements = elements.filter((element) => !element.isDeleted)
	return {
		message,
		elements: visibleElements.map(toSummary).filter((summary): summary is CanvasElementSummary => !!summary),
		selectedElementIds: Object.entries(appState.selectedElementIds)
			.filter(([, selected]) => selected)
			.map(([id]) => id),
		viewport: getViewport(appState),
		history: history.slice(-12),
	}
}

export async function streamCanvasAgent(
	prompt: CanvasPrompt,
	signal: AbortSignal,
	onAction: (action: CanvasAgentAction) => void
): Promise<void> {
	const response = await fetch('/stream', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(prompt),
		signal,
	})

	if (!response.ok) {
		throw new Error(`AI 服务返回 HTTP ${response.status}`)
	}
	if (!response.body) {
		throw new Error('AI 服务没有返回数据流。')
	}

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''

	try {
		while (true) {
			const { value, done } = await reader.read()
			buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
			const events = buffer.split('\n\n')
			buffer = events.pop() ?? ''

			for (const event of events) {
				consumeEvent(event, onAction)
			}
			if (done) break
		}

		if (buffer.trim()) {
			consumeEvent(buffer, onAction)
		}
	} finally {
		reader.releaseLock()
	}
}

function consumeEvent(event: string, onAction: (action: CanvasAgentAction) => void) {
	const data = event
		.split('\n')
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())
		.join('\n')
	if (!data) return

	const parsed = JSON.parse(data) as CanvasAgentAction | { error: string }
	if ('error' in parsed) {
		throw new Error(parsed.error)
	}
	onAction(parsed)
}

function toSummary(element: ExcalidrawElement): CanvasElementSummary | null {
	const supportedType = getSupportedType(element.type)
	if (!supportedType) return null

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

	if (element.type === 'text') {
		summary.text = element.text
	}
	if ('points' in element) {
		summary.points = element.points.slice(0, 80).map(([x, y]) => ({ x, y }))
	}
	if ('containerId' in element && element.containerId) {
		summary.text = summary.text || ''
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
		type === 'freedraw'
	) {
		return type
	}
	return null
}

function getViewport(appState: AppState): CanvasViewport {
	const zoom = appState.zoom.value || 1
	return {
		x: Math.round(-appState.scrollX / zoom),
		y: Math.round(-appState.scrollY / zoom),
		w: Math.round(appState.width / zoom),
		h: Math.round(appState.height / zoom),
	}
}
