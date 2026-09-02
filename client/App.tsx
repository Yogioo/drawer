import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
	AppState,
	BinaryFiles,
	ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import { FormEvent, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasAgentAction, CanvasElementSpec } from '../shared/canvas'
import { ChatEntry, createCanvasPrompt, streamCanvasAgent } from './agent'
import {
	CanvasOperationError,
	createCanvasOperationAdapter,
	executeCanvasOperation,
	undoCanvasOperation,
	type CanvasOperationRecord,
} from './canvas-operation'
import { createScenePersistence, readPersistedScene } from './persistence'

const STORAGE_KEY = 'drawer-excalidraw-scene'
const ExcalidrawCanvas = lazy(() =>
	import('@excalidraw/excalidraw').then(({ Excalidraw }) => ({ default: Excalidraw }))
)
type AiOperationRecord = CanvasOperationRecord<ExcalidrawElement>
const MAX_AI_OPERATION_HISTORY = 12

function App() {
	const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
	const [elements, setElements] = useState<ExcalidrawElement[]>([])
	const [appState, setAppState] = useState<AppState | null>(null)
	const [history, setHistory] = useState<ChatEntry[]>([])
	const [operations, setOperations] = useState<AiOperationRecord[]>([])
	const [pendingOperationId, setPendingOperationId] = useState<string | null>(null)
	const [isGenerating, setIsGenerating] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [status, setStatus] = useState('')
	const controllerRef = useRef<AbortController | null>(null)
	const operationCounterRef = useRef(0)
	const operationsRef = useRef<AiOperationRecord[]>([])
	const busyOperationIdsRef = useRef(new Set<string>())
	const lastRequestRef = useRef<string | null>(null)
	const [busyOperationIds, setBusyOperationIds] = useState<Set<string>>(new Set())

	const initialData = useMemo(() => {
		if (typeof window === 'undefined') return null
		try {
			const stored = readPersistedScene(window.localStorage, STORAGE_KEY)
			return stored ? { elements: stored.elements as ExcalidrawElement[] } : null
		} catch {
			return null
		}
	}, [])

	const scenePersistence = useMemo(() => {
		if (typeof window === 'undefined') return null
		return createScenePersistence(window.localStorage, STORAGE_KEY)
	}, [])

	useEffect(() => {
		if (!scenePersistence) return
		const flush = () => scenePersistence.flush()
		const flushWhenHidden = () => {
			if (document.visibilityState === 'hidden') flush()
		}
		window.addEventListener('beforeunload', flush)
		document.addEventListener('visibilitychange', flushWhenHidden)
		return () => {
			window.removeEventListener('beforeunload', flush)
			document.removeEventListener('visibilitychange', flushWhenHidden)
			scenePersistence.flush()
		}
	}, [scenePersistence])

	const handleChange = useCallback(
		(nextElements: readonly ExcalidrawElement[], nextAppState: AppState, _files: BinaryFiles) => {
			const nextScene = [...nextElements]
			scenePersistence?.schedule(nextScene)
			setElements(nextScene)
			setAppState(nextAppState)
		},
		[scenePersistence]
	)

	const updateOperationHistory = useCallback(
		(update: (current: AiOperationRecord[]) => AiOperationRecord[]) => {
			setOperations((current) => {
				const next = update(current)
				operationsRef.current = next
				return next
			})
		},
		[]
	)

	const beginOperation = useCallback((operationId: string): boolean => {
		if (busyOperationIdsRef.current.has(operationId)) return false
		busyOperationIdsRef.current.add(operationId)
		setBusyOperationIds((current) => new Set(current).add(operationId))
		return true
	}, [])

	const endOperation = useCallback((operationId: string) => {
		busyOperationIdsRef.current.delete(operationId)
		setBusyOperationIds((current) => {
			if (!current.has(operationId)) return current
			const next = new Set(current)
			next.delete(operationId)
			return next
		})
	}, [])

	const prepareOperation = useCallback(
		async (currentElements: readonly ExcalidrawElement[], actions: readonly CanvasAgentAction[]) => {
			const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
			const adapter = createCanvasOperationAdapter<ExcalidrawElement>({
				create: (specs) =>
					convertToExcalidrawElements(specs.map(toElementSkeleton) as never[], {
						regenerateIds: false,
					}) as ExcalidrawElement[],
				update: updateElement,
				bump: bumpElementVersion,
			})
			return executeCanvasOperation(currentElements, actions, adapter)
		},
		[]
	)

	const stageFailedOperation = useCallback(
		(actions: readonly CanvasAgentAction[], message: string) => {
			const before = api ? [...api.getSceneElements()] : [...elements]
			const record: AiOperationRecord = {
				id: `ai-${++operationCounterRef.current}`,
				status: 'failed',
				actions,
				request: lastRequestRef.current ?? undefined,
				before,
				error: message,
			}
			updateOperationHistory((current) => [record, ...current].slice(0, MAX_AI_OPERATION_HISTORY))
			setError(`AI 操作失败：${message}`)
			setStatus('')
		},
		[api, elements, updateOperationHistory]
	)

	const stageOperation = useCallback(
		async (actions: readonly CanvasAgentAction[]) => {
			if (actions.length === 0) return
			if (!api) {
				stageFailedOperation(actions, '画布尚未准备好，请重试。')
				return
			}
			try {
				let before = [...api.getSceneElements()]
				let after = await prepareOperation(before, actions)
				const latest = [...api.getSceneElements()]
				if (sceneChanged(before, latest)) {
					before = latest
					after = await prepareOperation(before, actions)
					if (sceneChanged(before, [...api.getSceneElements()])) {
						throw new CanvasOperationError('画布在生成预览时被修改，请重新请求 AI。')
					}
				}
				const record: AiOperationRecord = {
					id: `ai-${++operationCounterRef.current}`,
					status: 'pending',
					actions,
					request: lastRequestRef.current ?? undefined,
					before,
					after,
				}
				updateOperationHistory((current) => [record, ...current].slice(0, MAX_AI_OPERATION_HISTORY))
				setPendingOperationId(record.id)
				setError(null)
				setStatus('AI 修改已生成预览，请确认后应用。')
			} catch (reason) {
				const message = reason instanceof Error ? reason.message : '无法生成 AI 修改预览。'
				stageFailedOperation(actions, message)
			}
		},
		[api, prepareOperation, stageFailedOperation, updateOperationHistory]
	)

	const acceptOperation = useCallback(
		async (operationId: string) => {
			if (!api || !beginOperation(operationId)) return
			try {
				const { CaptureUpdateAction } = await import('@excalidraw/excalidraw')
				const record = operationsRef.current.find((item) => item.id === operationId)
				if (!record || record.status !== 'pending' || !record.after) return
				const before = [...api.getSceneElements()]
				if (sceneChanged(record.before, before)) {
					const after = await prepareOperation(before, record.actions)
					if (sceneChanged(before, [...api.getSceneElements()])) {
						throw new CanvasOperationError('画布在更新预览时被修改，请重新请求 AI。')
					}
					updateOperationHistory((current) =>
						current.map((item) =>
							item.id === operationId
								? { ...item, before, after, error: undefined }
								: item
						)
					)
					setError(null)
					setStatus('画布已改变，AI 预览已更新，请再次确认。')
					return
				}
				const after = record.after
				if (sceneChanged(before, after)) {
					api.updateScene({ elements: after, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
				}
				updateOperationHistory((current) =>
					current.map((item) =>
						item.id === operationId
							? { ...item, status: 'applied', before, after, error: undefined }
							: item
					)
				)
				setPendingOperationId(null)
				setError(null)
				setStatus('AI 修改已接受。')
			} catch (reason) {
				const message = reason instanceof Error ? reason.message : '无法应用 AI 修改。'
				const before = [...api.getSceneElements()]
				updateOperationHistory((current) =>
					current.map((item) => (item.id === operationId ? { ...item, status: 'failed', before, error: message } : item))
				)
				setPendingOperationId(null)
				setError(`AI 操作失败，画布未改变：${message}`)
				setStatus('')
			} finally {
				endOperation(operationId)
			}
		},
		[api, beginOperation, endOperation, prepareOperation, updateOperationHistory]
	)

	const rejectOperation = useCallback(
		(operationId: string) => {
			if (busyOperationIdsRef.current.has(operationId)) return
			updateOperationHistory((current) =>
				current.map((item) => (item.id === operationId ? { ...item, status: 'rejected' } : item))
			)
			if (pendingOperationId === operationId) setPendingOperationId(null)
			setStatus('已拒绝 AI 修改，画布未改变。')
		},
		[pendingOperationId, updateOperationHistory]
	)

	const undoOperation = useCallback(
		async (operationId: string) => {
			if (!api || !beginOperation(operationId)) return
			try {
				const { CaptureUpdateAction } = await import('@excalidraw/excalidraw')
				const record = operationsRef.current.find((item) => item.id === operationId)
				if (!record || record.status !== 'applied' || !record.after) return
				const current = [...api.getSceneElements()]
				const next = undoCanvasOperation(current, record)
				if (sceneChanged(current, [...api.getSceneElements()])) {
					throw new CanvasOperationError('画布在撤销前已被修改，请重试。')
				}
				if (sceneChanged(current, next)) {
					api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
				}
				updateOperationHistory((items) =>
					items.map((item) => (item.id === operationId ? { ...item, status: 'undone' } : item))
				)
				setStatus('已撤销 AI 修改，保留之后的正常编辑。')
			} catch (reason) {
				const message = reason instanceof Error ? reason.message : '无法撤销 AI 修改。'
				setError(`撤销失败：${message}`)
			} finally {
				endOperation(operationId)
			}
		},
		[api, beginOperation, endOperation, updateOperationHistory]
	)

	const handleSubmit = useCallback(
		async (message: string) => {
			if (!message.trim() || !appState || isGenerating || pendingOperationId) return
			setError(null)
			setStatus('AI 正在处理...')
			setIsGenerating(true)
			lastRequestRef.current = message
			const nextHistory = [...history, { role: 'user' as const, content: message }]
			setHistory(nextHistory)
			const controller = new AbortController()
			controllerRef.current = controller
			const actions: CanvasAgentAction[] = []
			const messages: string[] = []

			try {
				const prompt = createCanvasPrompt(message, elements, appState, nextHistory, api?.getFiles())
				await streamCanvasAgent(prompt, controller.signal, async (action) => {
					if (action._type === 'message') {
						messages.push(action.text)
						return
					}
					actions.push(action)
				})
				if (messages.length > 0) {
					setHistory((current) => [
						...current,
						...messages.map((content) => ({
							role: 'assistant' as const,
							content: actions.length > 0 ? `预览：${content}` : content,
						})),
					])
				}
				await stageOperation(actions)
				if (actions.length === 0) setStatus('')
			} catch (reason) {
				if (controller.signal.aborted) return
				const failure = reason instanceof Error ? reason.message : 'AI 请求失败。'
				stageFailedOperation(actions, failure)
				setHistory((current) => [...current, { role: 'assistant', content: `请求失败：${failure}` }])
				setStatus('')
			} finally {
				controllerRef.current = null
				setIsGenerating(false)
			}
		},
		[appState, elements, history, isGenerating, pendingOperationId, stageFailedOperation, stageOperation]
	)

	const handleRetryRequest = useCallback((request?: string) => {
		const message = request ?? lastRequestRef.current
		if (message && !isGenerating && !pendingOperationId) void handleSubmit(message)
	}, [handleSubmit, isGenerating, pendingOperationId])

	const handleCancel = useCallback(() => {
		controllerRef.current?.abort()
		setStatus('已取消')
	}, [])

	const handleReset = useCallback(() => {
		setHistory([])
		setError(null)
		setStatus('')
		updateOperationHistory((current) =>
			current.map((item) => (item.status === 'pending' ? { ...item, status: 'rejected' } : item))
		)
		setPendingOperationId(null)
	}, [updateOperationHistory])

	return (
		<div className="app-shell">
			<main className="canvas-shell">
				<Suspense fallback={<div className="canvas-loading" aria-hidden="true" />}>
					<ExcalidrawCanvas
						initialData={initialData}
						excalidrawAPI={setApi}
						onChange={handleChange}
						langCode="zh-CN"
					/>
				</Suspense>
			</main>
			<aside className="agent-panel">
				<header className="agent-header">
					<div>
						<span className="agent-kicker">DRAWER</span>
						<h1>AI 画布</h1>
					</div>
					<button className="icon-button" onClick={handleReset} title="新对话" aria-label="新对话">
						+
					</button>
				</header>
				<div className="conversation" aria-live="polite">
					{history.length === 0 && <div className="empty-state">输入一句话，让 AI 帮你画图。</div>}
					{history.map((entry, index) => (
						<div className={`message message-${entry.role}`} key={`${entry.role}-${index}`}>
							{entry.content}
						</div>
					))}
					{isGenerating && <div className="message message-assistant typing">正在处理...</div>}
				</div>
				{operations.length > 0 && (
					<section className="operation-history" aria-label="AI 操作历史" data-testid="ai-operation-history">
						<div className="operation-history-header">
							<span>AI 操作</span>
							<span>{operations.length}</span>
						</div>
						<div className="operation-list">
							{operations.map((operation) => (
								<article
									className={`operation-item operation-${operation.status}`}
									data-operation-status={operation.status}
									key={operation.id}
								>
									<div className="operation-item-header">
										<strong>{operationTitle(operation.actions)}</strong>
										<span>{operationStatus(operation.status)}</span>
									</div>
									{operation.status === 'pending' && operation.after && (
										<div className="operation-preview" data-testid="ai-operation-preview">
											预览：{operation.before.length} → {operation.after.length} 个元素
										</div>
									)}
									{operation.error && <div className="operation-error">{operation.error}</div>}
									<div className="operation-actions">
										{operation.status === 'pending' && (
											<>
								<button
									className="operation-button operation-accept"
									data-testid="ai-operation-accept"
									type="button"
									onClick={() => void acceptOperation(operation.id)}
									disabled={busyOperationIds.has(operation.id)}
									title="接受 AI 修改"
												>
													✓ 接受
												</button>
								<button
									className="operation-button operation-reject"
									data-testid="ai-operation-reject"
									type="button"
									onClick={() => rejectOperation(operation.id)}
									disabled={busyOperationIds.has(operation.id)}
									title="拒绝 AI 修改"
												>
													× 拒绝
												</button>
											</>
										)}
										{operation.status === 'applied' && (
									<button
										className="operation-button operation-undo"
										data-testid="ai-operation-undo"
										type="button"
										onClick={() => void undoOperation(operation.id)}
										disabled={busyOperationIds.has(operation.id)}
										title="撤销 AI 修改"
											>
												↶ 撤销
											</button>
										)}
										{operation.status === 'failed' && (
											<button
												className="operation-button operation-retry"
												type="button"
												onClick={() => handleRetryRequest(operation.request)}
												disabled={isGenerating || !!pendingOperationId}
												title="重新请求 AI"
											>
												↻ 重新请求
											</button>
										)}
									</div>
								</article>
							))}
						</div>
					</section>
				)}
				{(error || status) && <div className={`agent-status ${error ? 'is-error' : ''}`}>{error || status}</div>}
				<form
					className="composer"
					onSubmit={(event: FormEvent<HTMLFormElement>) => {
						event.preventDefault()
						const form = event.currentTarget
						const input = form.elements.namedItem('message') as HTMLTextAreaElement
						const message = input.value.trim()
						if (isGenerating) {
							handleCancel()
						} else if (message) {
							handleSubmit(message)
							input.value = ''
						}
					}}
				>
					<textarea
						name="message"
						placeholder="让 AI 创建或修改画布..."
						rows={3}
						disabled={!appState || isGenerating || !!pendingOperationId}
					/>
					<div className="composer-footer">
						<span>{elements.filter((element) => !element.isDeleted).length} 个元素</span>
						<button className="send-button" type="submit" disabled={!appState || !!pendingOperationId}>
							{isGenerating ? '停止' : '发送'}
						</button>
					</div>
				</form>
			</aside>
		</div>
	)
}

function sceneChanged<T>(before: readonly T[], after: readonly T[]): boolean {
	return before.length !== after.length || before.some((element, index) => element !== after[index])
}

function operationTitle(actions: readonly CanvasAgentAction[]): string {
	const labels = actions.map((action) => {
		switch (action._type) {
			case 'create':
				return `创建 ${action.elements.length} 个元素`
			case 'update':
				return '更新元素'
			case 'move':
				return '移动元素'
			case 'delete':
				return '删除元素'
			case 'clear':
				return '清空画布'
			case 'layout':
				return '整理布局'
			case 'bind':
				return '更新箭头绑定'
			case 'message':
				return ''
		}
	})
	const visible = labels.filter(Boolean)
	return visible.length > 1 ? `${visible[0]}等 ${visible.length} 项` : visible[0] || '画布修改'
}

function operationStatus(status: AiOperationRecord['status']): string {
	switch (status) {
		case 'pending':
			return '待确认'
		case 'applied':
			return '已接受'
		case 'rejected':
			return '已拒绝'
		case 'failed':
			return '失败'
		case 'undone':
			return '已撤销'
	}
}

function toElementSkeleton(spec: CanvasElementSpec): Record<string, unknown> {
	const skeleton: Record<string, unknown> = {
		type: spec.type === 'freedraw' ? 'line' : spec.type,
		x: spec.x,
		y: spec.y,
		width: spec.width ?? 200,
		height: spec.height ?? 120,
		strokeColor: spec.strokeColor ?? '#1f2937',
		backgroundColor: spec.backgroundColor ?? 'transparent',
		strokeWidth: spec.strokeWidth ?? 2,
		strokeStyle: spec.strokeStyle ?? 'solid',
		roughness: spec.roughness ?? 1,
	}
	if (spec.id) skeleton.id = spec.id
	if (spec.text && spec.type !== 'text') {
		skeleton.label = { text: spec.text }
	}
	if (spec.type === 'text') {
		skeleton.text = spec.text ?? ''
		skeleton.fontSize = 24
		skeleton.fontFamily = 1
	}
	if (spec.type === 'arrow' || spec.type === 'line' || spec.type === 'freedraw') {
		skeleton.points = (spec.points?.length ? spec.points : [{ x: 0, y: 0 }, { x: 160, y: 0 }]).map(
			(point) => [point.x, point.y]
		)
		if (spec.type === 'arrow') skeleton.endArrowhead = 'arrow'
	}
	return skeleton
}

function updateElement(element: ExcalidrawElement, updates: Partial<CanvasElementSpec>): ExcalidrawElement {
	const next: Record<string, unknown> = { ...element }
	for (const key of [
		'x',
		'y',
		'width',
		'height',
		'text',
		'strokeColor',
		'backgroundColor',
		'strokeWidth',
		'strokeStyle',
		'roughness',
	] as const) {
		if (updates[key] !== undefined) next[key] = updates[key]
	}
	if (updates.points && 'points' in element) {
		next.points = updates.points.map((point) => [point.x, point.y])
	}
	next.version = element.version + 1
	next.versionNonce = Math.floor(Math.random() * 2 ** 31)
	return next as ExcalidrawElement
}

function bumpElementVersion(element: ExcalidrawElement): ExcalidrawElement {
	return {
		...element,
		version: element.version + 1,
		versionNonce: Math.floor(Math.random() * 2 ** 31),
	} as ExcalidrawElement
}

export default App
