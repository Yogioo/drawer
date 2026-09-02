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
