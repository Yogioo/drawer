import { WorkerEntrypoint } from 'cloudflare:workers'
import { handleWorkerRequest } from './handler'
import type { Environment } from './environment'

export default class extends WorkerEntrypoint<Environment> {
	override fetch(request: Request): Promise<Response> {
		return handleWorkerRequest(request, this.env)
	}
}
