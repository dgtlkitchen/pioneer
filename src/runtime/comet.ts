import { base64 } from "@scure/base"
import type { CallOptions, RestClientConfig } from "./rest.js"
import { createRpcRequest, JsonRpcError, rpcRecord } from "./rpc.js"

const hashPattern = /^[0-9A-Fa-f]{64}$/
function hash(value: unknown): string {
	if (typeof value !== "string" || !hashPattern.test(value))
		throw new Error("Malformed Comet transaction hash")
	return value.toUpperCase()
}
function code(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 0xffffffff
	)
		throw new Error("Malformed Comet transaction result code")
	return value
}

/** Native Comet JSON-RPC operations; these are not fabricated protobuf/ABCI services. */
export function createCometClient(config: RestClientConfig) {
	const request = createRpcRequest(config)
	return {
		async status(options?: CallOptions) {
			const result = await request("status", {}, options)
			if (
				!rpcRecord(result) ||
				!rpcRecord(result.node_info) ||
				typeof result.node_info.network !== "string"
			)
				throw new Error("Malformed Comet status")
			return { chainId: result.node_info.network }
		},
		async broadcastSync(bytes: Uint8Array, options?: CallOptions) {
			if (bytes.length === 0 || bytes.length > 1_048_576)
				throw new Error("Signed transaction must contain 1..1048576 bytes")
			const result = await request(
				"broadcast_tx_sync",
				{ tx: base64.encode(bytes) },
				options
			)
			if (!rpcRecord(result))
				throw new Error("Malformed Comet broadcast result")
			return { hash: hash(result.hash), code: code(result.code) }
		},
		async transaction(transactionHash: string, options?: CallOptions) {
			const expected = hash(transactionHash)
			const bytes = Uint8Array.from(expected.match(/../g) ?? [], (value) =>
				Number.parseInt(value, 16)
			)
			let result: unknown
			try {
				// JSON-RPC []byte parameters are base64, unlike URL-query 0x literals.
				result = await request(
					"tx",
					{ hash: base64.encode(bytes), prove: false },
					options
				)
			} catch (error) {
				// Selected Comet core.Tx reports exactly this error when the index has no tx.
				// Disabled indexing, transport errors and malformed responses are NOT pending.
				if (
					error instanceof JsonRpcError &&
					error.code === -32603 &&
					error.data === `tx (${expected}) not found`
				)
					return undefined
				throw error
			}
			if (
				!rpcRecord(result) ||
				!rpcRecord(result.tx_result) ||
				typeof result.height !== "string" ||
				!/^[1-9][0-9]*$/.test(result.height)
			)
				throw new Error("Malformed Comet transaction result")
			const actual = hash(result.hash)
			if (actual !== expected)
				throw new Error("Mismatched Comet transaction hash")
			const { codespace, log, data } = result.tx_result
			if (codespace !== undefined && typeof codespace !== "string")
				throw new Error("Malformed Comet transaction codespace")
			if (log !== undefined && typeof log !== "string")
				throw new Error("Malformed Comet transaction log")
			if (data !== undefined && data !== null && typeof data !== "string")
				throw new Error("Malformed Comet transaction data")
			return {
				hash: actual,
				height: BigInt(result.height),
				code: code(result.tx_result.code),
				codespace,
				log,
				data
			}
		}
	}
}
