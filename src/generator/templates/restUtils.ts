export interface RestClientConfig {
	baseUrl: string
	headers?: Record<string, string>
}

export type RestRequestInit = Omit<RequestInit, "headers"> & {
	headers?: Record<string, string>
}

const toBase64 = (value: Uint8Array) =>
	typeof Buffer !== "undefined"
		? Buffer.from(value).toString("base64")
		: btoa(String.fromCharCode(...value))

const jsonReplacer = (_: string, value: unknown) => {
	if (typeof value === "bigint") return value.toString()
	if (value instanceof Uint8Array) return toBase64(value)
	return value
}

const toCamelCaseKey = (key: string) =>
	key.replace(/[_-](\w)/g, (_, c: string) => c.toUpperCase())

const camelCaseKeys = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(camelCaseKeys)
	}
	if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
		const entries = Object.entries(value as Record<string, unknown>).map(
			([k, v]) => [toCamelCaseKey(k), camelCaseKeys(v)]
		)
		return Object.fromEntries(entries)
	}
	return value
}

export const formatQueryValue = (value: unknown): string => {
	if (value === undefined || value === null) return ""
	if (value instanceof Uint8Array) return toBase64(value)
	if (typeof value === "bigint") return value.toString()
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return String(value)
	}
	return JSON.stringify(value, jsonReplacer)
}

export const appendSearchParams = (
	url: URL,
	params: object,
	skip: Set<string>
) => {
	for (const [key, value] of Object.entries(
		params as Record<string, unknown>
	)) {
		if (value === undefined || value === null) continue
		if (skip.has(key)) continue
		url.searchParams.append(key, formatQueryValue(value))
	}
}

export const stringifyJson = (value: unknown) =>
	JSON.stringify(value, jsonReplacer)

const mergeHeaders = (headers?: Record<string, string>) => ({
	Accept: "application/json",
	"Content-Type": "application/json",
	...(headers ?? {})
})

export async function fetchRest<T>(
	url: string,
	options: RestRequestInit = {}
): Promise<T> {
	const response = await fetch(url, {
		...options,
		headers: mergeHeaders(options.headers)
	})

	const text = await response.text()

	if (!response.ok) {
		let error: unknown = text || response.statusText
		try {
			error = text ? JSON.parse(text) : error
		} catch (_) {
			// keep text fallback
		}
		throw error
	}

	if (!text) {
		return {} as T
	}

	const parsed = JSON.parse(text) as unknown
	return camelCaseKeys(parsed) as T
}
