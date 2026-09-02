import { createOpenAI, OpenAIProvider } from '@ai-sdk/openai'
import { streamText } from 'ai'
import {
	CanvasAgentAction,
	CanvasAgentResponse,
	CanvasElementSpec,
	CanvasPrompt,
} from '../../shared/canvas'
import { Environment } from '../environment'

const MODEL_NAME = 'grok-4.6'

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

export class AgentService {
	private readonly openai: OpenAIProvider
	private readonly modelName: string

	constructor(env: Environment) {
		if (!env.OPENAI_API_KEY) {
			throw new Error('缺少 OPENAI_API_KEY，请在本地 .dev.vars 中配置。')
		}

		this.openai = createOpenAI({
			apiKey: env.OPENAI_API_KEY,
			baseURL: env.OPENAI_BASE_URL,
		})
		this.modelName = env.OPENAI_MODEL || MODEL_NAME
	}

	async getActions(prompt: CanvasPrompt): Promise<CanvasAgentAction[]> {
		const result = streamText({
			model: this.openai.chat(this.modelName),
			system: SYSTEM_PROMPT,
			messages: [
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
			maxOutputTokens: 8192,
			temperature: 0,
		})

		let responseText = ''
		for await (const text of result.textStream) {
			responseText += text
		}

		return parseResponse(responseText).actions
	}
}

function parseResponse(value: string): CanvasAgentResponse {
	const withoutFence = value
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
	const start = withoutFence.indexOf('{')
	const end = withoutFence.lastIndexOf('}')
	if (start === -1 || end <= start) {
		throw new Error('模型没有返回有效的 JSON。')
	}

	const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as Partial<CanvasAgentResponse>
	if (!Array.isArray(parsed.actions)) {
		throw new Error('模型返回的 JSON 缺少 actions 数组。')
	}

	return {
		actions: parsed.actions.map(validateAction),
	}
}

function validateAction(action: unknown): CanvasAgentAction {
	if (!action || typeof action !== 'object' || !('_type' in action)) {
		throw new Error('模型返回了无效的画布操作。')
	}

	const candidate = action as Record<string, unknown>
	const type = candidate._type
	if (type === 'message' && typeof candidate.text === 'string') {
		return { _type: 'message', text: candidate.text }
	}
	if (type === 'clear') {
		return { _type: 'clear', intent: optionalString(candidate.intent) }
	}
	if (type === 'delete' && typeof candidate.elementId === 'string') {
		return {
			_type: 'delete',
			elementId: candidate.elementId,
			intent: optionalString(candidate.intent),
		}
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
			updates: candidate.updates as Partial<CanvasElementSpec>,
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

	throw new Error(`模型返回了无效的操作类型：${String(type)}`)
}

function validateElement(value: unknown): CanvasElementSpec {
	if (!isRecord(value)) throw new Error('模型返回了无效的画布元素。')
	const type = value.type
	const validTypes = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'freedraw'])
	if (typeof type !== 'string' || !validTypes.has(type)) {
		throw new Error(`模型返回了不支持的元素类型：${String(type)}`)
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
	if (!isRecord(value)) throw new Error('模型返回了无效的自由笔迹点。')
	return { x: numberValue(value.x), y: numberValue(value.y) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function numberValue(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error('模型返回了无效的数字。')
	}
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
