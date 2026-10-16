import {
	create,
	type DescMessage,
	type DescMethodUnary,
	fromBinary,
	type MessageInitShape,
	type MessageShape,
	toBinary
} from "@bufbuild/protobuf"
import { base64 } from "@scure/base"
import {
	type CallOptions,
	type RestClientConfig,
	readResponse
} from "./rest.js"

export function rpcRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class JsonRpcError extends Error {
	constructor(
		readonly code: number,
		readonly data: unknown
	) {
		super(`Chain JSON-RPC request failed (${code})`)
		this.name = "JsonRpcError"
	}
}

export class AbciQueryError extends Error {
	readonly code: number
	readonly codespace: string
	readonly log: string

	constructor(
		readonly path: string,
		fields: {
			readonly code: number
			readonly codespace: string
			readonly log: string
		},
		options?: ErrorOptions
	) {
		super(
			`Chain ABCI query failed at ${path} (${fields.codespace}/${fields.code}): ${fields.log}`,
			options
		)
		this.name = "AbciQueryError"
		this.code = fields.code
		this.codespace = fields.codespace
		this.log = fields.log
	}
}

export function createRpcRequest(config: RestClientConfig) {
	const url = new URL(config.baseUrl)
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("Invalid chain RPC base URL")
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
		method: string,
		params: Record<string, unknown>,
		options: CallOptions = {}
	): Promise<unknown> => {
		const signal = AbortSignal.any([
			AbortSignal.timeout(timeout),
			...(options.signal ? [options.signal] : [])
		])
		const headers = new Headers(config.headers)
		headers.set("Content-Type", "application/json")
		const response = await (config.fetch ?? fetch)(url, {
			method: "POST",
			headers,
			signal,
			credentials: "omit",
			redirect: "error",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
		})
		const json: unknown = JSON.parse(await readResponse(response, maximum))
		if (!rpcRecord(json) || json.jsonrpc !== "2.0" || json.id !== 1)
			throw new Error("Malformed JSON-RPC response")
		if (json.error !== undefined) {
			if (!rpcRecord(json.error) || !Number.isSafeInteger(json.error.code))
				throw new Error("Malformed JSON-RPC error")
			throw new JsonRpcError(Number(json.error.code), json.error.data)
		}
		if (!("result" in json)) throw new Error("Missing JSON-RPC result")
		return json.result
	}
}

export function bindRpc<I extends DescMessage, O extends DescMessage>(
	config: RestClientConfig,
	method: DescMethodUnary<I, O>
) {
	const request = createRpcRequest(config)
	return async (
		input: MessageInitShape<I>,
		options: CallOptions = {}
	): Promise<MessageShape<O>> => {
		const bytes = toBinary(method.input, create(method.input, input))
		const hex = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0")
		).join("")
		const path = `/${method.parent.typeName}/${method.name}`
		const result = await request("abci_query", { path, data: hex }, options)
		if (!rpcRecord(result) || !rpcRecord(result.response))
			throw new Error(`Missing ABCI response at ${path}`)
		const abci = result.response
		const code = "code" in abci ? abci.code : 0
		if (
			typeof code !== "number" ||
			!Number.isInteger(code) ||
			code < 0 ||
			code > 0xffffffff
		)
			throw new Error(`Invalid ABCI code at ${path}`)
		for (const field of ["codespace", "log"]) {
			if ((code !== 0 || field in abci) && typeof abci[field] !== "string")
				throw new Error(`Invalid ABCI ${field} at ${path}`)
		}
		if (code !== 0) {
			const { codespace, log } = abci
			if (typeof codespace !== "string" || typeof log !== "string")
				throw new Error(`Invalid ABCI error fields at ${path}`)
			throw new AbciQueryError(path, { code, codespace, log })
		}
		if (abci.value !== null && typeof abci.value !== "string")
			throw new Error(`Invalid ABCI value at ${path}`)
		try {
			return fromBinary(method.output, base64.decode(abci.value ?? ""))
		} catch (cause) {
			throw new Error(`Invalid ABCI value at ${path}`, { cause })
		}
	}
}
