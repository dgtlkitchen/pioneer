import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import type { Any } from "@bufbuild/protobuf/wkt"
import { SignMode } from "../cosmos/tx/signing/v1beta1/signing_pb.js"
import {
	AuthInfoSchema,
	SignDocSchema,
	TxBodySchema,
	TxRawSchema
} from "../cosmos/tx/v1beta1/tx_pb.js"

export type DirectTransaction = {
	chainId: string
	accountNumber: bigint
	sequence: bigint
	publicKey?: Any
	messages: Any[]
	fee: {
		amount: { denom: string; amount: string }[]
		gasLimit: bigint
		payer?: string
	}
	memo?: string
	timeoutHeight: bigint
}
const uint64 = (value: bigint) => {
	if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn)
		throw new Error("Expected uint64 bigint")
}

/** Explicit one-signer DIRECT construction. No key custody, guessed fees, or account queries. */
export function createDirectSignDoc(input: DirectTransaction): Uint8Array {
	for (const number of [
		input.accountNumber,
		input.sequence,
		input.timeoutHeight,
		input.fee.gasLimit
	])
		uint64(number)
	if (!input.chainId || !input.messages.length || input.fee.gasLimit === 0n)
		throw new Error("Chain ID, messages and positive gas limit are required")
	for (const coin of input.fee.amount) {
		if (!coin.denom || !/^(0|[1-9][0-9]*)$/.test(coin.amount))
			throw new Error("Fees must use integer base-unit amounts")
	}
	const bodyBytes = toBinary(
		TxBodySchema,
		create(TxBodySchema, {
			messages: input.messages,
			memo: input.memo,
			timeoutHeight: input.timeoutHeight
		})
	)
	const authInfoBytes = toBinary(
		AuthInfoSchema,
		create(AuthInfoSchema, {
			signerInfos: [
				{
					publicKey: input.publicKey,
					sequence: input.sequence,
					modeInfo: {
						sum: { case: "single", value: { mode: SignMode.DIRECT } }
					}
				}
			],
			fee: input.fee
		})
	)
	return toBinary(
		SignDocSchema,
		create(SignDocSchema, {
			bodyBytes,
			authInfoBytes,
			chainId: input.chainId,
			accountNumber: input.accountNumber
		})
	)
}

/** Assemble using the original signed body/auth bytes, never reconstructed JSON. */
export function assembleTransaction(
	signDocBytes: Uint8Array,
	signature: Uint8Array
): Uint8Array {
	if (!signature.length) throw new Error("Signature must not be empty")
	const doc = fromBinary(SignDocSchema, signDocBytes)
	const auth = fromBinary(AuthInfoSchema, doc.authInfoBytes)
	if (
		auth.signerInfos.length !== 1 ||
		auth.signerInfos[0].modeInfo?.sum.case !== "single" ||
		auth.signerInfos[0].modeInfo.sum.value.mode !== SignMode.DIRECT
	)
		throw new Error("Expected one DIRECT signer")
	return toBinary(
		TxRawSchema,
		create(TxRawSchema, {
			bodyBytes: doc.bodyBytes,
			authInfoBytes: doc.authInfoBytes,
			signatures: [signature]
		})
	)
}
