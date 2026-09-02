export type CanvasElementType =
	| 'rectangle'
	| 'ellipse'
	| 'diamond'
	| 'text'
	| 'arrow'
	| 'line'
	| 'freedraw'

export interface CanvasPoint {
	x: number
	y: number
}

export interface CanvasElementSpec {
	id?: string
	type: CanvasElementType
	x: number
	y: number
	width?: number
	height?: number
	text?: string
	points?: CanvasPoint[]
	strokeColor?: string
	backgroundColor?: string
	strokeWidth?: number
	strokeStyle?: 'solid' | 'dashed' | 'dotted'
	roughness?: number
}

export interface CanvasElementSummary extends CanvasElementSpec {
	id: string
	width: number
	height: number
}

export const MAX_CANVAS_CONTEXT_ELEMENTS = 120
export const MAX_CANVAS_CONTEXT_POINTS = 32
export const MAX_CANVAS_CONTEXT_TEXT_LENGTH = 1_000
export const MAX_CANVAS_HISTORY_ENTRIES = 8
export const MAX_CANVAS_HISTORY_CHARS = 6_000
export const MAX_CANVAS_SELECTED_IDS = 120

export interface CanvasViewport {
	x: number
	y: number
	w: number
	h: number
}

export interface CanvasPrompt {
	message: string
	elements: CanvasElementSummary[]
	selectedElementIds: string[]
	viewport: CanvasViewport
	history: { role: 'user' | 'assistant'; content: string }[]
}

export type CanvasHistoryEntry = CanvasPrompt['history'][number]

export function boundCanvasSelectedElementIds(selectedElementIds: readonly string[]): string[] {
	return [...new Set(selectedElementIds)].slice(0, MAX_CANVAS_SELECTED_IDS)
}

export function selectCanvasContextElements(
	elements: readonly CanvasElementSummary[],
	selectedElementIds: readonly string[],
	viewport: CanvasViewport
): CanvasElementSummary[] {
	const selected = new Set(selectedElementIds)
	const relevant = elements.filter(
		(element) => selected.has(element.id) || intersectsCanvasViewport(element, viewport)
	)
	if (relevant.length <= MAX_CANVAS_CONTEXT_ELEMENTS) return relevant.map(compactCanvasElement)

	const selectedElements = relevant
		.filter((element) => selected.has(element.id))
		.slice(-MAX_CANVAS_CONTEXT_ELEMENTS)
	const viewportElements = relevant.filter((element) => !selected.has(element.id))
	const available = Math.max(0, MAX_CANVAS_CONTEXT_ELEMENTS - selectedElements.length)
	return [...viewportElements.slice(0, available), ...selectedElements].map(compactCanvasElement)
}

export function boundCanvasHistory(history: readonly CanvasHistoryEntry[]): CanvasHistoryEntry[] {
	let remaining = MAX_CANVAS_HISTORY_CHARS
	const recent: CanvasHistoryEntry[] = []
	for (let index = history.length - 1; index >= 0 && recent.length < MAX_CANVAS_HISTORY_ENTRIES; index -= 1) {
		if (remaining <= 0) break
		const entry = history[index]
		const content = entry.content.slice(0, remaining)
		recent.push({ role: entry.role, content })
		remaining -= content.length
	}
	return recent.reverse()
}

function compactCanvasElement(element: CanvasElementSummary): CanvasElementSummary {
	return {
		...element,
		text: element.text?.slice(0, MAX_CANVAS_CONTEXT_TEXT_LENGTH),
		points: element.points?.slice(0, MAX_CANVAS_CONTEXT_POINTS),
	}
}

export function intersectsCanvasViewport(
	element: Pick<CanvasElementSummary, 'x' | 'y' | 'width' | 'height'>,
	viewport: CanvasViewport
): boolean {
	return (
		element.x < viewport.x + viewport.w &&
		element.x + element.width > viewport.x &&
		element.y < viewport.y + viewport.h &&
		element.y + element.height > viewport.y
	)
}

export type CanvasAgentAction =
	| {
			_type: 'message'
			text: string
		}
	| {
			_type: 'create'
			elements: CanvasElementSpec[]
			intent?: string
		}
	| {
			_type: 'update'
			elementId: string
			updates: Partial<CanvasElementSpec>
			intent?: string
		}
	| {
			_type: 'move'
			elementId: string
			x: number
			y: number
			intent?: string
		}
	| {
			_type: 'delete'
			elementId: string
			intent?: string
		}
	| {
			_type: 'clear'
			intent?: string
		}

export interface CanvasAgentResponse {
	actions: CanvasAgentAction[]
}

export type CanvasAgentErrorCode =
	| 'configuration'
	| 'authentication'
	| 'network'
	| 'timeout'
	| 'provider'
	| 'parse'
	| 'client'
	| 'cors'

export interface CanvasAgentErrorEvent {
	code: CanvasAgentErrorCode
	message: string
	retryable?: boolean
	requestId?: string
}
