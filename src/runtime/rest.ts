import {
	create,
	type DescMessage,
	type DescMethodUnary,
	fromJsonString,
	type JsonValue,
	type MessageInitShape,
	type MessageShape,
	type Registry,
	toJson
} from "@bufbuild/protobuf"

export type Fetch = (
	input: RequestInfo | URL,
	init?: RequestInit
) => Promise<Response>
export type RestClientConfig = {
	baseUrl: string
	registry?: Registry
	headers?: HeadersInit
	fetch?: Fetch
	timeoutMs?: number
	maxResponseBytes?: number
}
export type CallOptions = { signal?: AbortSignal }
export type HttpBinding = { method: string; path: string; body: string }

export class HttpError extends Error {
	constructor(readonly status: number) {
		super(`Chain HTTP request failed (${status})`)
		this.name = "HttpError"
	}
}

export async function readResponse(
	response: Response,
	maximum: number
): Promise<string> {
	if (!response.ok) {
		await response.body?.cancel()
		throw new HttpError(response.status)
	}
	const reader = response.body?.getReader()
	if (!reader) throw new Error("Chain returned no response body")
	const decoder = new TextDecoder("utf-8", { fatal: true })
	let size = 0
	let text = ""
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.length
			if (size > maximum)
				throw new Error("Chain response exceeds configured size limit")
			text += decoder.decode(value, { stream: true })
		}
		return text + decoder.decode()
	} finally {
		await reader.cancel()
		reader.releaseLock()
	}
}

function field(value: JsonValue, path: string): JsonValue | undefined {
	let current: JsonValue | undefined = value
	for (const part of path.split(".")) {
		if (
			!current ||
			typeof current !== "object" ||
			Array.isArray(current) ||
			!Object.hasOwn(current, part)
		)
			return undefined
		current = current[part]
	}
	return current
}

export function appendSearchParams(
	url: URL,
	value: JsonValue,
	excluded: ReadonlySet<string>,
	prefix = ""
) {
	if (excluded.has(prefix) || value === null) return
	if (Array.isArray(value)) {
		for (const item of value) appendSearchParams(url, item, excluded, prefix)
	} else if (typeof value === "object") {
		for (const [key, item] of Object.entries(value))
			appendSearchParams(url, item, excluded, prefix ? `${prefix}.${key}` : key)
	} else {
		url.searchParams.append(prefix, String(value))
	}
}

export function bindRest<I extends DescMessage, O extends DescMessage>(
	config: RestClientConfig,
	method: DescMethodUnary<I, O>,
	binding: HttpBinding
) {
	const base = new URL(config.baseUrl)
	if (
		!["https:", "http:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		throw new Error("Invalid chain REST base URL")
	const timeout = config.timeoutMs ?? 15_000
	const maximum = config.maxResponseBytes ?? 4 * 1024 * 1024
	if (
		!Number.isSafeInteger(timeout) ||
		timeout <= 0 ||
		!Number.isSafeInteger(maximum) ||
		maximum <= 0
	)
		throw new Error("Request limits must be positive safe integers")
	return async (
		request: MessageInitShape<I>,
		options: CallOptions = {}
	): Promise<MessageShape<O>> => {
		const message = create(method.input, request)
		const json = toJson(method.input, message, {
			registry: config.registry,
			useProtoFieldName: true
		})
		const pathJson = toJson(method.input, message, {
			registry: config.registry,
			useProtoFieldName: true,
			alwaysEmitImplicit: true
		})
		const excluded = new Set<string>()
		const path = binding.path.replace(
			/\{([^}]+)\}/g,
			(_, expression: string) => {
				const [name, template] = expression.split("=")
				const value = field(pathJson, name)
				if (value === undefined || value === null || typeof value === "object")
					throw new Error(`Missing path field: ${name}`)
				excluded.add(name)
				const text = String(value)
				if (!text || text === "." || text === "..")
					throw new Error("Empty or dot segments are not valid path parameters")
				if (!template || template === "*") return encodeURIComponent(text)
				const parts = text.split("/")
				const pattern = template.split("/")
				if (pattern.at(-1) !== "**" && parts.length !== pattern.length)
					throw new Error(`Path field does not match template: ${name}`)
				for (let i = 0; i < pattern.length; i++) {
					if (pattern[i] === "**") break
					if (!parts[i] || (pattern[i] !== "*" && pattern[i] !== parts[i]))
						throw new Error(`Path field does not match template: ${name}`)
				}
				if (parts.some((part) => part === "." || part === ".."))
					throw new Error("Invalid path segment")
				return parts.map(encodeURIComponent).join("/")
			}
		)
		const url = new URL(`${base.href.replace(/\/$/, "")}${path}`)
		let body: string | undefined
		if (binding.body === "*") body = JSON.stringify(json)
		else {
			if (binding.body) {
				excluded.add(binding.body)
				body = JSON.stringify(field(json, binding.body))
			}
			appendSearchParams(url, json, excluded)
		}
		const headers = new Headers(config.headers)
		headers.set("Accept", "application/json")
		if (body !== undefined) headers.set("Content-Type", "application/json")
		const signal = AbortSignal.any([
			AbortSignal.timeout(timeout),
			...(options.signal ? [options.signal] : [])
		])
		const response = await (config.fetch ?? fetch)(url, {
			method: binding.method,
			headers,
			body,
			signal,
			credentials: "omit",
			redirect: "error"
		})
		return fromJsonString(
			method.output,
			await readResponse(response, maximum),
			{ registry: config.registry }
		)
	}
}
