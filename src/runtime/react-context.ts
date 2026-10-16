import type { Any, Fetch, RestClientConfig } from "../index.js"

export type ChainHookContext = {
	chainId: string
	rpc: RestClientConfig
	rest?: RestClientConfig
}
export type SubmissionReceipt = {
	txResponse?: { height: bigint; code: number; txhash: string }
}
/** Supplied by the reviewed application authorization flow, never a private key. */
export type ChainTxContext = ChainHookContext & {
	signerAddress: string
	submit: (message: Any) => Promise<SubmissionReceipt>
}

export type NativeSubmissionReceipt = {
	readonly hash: string
	readonly height: bigint
	readonly responses: readonly Any[]
}

export type NativeSubmitInput = {
	readonly message: Any
	readonly signal: AbortSignal
}

/** The application binds the signer and endpoints to its verified native adapter. */
export type NativeChainTxContext = ChainHookContext & {
	readonly capability: "native-tx-v1"
	readonly signerAddress: string
	readonly submitNative: (
		input: NativeSubmitInput
	) => Promise<NativeSubmissionReceipt>
}

export function requireNativeChainTxContext(
	context: ChainTxContext | NativeChainTxContext
): NativeChainTxContext {
	if (
		!context ||
		typeof context !== "object" ||
		!("capability" in context) ||
		context.capability !== "native-tx-v1" ||
		!("submitNative" in context) ||
		typeof context.submitNative !== "function" ||
		typeof context.signerAddress !== "string" ||
		!context.signerAddress.trim()
	)
		throw new Error(
			"A native-tx-v1 context with an explicit signer is required"
		)
	return context
}

export function createChainHookContext(config: {
	chainId: string
	rpcUrl: string
	restUrl?: string
	fetch?: Fetch
}): ChainHookContext {
	if (!config.chainId || config.chainId.trim() !== config.chainId)
		throw new Error("An explicit chain ID is required")
	return {
		chainId: config.chainId,
		rpc: { baseUrl: config.rpcUrl, fetch: config.fetch },
		...(config.restUrl
			? { rest: { baseUrl: config.restUrl, fetch: config.fetch } }
			: {})
	}
}

export function requireRest(
	context: ChainHookContext,
	operation: string
): RestClientConfig {
	if (!context.rest)
		throw new Error(
			`${operation} requires REST; this client is configured for RPC only`
		)
	return context.rest
}
