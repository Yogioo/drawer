import {
	applyCanvasBinding,
	applyCanvasLayout,
	isCanvasBindableElementType,
	type CanvasAgentAction,
	type CanvasElementSpec,
	type CanvasBindingElement,
} from '../shared/canvas.ts'

export interface CanvasOperationElement {
	id: string
	type: string
	x: number
	y: number
	width: number
	height: number
}

export interface CanvasOperationAdapter<T extends CanvasOperationElement> {
	create(specs: readonly CanvasElementSpec[]): readonly T[]
	update(element: T, updates: Partial<CanvasElementSpec>): T
	bump(element: T): T
}

export interface CanvasOperationRecord<T extends CanvasOperationElement> {
	id: string
	status: 'pending' | 'applied' | 'rejected' | 'failed' | 'undone'
	actions: readonly CanvasAgentAction[]
	request?: string
	before: readonly T[]
	after?: readonly T[]
	error?: string
}

export class CanvasOperationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CanvasOperationError'
	}
}

export function createCanvasOperationAdapter<T extends CanvasOperationElement>(
	adapter: CanvasOperationAdapter<T>
): CanvasOperationAdapter<T> {
	return adapter
}

export function executeCanvasOperation<T extends CanvasOperationElement>(
	elements: readonly T[],
	actions: readonly CanvasAgentAction[],
	adapter: CanvasOperationAdapter<T>
): T[] {
	let current = [...elements]

	for (const action of actions) {
		if (action._type === 'message') continue

		switch (action._type) {
			case 'create': {
				const created = [...adapter.create(action.elements)]
				if (created.length !== action.elements.length) {
					throw new CanvasOperationError('AI 创建元素失败。')
				}
				const ids = new Set(current.map((element) => element.id))
				for (const element of created) {
					if (!element.id || ids.has(element.id)) {
						throw new CanvasOperationError('AI 创建了重复或无效的元素 ID。')
					}
					ids.add(element.id)
				}
				current = [...current, ...created]
				break
			}
			case 'update': {
				const index = findIndex(current, action.elementId)
				current[index] = adapter.update(current[index], action.updates)
				break
			}
			case 'move': {
				const index = findIndex(current, action.elementId)
				current[index] = adapter.update(current[index], { x: action.x, y: action.y })
				break
			}
			case 'delete': {
				const index = findIndex(current, action.elementId)
				current = current.filter((_, elementIndex) => elementIndex !== index)
				break
			}
			case 'clear':
				current = []
				break
			case 'layout': {
				assertExistingIds(current, action.elementIds)
				const laidOut = applyCanvasLayout(current, action)
				current =
					action.operation === 'sort'
						? laidOut
						: laidOut.map((element, index) =>
								element === current[index]
									? element
									: adapter.update(current[index], { x: element.x, y: element.y })
						  )
				break
			}
			case 'bind': {
				const arrow = current.find((element) => element.id === action.arrowId)
				if (!arrow || arrow.type !== 'arrow') throw new CanvasOperationError('AI 操作引用了无效的箭头。')
				for (const targetId of [action.startElementId, action.endElementId]) {
					if (targetId === undefined || targetId === null) continue
					const target = current.find((element) => element.id === targetId)
					if (!target || !isCanvasBindableElementType(target.type)) {
						throw new CanvasOperationError('AI 操作引用了无效的箭头绑定目标。')
					}
				}
				const bound = applyCanvasBinding(
					current as unknown as CanvasBindingElement[],
					action
				) as unknown as T[]
				current = bound.map((element, index) =>
					element === current[index] ? element : adapter.bump(element)
				)
				break
			}
			default:
				throw new CanvasOperationError('AI 返回了不支持的操作类型。')
		}
	}

	return current
}

export function undoCanvasOperation<T extends CanvasOperationElement>(
	elements: readonly T[],
	record: CanvasOperationRecord<T>
): T[] {
	if (record.status !== 'applied' || !record.after) return [...elements]

	const beforeById = new Map(record.before.map((element) => [element.id, element]))
	const afterById = new Map(record.after.map((element) => [element.id, element]))
	const currentById = new Map(elements.map((element) => [element.id, element]))
	const revertedIds = new Set<string>()
	for (const [id, after] of afterById) {
		const before = beforeById.get(id)
		const current = currentById.get(id)
		if (before && current && sameElement(current, after)) revertedIds.add(id)
	}
	const removableCreatedIds = new Set<string>()
	for (const [id, after] of afterById) {
		if (!beforeById.has(id) && sameElement(currentById.get(id), after)) removableCreatedIds.add(id)
	}

	let next = elements.map((element) => {
		const before = beforeById.get(element.id)
		return revertedIds.has(element.id) && before ? before : element
	})

	next = next.filter((element) => {
		return !removableCreatedIds.has(element.id)
	})

	const beforeCommonIds = record.before.filter((element) => afterById.has(element.id)).map((element) => element.id)
	const afterCommonIds = record.after.filter((element) => beforeById.has(element.id)).map((element) => element.id)
	if (beforeCommonIds.join('\u0000') !== afterCommonIds.join('\u0000')) {
		const orderedCommon = record.before
			.filter((before) => afterById.has(before.id) && currentById.has(before.id))
			.map((before) => before.id)
		let commonIndex = 0
		return next.map((element) => {
			if (!beforeById.has(element.id) || !afterById.has(element.id)) return element
			const before = beforeById.get(orderedCommon[commonIndex++])
			return before && revertedIds.has(before.id) ? before : element
		})
	}

	for (let index = 0; index < record.before.length; index += 1) {
		const before = record.before[index]
		if (afterById.has(before.id) || currentById.has(before.id)) continue
		next.splice(Math.min(index, next.length), 0, before)
	}

	return next
}

function findIndex<T extends CanvasOperationElement>(elements: readonly T[], id: string): number {
	const index = elements.findIndex((element) => element.id === id)
	if (index === -1) throw new CanvasOperationError(`AI 操作引用了不存在的元素：${id}`)
	return index
}

function assertExistingIds<T extends CanvasOperationElement>(elements: readonly T[], ids: readonly string[]) {
	const existingIds = new Set(elements.map((element) => element.id))
	if (ids.some((id) => !existingIds.has(id))) {
		throw new CanvasOperationError('AI 操作引用了不存在的元素。')
	}
}

function sameElement<T>(left: T, right: T): boolean {
	if (left === right) return true
	try {
		return JSON.stringify(left) === JSON.stringify(right)
	} catch {
		return false
	}
}
