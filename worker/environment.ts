export interface Environment {
	OPENAI_API_KEY?: string
	OPENAI_BASE_URL?: string
	OPENAI_MODEL?: string
	ALLOWED_ORIGINS?: string
	CORS_ORIGINS?: string
	AI_UPSTREAM_TIMEOUT_MS?: string
	AI_UPSTREAM_MAX_RETRIES?: string
	AI_UPSTREAM_RETRY_DELAY_MS?: string
}
