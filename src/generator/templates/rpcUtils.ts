import {
	type DescMessage,
	type MessageShape,
	toBinary
} from "@bufbuild/protobuf"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { base64 } from "@scure/base"

export type RpcClientConfig = {
	endpoint: string
	headers?: Record<string, string>
	broadcastMode?: "sync" | "async"
}

export type RpcCallOptions = {
	height?: number
	prove?: boolean
}

type UnaryRequest<
	TRequest extends DescMessage,
	TResponse extends DescMessage
> = {
	service: string
	method: string
	requestSchema: TRequest
	responseSchema: TResponse
	request: MessageShape<TRequest>
	height?: number
	prove?: boolean
}

export type TendermintRpcTransport = {
	abciQuery<TReq extends DescMessage, TRes extends DescMessage>(
		req: UnaryRequest<TReq, TRes>
	): Promise<Uint8Array>
	broadcastTxRaw(
		tx: Uint8Array,
		mode?: "sync" | "async" | number
	): Promise<{
		code: number
		hash: string
		log?: string
		data?: string
		height?: number
		codespace?: string
	}>
}

type TransportConfig = {
	endpoint: string
	headers: Record<string, string>
	broadcastMode: "sync" | "async"
}

const normalizeConfig = (config: RpcClientConfig): TransportConfig => {
	if (!config.endpoint) {
		throw new Error("endpoint is required for Tendermint RPC clients")
	}
	return {
		endpoint: config.endpoint.replace(/\/+$/, ""),
		headers: config.headers ?? {},
		broadcastMode: config.broadcastMode ?? "sync"
	}
}

const callJsonRpc = async (
	config: TransportConfig,
	method: string,
	params?: Record<string, unknown>
) => {
	const res = await fetch(config.endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...config.headers },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 0,
			method,
			params
		})
	})

	const text = await res.text()
	const json = text ? JSON.parse(text) : {}
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		throw new Error("Invalid JSON-RPC response")
	}

	return json as Record<string, unknown>
}

const decodeAbciValue = (value?: string): Uint8Array => {
	if (!value) {
		throw new Error("ABCI query returned empty value")
	}
	const clean = value.trim()
	if (!clean) {
		throw new Error("ABCI query returned empty value")
	}

	try {
		return hexToBytes(clean)
	} catch {
		// not hex, try base64
	}

	const sanitized = clean.replace(/[^A-Za-z0-9+/=]/g, "")
	if (!sanitized) {
		throw new Error("ABCI query returned empty value")
	}

	try {
		return base64.decode(sanitized)
	} catch {
		throw new Error("ABCI query returned invalid value encoding")
	}
}

const abciQuery = async <TReq extends DescMessage, TRes extends DescMessage>(
	config: TransportConfig,
	req: UnaryRequest<TReq, TRes>
): Promise<Uint8Array> => {
	const path = req.service.startsWith("/")
		? `${req.service}/${req.method}`
		: `/${req.service}/${req.method}`
	const dataHex = bytesToHex(toBinary(req.requestSchema, req.request))

	const params: Record<string, unknown> = { path, data: dataHex }
	if (req.height !== undefined) params.height = req.height
	if (req.prove !== undefined) params.prove = req.prove

	const json = await callJsonRpc(config, "abci_query", params)

	if (json.error && typeof json.error === "object") {
		const msg =
			"message" in json.error && typeof json.error.message === "string"
				? json.error.message
				: "ABCI query failed"
		throw new Error(msg)
	}

	const result = json.result
	if (!result || typeof result !== "object") {
		throw new Error("Empty ABCI response")
	}

	const response =
		"response" in result && typeof result.response === "object"
			? (result.response as Record<string, unknown>)
			: undefined
	if (!response) {
		throw new Error("Empty ABCI response")
	}

	const code =
		"code" in response && typeof response.code === "number" ? response.code : 0
	if (code !== 0) {
		const log =
			"log" in response && typeof response.log === "string"
				? response.log
				: "ABCI query failed"
		throw new Error(log)
	}

	const value =
		"value" in response && typeof response.value === "string"
			? (response.value as string)
			: "ResponseBase" in response &&
					typeof response.ResponseBase === "object" &&
					response.ResponseBase &&
					"value" in (response.ResponseBase as Record<string, unknown>) &&
					typeof (response.ResponseBase as Record<string, unknown>).value ===
						"string"
				? ((response.ResponseBase as Record<string, unknown>).value as string)
				: undefined

	return decodeAbciValue(value)
}

const broadcastTxRaw = async (
	config: TransportConfig,
	tx: Uint8Array,
	mode?: "sync" | "async" | number
) => {
	const resolvedMode =
		typeof mode === "number" ? (mode === 3 ? "async" : "sync") : mode
	const broadcastMode = resolvedMode ?? config.broadcastMode
	const method =
		broadcastMode === "async" ? "broadcast_tx_async" : "broadcast_tx_sync"
	const params = { tx: base64.encode(tx) }

	const json = await callJsonRpc(config, method, params)

	if (json.error && typeof json.error === "object") {
		const msg =
			"message" in json.error && typeof json.error.message === "string"
				? json.error.message
				: "Broadcast failed"
		throw new Error(msg)
	}

	const res = json.result
	if (!res || typeof res !== "object") {
		throw new Error("Empty broadcast response")
	}

	const code = "code" in res && typeof res.code === "number" ? res.code : 0
	if (code !== 0) {
		const log =
			"log" in res && typeof res.log === "string" ? res.log : "Broadcast failed"
		throw new Error(log)
	}

	return {
		code,
		hash: "hash" in res && typeof res.hash === "string" ? res.hash : "",
		log: "log" in res && typeof res.log === "string" ? res.log : undefined,
		data: "data" in res && typeof res.data === "string" ? res.data : undefined,
		height:
			"height" in res && typeof res.height === "number"
				? res.height
				: undefined,
		codespace:
			"codespace" in res && typeof res.codespace === "string"
				? res.codespace
				: undefined
	}
}

export const createTendermintRpcTransport = (
	config: RpcClientConfig
): TendermintRpcTransport => {
	const normalized = normalizeConfig(config)

	return {
		abciQuery: (req) => abciQuery(normalized, req),
		broadcastTxRaw: (tx, mode) => broadcastTxRaw(normalized, tx, mode)
	}
}
