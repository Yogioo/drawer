import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
	AppState,
	BinaryFiles,
	ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import { FormEvent, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasAgentAction, CanvasElementSpec } from '../shared/canvas'
import { ChatEntry, createCanvasPrompt, streamCanvasAgent } from './agent'
import { createScenePersistence, readPersistedScene } from './persistence'

const STORAGE_KEY = 'drawer-excalidraw-scene'
const ExcalidrawCanvas = lazy(() =>
	import('@excalidraw/excalidraw').then(({ Excalidraw }) => ({ default: Excalidraw }))
)

function App() {
	const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
	const [elements, setElements] = useState<ExcalidrawElement[]>([])
	const [appState, setAppState] = useState<AppState | null>(null)
	const [history, setHistory] = useState<ChatEntry[]>([])
	const [isGenerating, setIsGenerating] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [status, setStatus] = useState('')
	const controllerRef = useRef<AbortController | null>(null)

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

	const handleAction = useCallback(
		async (action: CanvasAgentAction) => {
			if (!api) return
			if (action._type === 'message') {
				setHistory((current) => [...current, { role: 'assistant', content: action.text }])
				return
			}

			const currentElements = [...api.getSceneElements()]
			switch (action._type) {
				case 'create': {
					const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
					const skeletons = action.elements.map(toElementSkeleton)
					const created = convertToExcalidrawElements(skeletons as never[], {
						regenerateIds: false,
					})
					api.updateScene({ elements: [...currentElements, ...created] })
					setStatus(action.intent || `已创建 ${created.length} 个元素`)
					break
				}
				case 'update': {
					const updated = currentElements.map((element) =>
						element.id === action.elementId
							? updateElement(element, action.updates)
							: element
					)
					api.updateScene({ elements: updated })
					setStatus(action.intent || '已更新元素')
					break
				}
				case 'move': {
					const updated = currentElements.map((element) =>
						element.id === action.elementId
							? updateElement(element, { x: action.x, y: action.y })
							: element
					)
					api.updateScene({ elements: updated })
					setStatus(action.intent || '已移动元素')
					break
				}
				case 'delete':
					api.updateScene({
						elements: currentElements.filter((element) => element.id !== action.elementId),
					})
					setStatus(action.intent || '已删除元素')
					break
				case 'clear':
					api.updateScene({ elements: [] })
					setStatus(action.intent || '已清空画布')
					break
			}
		},
		[api]
	)

	const handleSubmit = useCallback(
		async (message: string) => {
			if (!message.trim() || !appState || isGenerating) return
			setError(null)
			setStatus('AI 正在处理...')
			setIsGenerating(true)
			const nextHistory = [...history, { role: 'user' as const, content: message }]
			setHistory(nextHistory)
			const controller = new AbortController()
			controllerRef.current = controller

			try {
				const prompt = createCanvasPrompt(message, elements, appState, nextHistory)
				await streamCanvasAgent(prompt, controller.signal, handleAction)
				setStatus('')
			} catch (reason) {
				if (controller.signal.aborted) return
				const message = reason instanceof Error ? reason.message : 'AI 请求失败。'
				setError(message)
				setHistory((current) => [...current, { role: 'assistant', content: `请求失败：${message}` }])
				setStatus('')
			} finally {
				controllerRef.current = null
				setIsGenerating(false)
			}
		},
		[appState, elements, handleAction, history, isGenerating]
	)

	const handleCancel = useCallback(() => {
		controllerRef.current?.abort()
		setStatus('已取消')
	}, [])

	const handleReset = useCallback(() => {
		setHistory([])
		setError(null)
		setStatus('')
	}, [])

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
					<textarea name="message" placeholder="让 AI 创建或修改画布..." rows={3} disabled={!appState} />
					<div className="composer-footer">
						<span>{elements.filter((element) => !element.isDeleted).length} 个元素</span>
						<button className="send-button" type="submit" disabled={!appState}>
							{isGenerating ? '停止' : '发送'}
						</button>
					</div>
				</form>
			</aside>
		</div>
	)
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

export default App
