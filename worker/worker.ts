import { WorkerEntrypoint } from 'cloudflare:workers'
import { Environment } from './environment'
import { stream } from './routes/stream'

export default class extends WorkerEntrypoint<Environment> {
	override fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (request.method === 'OPTIONS') {
			return Promise.resolve(
				new Response(null, {
					status: 204,
					headers: corsHeaders(),
				})
			)
		}
		if (request.method === 'POST' && url.pathname === '/stream') {
			return stream(request, this.env)
		}
		return Promise.resolve(new Response('Not found', { status: 404 }))
	}
}

function corsHeaders(): HeadersInit {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	}
}
