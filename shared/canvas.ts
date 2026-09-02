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

export interface CanvasImageContext {
	fileId: string
	mimeType: string
	dataUrl: string
}

export interface CanvasElementSummary extends Omit<CanvasElementSpec, 'type'> {
	id: string
	type: CanvasElementType | 'image'
	width: number
	height: number
	startBindingElementId?: string
	endBindingElementId?: string
	boundElementIds?: string[]
	image?: CanvasImageContext
}

export interface CanvasLayoutElement {
	id: string
	type: string
	x: number
	y: number
	width: number
	height: number
}

export type CanvasLayoutAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type CanvasLayoutAxis = 'horizontal' | 'vertical'
export type CanvasLayoutDirection = 'ascending' | 'descending'

export interface CanvasLayoutAction {
	_type: 'layout'
	operation: 'align' | 'distribute' | 'sort'
	elementIds: string[]
	alignment?: CanvasLayoutAlignment
	axis?: CanvasLayoutAxis
	direction?: CanvasLayoutDirection
	intent?: string
}

export interface CanvasPointBinding {
	elementId: string
	focus: number
	gap: number
}

export interface CanvasBoundElement {
	id: string
	type: 'arrow' | 'text'
}

export interface CanvasBindingElement extends CanvasLayoutElement {
	points?: readonly (CanvasPoint | readonly [number, number])[]
	startBinding?: CanvasPointBinding | null
	endBinding?: CanvasPointBinding | null
	boundElements?: readonly CanvasBoundElement[] | null
	startBindingElementId?: string
	endBindingElementId?: string
	boundElementIds?: readonly string[]
}

export interface CanvasBindAction {
	_type: 'bind'
	arrowId: string
	startElementId?: string | null
	endElementId?: string | null
	intent?: string
}

export const MAX_CANVAS_CONTEXT_ELEMENTS = 120
export const MAX_CANVAS_CONTEXT_POINTS = 32
export const MAX_CANVAS_CONTEXT_TEXT_LENGTH = 1_000
export const MAX_CANVAS_HISTORY_ENTRIES = 8
export const MAX_CANVAS_HISTORY_CHARS = 6_000
export const MAX_CANVAS_SELECTED_IDS = 120
export const MAX_CANVAS_IMAGE_COUNT = 4
export const MAX_CANVAS_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_CANVAS_IMAGE_CONTEXT_BYTES = 12 * 1024 * 1024
export const CANVAS_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

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
	includeImageContext?: boolean
}

export type CanvasHistoryEntry = CanvasPrompt['history'][number]

export function isSupportedCanvasImageMimeType(value: string): boolean {
	return (CANVAS_IMAGE_MIME_TYPES as readonly string[]).includes(value.toLowerCase())
}

const CANVAS_IMAGE_DATA_URL = /^data:([^;,]+);base64,([a-z\d+/]*={0,2})$/i

export function canvasImageDataUrlMimeType(value: string): string | null {
	const match = CANVAS_IMAGE_DATA_URL.exec(value)
	return match?.[1].toLowerCase() ?? null
}

export function canvasImageDataUrlByteLength(value: string): number | null {
	const match = CANVAS_IMAGE_DATA_URL.exec(value)
	if (!match || !isSupportedCanvasImageMimeType(match[1])) return null
	const base64 = match[2]
	if (base64.length % 4 === 1) return null
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

export function isExplicitCanvasImageRequest(message: string): boolean {
	const normalized = message.toLowerCase()
	const imageReference = /\b(?:images?|pictures?|photos?|screenshots?|pics?)\b|图片|图像|照片|截图|图里|图中|这张图|该图|这幅图/i.test(normalized)
	const analysisIntent =
		/(?:\b(?:analy[sz]e|describe|read|recogniz|identify|inspect|examine|look(?:\s+at)?|view|summari[sz]e?|extract|ocr)\b|\btell\s+me\s+about\b|\bwhat(?:'s| is| do you see)\b|内容|文字|文本|分析|描述|读取|识别|查看|看看|看一下|看下|看一看|帮我看|介绍|有什么)/i.test(
			normalized
		)
	const negatedAnalysisIntent =
		/(?:\b(?:do not|don't|dont|never|not)\s+(?:analy[sz]e|describe|read|recogniz(?:e|ing)?|identify|inspect|examine|look|view|summari[sz]e?|extract|ocr)\b|(?:不要|无需|不用|别)\s*(?:分析|描述|读取|识别|查看|看看|看一下|看下|看一看))/i.test(
			normalized
		)
	return imageReference && analysisIntent && !negatedAnalysisIntent
}

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

	const prioritizedElements = relevant.filter((element) => element.type === 'image').slice(0, MAX_CANVAS_CONTEXT_ELEMENTS)
	const prioritizedIds = new Set(prioritizedElements.map((element) => element.id))
	const remaining = Math.max(0, MAX_CANVAS_CONTEXT_ELEMENTS - prioritizedElements.length)
	const selectedElements =
		remaining > 0
			? relevant
					.filter((element) => selected.has(element.id) && !prioritizedIds.has(element.id))
					.slice(-remaining)
			: []
	const viewportElements = relevant.filter((element) => !selected.has(element.id) && !prioritizedIds.has(element.id))
	const available = Math.max(0, remaining - selectedElements.length)
	return [...viewportElements.slice(0, available), ...selectedElements, ...prioritizedElements].map(compactCanvasElement)
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
	| CanvasLayoutAction
	| CanvasBindAction

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

export function applyCanvasLayout<T extends CanvasLayoutElement>(
	elements: readonly T[],
	action: CanvasLayoutAction
): T[] {
	const selectedIds = new Set(action.elementIds)
	const selected = elements.filter((element) => selectedIds.has(element.id))
	if (selected.length < 2) return [...elements]

	if (action.operation === 'sort') {
		const axis = action.axis ?? 'horizontal'
		const direction = action.direction === 'descending' ? -1 : 1
		const sorted = [...selected].sort((left, right) => {
			const leftValue = axis === 'horizontal' ? left.x : left.y
			const rightValue = axis === 'horizontal' ? right.x : right.y
			return (leftValue - rightValue) * direction
		})
		let sortedIndex = 0
		const next = elements.map((element) =>
			selectedIds.has(element.id) ? sorted[sortedIndex++] : element
		)
		return next.some((element, index) => element !== elements[index]) ? next : [...elements]
	}

	const positions = new Map<string, { x: number; y: number }>()
	if (action.operation === 'align') {
		const alignment = action.alignment ?? 'left'
		const minX = Math.min(...selected.map((element) => element.x))
		const maxRight = Math.max(...selected.map((element) => element.x + element.width))
		const minY = Math.min(...selected.map((element) => element.y))
		const maxBottom = Math.max(...selected.map((element) => element.y + element.height))
		const centerX = (minX + maxRight) / 2
		const centerY = (minY + maxBottom) / 2
		for (const element of selected) {
			const x =
				alignment === 'left'
					? minX
					: alignment === 'right'
						? maxRight - element.width
						: alignment === 'center'
							? centerX - element.width / 2
							: element.x
			const y =
				alignment === 'top'
					? minY
					: alignment === 'bottom'
						? maxBottom - element.height
						: alignment === 'middle'
							? centerY - element.height / 2
							: element.y
			positions.set(element.id, { x, y })
		}
	} else {
		const axis = action.axis ?? 'horizontal'
		const ordered = [...selected].sort((left, right) =>
			(axis === 'horizontal' ? left.x - right.x : left.y - right.y)
		)
		const first = ordered[0]
		const last = ordered[ordered.length - 1]
		const totalSize = ordered.reduce(
			(total, element) => total + (axis === 'horizontal' ? element.width : element.height),
			0
		)
		const start = axis === 'horizontal' ? first.x : first.y
		const end = axis === 'horizontal' ? last.x + last.width : last.y + last.height
		const gap = (end - start - totalSize) / (ordered.length - 1)
		let cursor = start
		for (const element of ordered) {
			positions.set(
				element.id,
				axis === 'horizontal' ? { x: cursor, y: element.y } : { x: element.x, y: cursor }
			)
			cursor += (axis === 'horizontal' ? element.width : element.height) + gap
		}
	}

	let changed = false
	const next = elements.map((element) => {
		const position = positions.get(element.id)
		if (!position || (position.x === element.x && position.y === element.y)) return element
		changed = true
		return { ...element, ...position }
	})
	return changed ? next : [...elements]
}

export function applyCanvasBinding<T extends CanvasLayoutElement>(
	elements: readonly T[],
	action: CanvasBindAction
): T[] {
	if (action.startElementId === undefined && action.endElementId === undefined) return [...elements]
	const arrow = elements.find((element) => element.id === action.arrowId)
	if (!arrow || arrow.type !== 'arrow') return [...elements]

	const source = arrow as CanvasBindingElement
	const startElementId =
		action.startElementId === undefined
			? readBindingElementId(source, 'start')
			: action.startElementId
	const endElementId =
		action.endElementId === undefined
			? readBindingElementId(source, 'end')
			: action.endElementId
	const targets = new Map(elements.map((element) => [element.id, element]))
	if (startElementId && !isBindableTarget(targets.get(startElementId), arrow.id)) return [...elements]
	if (endElementId && !isBindableTarget(targets.get(endElementId), arrow.id)) return [...elements]

	const nextById = new Map<string, CanvasBindingElement>()
	const copy = (id: string): CanvasBindingElement | undefined => {
		const existing = nextById.get(id)
		if (existing) return existing
		const element = targets.get(id)
		if (!element) return undefined
		const cloned = { ...element } as CanvasBindingElement
		nextById.set(id, cloned)
		return cloned
	}

	const nextArrow = copy(arrow.id)
	if (!nextArrow) return [...elements]
	const previousTargetIds = [readBindingElementId(source, 'start'), readBindingElementId(source, 'end')]
	for (const targetId of previousTargetIds) {
		if (targetId && targetId !== startElementId && targetId !== endElementId) {
			removeBoundArrow(copy(targetId), arrow.id)
		}
	}
	for (const targetId of [startElementId, endElementId]) {
		if (targetId) addBoundArrow(copy(targetId), arrow.id)
	}

	const points = readCanvasPoints(source)
	const nextPoints = points.length >= 2 ? points : [{ x: 0, y: 0 }, { x: source.width, y: 0 }]
	const startTarget = startElementId ? targets.get(startElementId) : undefined
	const endTarget = endElementId ? targets.get(endElementId) : undefined
	if (startTarget) {
		nextPoints[0] = toLocalPoint(
			getBindingAnchor(startTarget, toGlobalPoint(source, nextPoints[nextPoints.length - 1]), 'start'),
			source
		)
	}
	if (endTarget) {
		nextPoints[nextPoints.length - 1] = toLocalPoint(
			getBindingAnchor(endTarget, toGlobalPoint(source, nextPoints[0]), 'end'),
			source
		)
	}
	if (action.startElementId !== undefined) {
		setBinding(nextArrow, 'start', startElementId, source.startBinding)
	}
	if (action.endElementId !== undefined) {
		setBinding(nextArrow, 'end', endElementId, source.endBinding)
	}
	setCanvasPoints(nextArrow, nextPoints, source.points)

	const next = elements.map((element) => nextById.get(element.id) ?? element) as T[]
	return next.some((element, index) => element !== elements[index]) ? next : [...elements]
}

function readBindingElementId(element: CanvasBindingElement, edge: 'start' | 'end'): string | undefined {
	const binding = edge === 'start' ? element.startBinding : element.endBinding
	return binding?.elementId ?? (edge === 'start' ? element.startBindingElementId : element.endBindingElementId)
}

function isBindableTarget(element: CanvasLayoutElement | undefined, arrowId: string): boolean {
	return !!element && element.id !== arrowId &&
		isCanvasBindableElementType(element.type)
}

export function isCanvasBindableElementType(type: string): boolean {
	return type === 'rectangle' || type === 'ellipse' || type === 'diamond' || type === 'text'
}

function readCanvasPoints(element: CanvasBindingElement): CanvasPoint[] {
	return (element.points ?? []).map((point) => {
		if (Array.isArray(point)) return { x: point[0], y: point[1] }
		const canvasPoint = point as CanvasPoint
		return { x: canvasPoint.x, y: canvasPoint.y }
	})
}

function setCanvasPoints(
	element: CanvasBindingElement,
	points: readonly CanvasPoint[],
	originalPoints: CanvasBindingElement['points']
) {
	if (originalPoints?.some((point) => Array.isArray(point))) {
		element.points = points.map((point) => [point.x, point.y] as [number, number])
	} else {
		element.points = points
	}
}

function toGlobalPoint(element: CanvasLayoutElement, point: CanvasPoint): CanvasPoint {
	return { x: element.x + point.x, y: element.y + point.y }
}

function toLocalPoint(point: CanvasPoint, element: CanvasLayoutElement): CanvasPoint {
	return { x: point.x - element.x, y: point.y - element.y }
}

function getBindingAnchor(
	target: CanvasLayoutElement,
	reference: CanvasPoint,
	edge: 'start' | 'end'
): CanvasPoint {
	const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
	let dx = reference.x - center.x
	let dy = reference.y - center.y
	if (dx === 0 && dy === 0) dx = edge === 'start' ? -1 : 1
	const halfWidth = Math.max(target.width / 2, 1)
	const halfHeight = Math.max(target.height / 2, 1)
	const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight)
	return { x: center.x + dx * scale, y: center.y + dy * scale }
}

function setBinding(
	element: CanvasBindingElement,
	edge: 'start' | 'end',
	targetId: string | null | undefined,
	previous: CanvasPointBinding | null | undefined
) {
	const binding = targetId
		? previous?.elementId === targetId
			? previous
			: { elementId: targetId, focus: 0, gap: 1 }
		: null
	if (edge === 'start') {
		if (Object.prototype.hasOwnProperty.call(element, 'startBinding')) element.startBinding = binding
		else element.startBindingElementId = targetId ?? undefined
	} else {
		if (Object.prototype.hasOwnProperty.call(element, 'endBinding')) element.endBinding = binding
		else element.endBindingElementId = targetId ?? undefined
	}
}

function addBoundArrow(element: CanvasBindingElement | undefined, arrowId: string) {
	if (!element) return
	if (element.boundElements !== undefined) {
		const current = [...(element.boundElements ?? [])]
		if (current.some((bound) => bound.type === 'arrow' && bound.id === arrowId)) return
		element.boundElements = [...current, { id: arrowId, type: 'arrow' }]
		return
	}
	const current = [...(element.boundElementIds ?? [])]
	if (current.includes(arrowId)) return
	element.boundElementIds = [...current, arrowId]
}

function removeBoundArrow(element: CanvasBindingElement | undefined, arrowId: string) {
	if (!element) return
	if (element.boundElements !== undefined) {
		element.boundElements = (element.boundElements ?? []).filter(
			(bound) => bound.type !== 'arrow' || bound.id !== arrowId
		)
		return
	}
	element.boundElementIds = (element.boundElementIds ?? []).filter((id) => id !== arrowId)
}
