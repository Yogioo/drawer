import { CanvasAgentAction, CanvasPrompt } from '../../shared/canvas'
import { Environment } from '../environment'
import { AgentService } from '../agent/AgentService'

export async function stream(request: Request, env: Environment): Promise<Response> {
	const encoder = new TextEncoder()
	const readable = new ReadableStream({
		async start(controller) {
			const send = (data: CanvasAgentAction | { error: string }) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
			}

			try {
				const service = new AgentService(env)
				const prompt = (await request.json()) as CanvasPrompt
				for (const action of await service.getActions(prompt)) {
					send(action)
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : 'AI 请求失败。'
				send({ error: message })
			} finally {
				controller.close()
			}
		},
	})

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
			'Transfer-Encoding': 'chunked',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		},
	})
}
