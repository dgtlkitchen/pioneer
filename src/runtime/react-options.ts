import { clone, isMessage } from "@bufbuild/protobuf"
import { AnySchema } from "@bufbuild/protobuf/wkt"
import {
	mutationOptions,
	type OmitKeyof,
	type QueryClient,
	type QueryFunction,
	type QueryKeyWithDataTag,
	queryOptions,
	type UseMutationOptions,
	type UseMutationResult,
	type UseQueryOptions,
	type UseSuspenseQueryResult,
	useMutation,
	useQueryClient,
	useSuspenseQuery,
	type WithRequired
} from "@tanstack/react-query"
import {
	type Any,
	type CallOptions,
	create,
	type DescMessage,
	type DescMethodUnary,
	fromBinary,
	type MessageInitShape,
	type MessageShape,
	toBinary
} from "../index.js"
import {
	type ChainHookContext,
	type ChainTxContext,
	type NativeChainTxContext,
	type NativeSubmissionReceipt,
	requireNativeChainTxContext,
	type SubmissionReceipt
} from "./context.js"

export type SdkChainKey = readonly [
	"pioneer-chain",
	string,
	string,
	string | null
]
export type SdkModuleKey = readonly [...SdkChainKey, string]
export type SdkQueryKey = readonly [...SdkModuleKey, "query", string, string]
export type SdkTxKey = readonly [...SdkModuleKey, "tx", string, string | null]
export type SdkQueryOptions<O extends DescMessage> = OmitKeyof<
	UseQueryOptions<number[], Error, MessageShape<O>, readonly unknown[]>,
	"queryFn"
> & {
	queryFn?: QueryFunction<number[], readonly unknown[], never> | undefined
} & QueryKeyWithDataTag<readonly unknown[], number[], Error>
export type SdkMutationOptions<O, I> = WithRequired<
	UseMutationOptions<O, Error, I, unknown>,
	"mutationKey"
>

export const sdkKeys: {
	all: (context: ChainHookContext) => SdkChainKey
	module: (context: ChainHookContext, module: string) => SdkModuleKey
	query: <I extends DescMessage>(
		context: ChainHookContext,
		module: string,
		operation: string,
		schema: I,
		input: MessageInitShape<I>
	) => SdkQueryKey
	tx: (
		context: ChainHookContext,
		module: string,
		operation: string,
		signerAddress?: string
	) => SdkTxKey
} = {
	all: (context: ChainHookContext) =>
		[
			"pioneer-chain",
			context.chainId,
			context.rpc.baseUrl,
			context.rest?.baseUrl ?? null
		] as const,
	module: (context: ChainHookContext, module: string) =>
		[...sdkKeys.all(context), module] as const,
	query: <I extends DescMessage>(
		context: ChainHookContext,
		module: string,
		operation: string,
		schema: I,
		input: MessageInitShape<I>
	) =>
		[
			...sdkKeys.module(context, module),
			"query",
			operation,
			Array.from(toBinary(schema, create(schema, input)), (byte) =>
				byte.toString(16).padStart(2, "0")
			).join("")
		] as const,
	tx: (
		context: ChainHookContext,
		module: string,
		operation: string,
		signerAddress?: string
	) =>
		[
			...sdkKeys.module(context, module),
			"tx",
			operation,
			signerAddress ?? null
		] as const
}

/** JSON-safe cache; typed selectors retain original Any URLs and unknown fields. */
export function sdkQueryOptions<I extends DescMessage, O extends DescMessage>(
	key: readonly unknown[],
	method: DescMethodUnary<I, O>,
	input: MessageInitShape<I>,
	call: (
		request: MessageInitShape<I>,
		options?: CallOptions
	) => Promise<MessageShape<O>>
): SdkQueryOptions<O> {
	const request = create(method.input, structuredClone(input))
	return queryOptions({
		queryKey: key,
		queryFn: async ({ signal }) =>
			Array.from(toBinary(method.output, await call(request, { signal }))),
		select: (bytes) => fromBinary(method.output, new Uint8Array(bytes)),
		staleTime: 10_000
	})
}

export function sdkMessageMutationOptions<I>(
	context: ChainTxContext,
	key: readonly unknown[],
	pack: (input: I) => Any
): SdkMutationOptions<SubmissionReceipt, I> {
	if (!context.signerAddress)
		throw new Error("An explicit signing account is required")
	return mutationOptions({
		mutationKey: key,
		mutationFn: (input: I) => context.submit(pack(structuredClone(input))),
		retry: false,
		networkMode: "always",
		gcTime: 0
	})
}

export type NativeMutationVariables<I> = {
	readonly request: I
	readonly signal: AbortSignal
}

export type NativeMessageReceipt<O extends DescMessage> =
	NativeSubmissionReceipt & { readonly response: MessageShape<O> }

export type NativeMessageMutationOptions<
	I extends DescMessage,
	O extends DescMessage
> = Omit<
	UseMutationOptions<
		NativeMessageReceipt<O>,
		Error,
		NativeMutationVariables<MessageInitShape<I>>
	>,
	"mutationKey" | "mutationFn" | "retry" | "networkMode" | "gcTime" | "scope"
> & {
	readonly mutationKey: readonly unknown[]
	readonly mutationFn: (
		variables: NativeMutationVariables<MessageInitShape<I>>
	) => Promise<NativeMessageReceipt<O>>
	readonly retry: false
	readonly networkMode: "always"
	readonly gcTime: 0
}

export class NativeResponseError extends Error {
	readonly txHash: string | null
	readonly height: bigint | null
	readonly receipt: NativeSubmissionReceipt | null
	readonly requestTypeUrl: string
	readonly responseTypeUrl: string

	constructor(input: {
		readonly txHash: string | null
		readonly height: bigint | null
		readonly receipt: NativeSubmissionReceipt | null
		readonly requestTypeUrl: string
		readonly responseTypeUrl: string
		readonly cause: unknown
	}) {
		super(
			`Invalid native response for ${input.requestTypeUrl}: expected ${input.responseTypeUrl}`,
			{ cause: input.cause }
		)
		this.name = "NativeResponseError"
		this.txHash = input.txHash
		this.height = input.height
		this.receipt = input.receipt
		this.requestTypeUrl = input.requestTypeUrl
		this.responseTypeUrl = input.responseTypeUrl
	}
}

const nativeHash = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)
const nativeHeight = (value: unknown): value is bigint =>
	typeof value === "bigint" && value > 0n

function nativeReceipt(value: unknown): NativeSubmissionReceipt {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("hash" in value) ||
		!nativeHash(value.hash) ||
		!("height" in value) ||
		!nativeHeight(value.height) ||
		!("responses" in value) ||
		!Array.isArray(value.responses)
	)
		throw new Error("Expected a complete confirmed native receipt")
	const responses: Any[] = []
	for (const response of value.responses) {
		if (
			Array.isArray(response) ||
			!isMessage(response, AnySchema) ||
			typeof response.typeUrl !== "string" ||
			!(response.value instanceof Uint8Array)
		)
			throw new Error("Expected native Any response bytes")
		// A binary round trip owns ordinary bytes, including protobuf unknown fields.
		responses.push(
			fromBinary(AnySchema, new Uint8Array(toBinary(AnySchema, response)))
		)
	}
	return { hash: value.hash, height: value.height, responses }
}

/**
 * Applications must reject effective serial scopes, including inherited defaults.
 * Applications must exclude native mutations from dehydration, persistence, and restoration.
 * gcTime only collects unobserved, nonpending mutations, not active variables.
 */
export function sdkNativeMessageMutationOptions<
	I extends DescMessage,
	O extends DescMessage
>(
	context: NativeChainTxContext,
	key: readonly unknown[],
	method: DescMethodUnary<I, O>
): NativeMessageMutationOptions<I, O> {
	requireNativeChainTxContext(context)
	return {
		mutationKey: ["native-tx-v1", ...key],
		mutationFn: async (variables) => {
			requireNativeChainTxContext(context)
			if (!variables || !(variables.signal instanceof AbortSignal))
				throw new Error("A native mutation requires an AbortSignal")
			const { signal, request } = variables
			signal.throwIfAborted()
			if (
				!request ||
				typeof request !== "object" ||
				Array.isArray(request) ||
				("$typeName" in request && request.$typeName !== method.input.typeName)
			)
				throw new Error(`Expected ${method.input.typeName} request`)
			const requestTypeUrl = `/${method.input.typeName}`
			const responseTypeUrl = `/${method.output.typeName}`
			const snapshot = clone(method.input, create(method.input, request))
			const message = create(AnySchema, {
				typeUrl: requestTypeUrl,
				value: new Uint8Array(toBinary(method.input, snapshot))
			})
			signal.throwIfAborted()
			// Submission failures retain the adapter's cancellation and uncertainty identity.
			const result: unknown = await requireNativeChainTxContext(
				context
			).submitNative({
				message,
				signal
			})
			let receipt: NativeSubmissionReceipt | null = null
			try {
				receipt = nativeReceipt(result)
				if (receipt.responses.length !== 1)
					throw new Error("Expected exactly one native response")
				const [response] = receipt.responses
				if (response.typeUrl !== responseTypeUrl)
					throw new Error(`Expected native response type ${responseTypeUrl}`)
				return {
					...receipt,
					response: fromBinary(method.output, new Uint8Array(response.value))
				}
			} catch (cause) {
				throw new NativeResponseError({
					txHash:
						receipt?.hash ??
						(result &&
						typeof result === "object" &&
						"hash" in result &&
						nativeHash(result.hash)
							? result.hash
							: null),
					height:
						receipt?.height ??
						(result &&
						typeof result === "object" &&
						"height" in result &&
						nativeHeight(result.height)
							? result.height
							: null),
					receipt,
					requestTypeUrl,
					responseTypeUrl,
					cause
				})
			}
		},
		retry: false,
		networkMode: "always",
		gcTime: 0
	}
}

export function sdkServiceMutationOptions<I, O>(
	key: readonly unknown[],
	call: (input: I) => Promise<O>
): SdkMutationOptions<O, I> {
	return mutationOptions({
		mutationKey: key,
		mutationFn: (input: I) => call(structuredClone(input)),
		retry: false,
		networkMode: "always",
		gcTime: 0
	})
}

export async function invalidateIncludedTransaction(
	cache: QueryClient,
	context: ChainHookContext,
	result: unknown
): Promise<void> {
	if (
		!(typeof result === "object" && result !== null && "txResponse" in result)
	)
		return
	const receipt = result.txResponse
	if (
		!(
			typeof receipt === "object" &&
			receipt !== null &&
			"height" in receipt &&
			typeof receipt.height === "bigint" &&
			receipt.height > 0n
		)
	)
		return
	await cache.invalidateQueries({ queryKey: sdkKeys.all(context) })
}

/** Suspense read over SDK query options; generated hooks share one typed call. */
export function useSdkQuery<O extends DescMessage>(
	options: SdkQueryOptions<O>
): UseSuspenseQueryResult<MessageShape<O>, Error> {
	return useSuspenseQuery(options)
}

/** Explicit submission; an included transaction invalidates this chain's reads. */
export function useSdkMutation<O, I>(
	context: ChainHookContext,
	options: SdkMutationOptions<O, I>
): UseMutationResult<O, Error, I> {
	const cache = useQueryClient()
	return useMutation({
		...options,
		onSuccess: (result) => invalidateIncludedTransaction(cache, context, result)
	})
}

export function useSdkNativeMutation<
	I extends DescMessage,
	O extends DescMessage
>(
	options: NativeMessageMutationOptions<I, O>
): UseMutationResult<
	NativeMessageReceipt<O>,
	Error,
	NativeMutationVariables<MessageInitShape<I>>
> {
	return useMutation(options)
}
