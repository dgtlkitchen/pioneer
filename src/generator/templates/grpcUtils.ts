import type { Interceptor } from "@connectrpc/connect"

export type RetryConfig = {
	maxAttempts?: number
	initialDelay?: number
	maxDelay?: number
	backoffMultiplier?: number
	retryableErrors?: (error: Error) => boolean
}

export type GrpcClientConfig = {
	baseUrl: string
	retry?: RetryConfig
	interceptors?: Interceptor[]
}

class BaseError extends Error {
	context?: unknown
	constructor(name: string, message: string, context?: unknown) {
		super(message)
		this.name = name
		this.context = context
	}
}

export class ConfigurationError extends BaseError {
	constructor(message: string, context?: unknown) {
		super("ConfigurationError", message, context)
	}
}

export class NetworkError extends BaseError {
	url?: string
	method?: string
	statusCode?: number

	constructor(
		message: string,
		details?: {
			url?: string
			method?: string
			statusCode?: number
			originalError?: unknown
		}
	) {
		super("NetworkError", message, details)
		this.url = details?.url
		this.method = details?.method
		this.statusCode = details?.statusCode
	}
}

export class GrpcError extends BaseError {
	grpcCode: number
	grpcStatus: string
	metadata?: Record<string, unknown>

	constructor(
		message: string,
		grpcCode: number,
		grpcStatus: string,
		details?: { metadata?: Record<string, unknown>; originalError?: unknown }
	) {
		super("GrpcError", message, details)
		this.grpcCode = grpcCode
		this.grpcStatus = grpcStatus
		this.metadata = details?.metadata
	}

	static fromConnectError(error: unknown): GrpcError {
		const isRecord = (value: unknown): value is Record<string, unknown> =>
			typeof value === "object" && value !== null && !Array.isArray(value)

		const codeMap: Record<string, { code: number; status: string }> = {
			canceled: { code: 1, status: "CANCELLED" },
			unknown: { code: 2, status: "UNKNOWN" },
			invalid_argument: { code: 3, status: "INVALID_ARGUMENT" },
			deadline_exceeded: { code: 4, status: "DEADLINE_EXCEEDED" },
			not_found: { code: 5, status: "NOT_FOUND" },
			already_exists: { code: 6, status: "ALREADY_EXISTS" },
			permission_denied: { code: 7, status: "PERMISSION_DENIED" },
			resource_exhausted: { code: 8, status: "RESOURCE_EXHAUSTED" },
			failed_precondition: { code: 9, status: "FAILED_PRECONDITION" },
			aborted: { code: 10, status: "ABORTED" },
			out_of_range: { code: 11, status: "OUT_OF_RANGE" },
			unimplemented: { code: 12, status: "UNIMPLEMENTED" },
			internal: { code: 13, status: "INTERNAL" },
			unavailable: { code: 14, status: "UNAVAILABLE" },
			data_loss: { code: 15, status: "DATA_LOSS" },
			unauthenticated: { code: 16, status: "UNAUTHENTICATED" }
		}

		const connectCode =
			isRecord(error) && typeof error.code === "string" ? error.code : "unknown"
		const info = codeMap[connectCode] || { code: 2, status: "UNKNOWN" }
		const message =
			error instanceof Error
				? error.message
				: isRecord(error) && typeof error.message === "string"
					? error.message
					: "Unknown gRPC error"
		const metadata =
			isRecord(error) && isRecord(error.metadata)
				? (error.metadata as Record<string, unknown>)
				: undefined
		return new GrpcError(message, info.code, info.status, {
			metadata,
			originalError: error
		})
	}
}

export const ErrorUtils = {
	fromUnknown(error: unknown, context?: string): Error {
		if (error instanceof Error) return error
		if (typeof error === "string") {
			return new Error(context ? `${context}: ${error}` : error)
		}
		try {
			return new Error(
				context ? `${context}: ${JSON.stringify(error)}` : JSON.stringify(error)
			)
		} catch {
			return new Error(context ? `${context}: Unknown error` : "Unknown error")
		}
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function withRetry<T>(
	fn: () => Promise<T>,
	config: RetryConfig = {}
): Promise<T> {
	const {
		maxAttempts = 3,
		initialDelay = 1000,
		maxDelay = 10000,
		backoffMultiplier = 2,
		retryableErrors = (error: Error) => error instanceof NetworkError
	} = config

	let delay = initialDelay
	let lastError: Error | undefined

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn()
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			lastError = error

			if (attempt === maxAttempts || !retryableErrors(error)) {
				throw error
			}

			await sleep(delay)
			delay = Math.min(delay * backoffMultiplier, maxDelay)
		}
	}

	throw lastError ?? new Error("Retry failed")
}
