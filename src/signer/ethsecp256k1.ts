import { create, type Message, toBinary } from "@bufbuild/protobuf"
import type { GenMessage } from "@bufbuild/protobuf/codegenv2"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { keccak_256 } from "@noble/hashes/sha3.js"
import { bech32 } from "@scure/base"
import { HDKey } from "@scure/bip32"
import { mnemonicToSeedSync } from "@scure/bip39"
import { PubKeySchema } from "../../gen/cosmos/evm/descriptor/crypto/v1/ethsecp256k1/keys_pb"
import { SignMode } from "../../gen/cosmos/tx/descriptor/signing/v1beta1/signing_pb"
import {
	AuthInfoSchema,
	FeeSchema,
	ModeInfoSchema,
	SignDocSchema,
	SignerInfoSchema,
	TxBodySchema,
	TxRawSchema
} from "../../gen/cosmos/tx/descriptor/v1beta1/tx_pb"

export const ETH_PUBKEY_TYPE_URL = "/cosmos.evm.crypto.v1.ethsecp256k1.PubKey"

export type ProtoMsg = {
	typeUrl: string
	schema: GenMessage<Message>
	value: Message
}

export type SignOptions = {
	chainId: string
	accountNumber: bigint | number | string
	sequence: bigint | number | string
	memo?: string
	gasLimit?: bigint | number | string
	feeAmount?: string | number | bigint
	feeDenom: string
}

export type EthermintSignerConfig = {
	mnemonic: string
	hdPath?: string
	prefix?: string
}

const defaultHdPath = "m/44'/60'/0'/0/0"

const keccakBech32Address = (
	uncompressedPubkey: Uint8Array,
	prefix: string
): string => {
	const hash = keccak_256(uncompressedPubkey.slice(1))
	const addr = hash.slice(-20)
	return bech32.encode(prefix, bech32.toWords(Buffer.from(addr)))
}

const encodeEthPubkeyAny = (pubkeyBytes: Uint8Array) => ({
	typeUrl: ETH_PUBKEY_TYPE_URL,
	value: toBinary(PubKeySchema, create(PubKeySchema, { key: pubkeyBytes }))
})

export type EthermintSigner = {
	getAddress: (prefix?: string) => string
	sign: (
		messages: ProtoMsg[],
		opts: SignOptions
	) => {
		bodyBytes: Uint8Array
		authInfoBytes: Uint8Array
		signature: Uint8Array
		txRawBytes: Uint8Array
		txRawBase64: string
	}
}

export const createEthermintSigner = (
	config: EthermintSignerConfig
): EthermintSigner => {
	const seed = mnemonicToSeedSync(config.mnemonic)
	const master = HDKey.fromMasterSeed(seed)
	const child = master.derive(config.hdPath ?? defaultHdPath)
	if (!child.privateKey) {
		throw new Error("Failed to derive private key from mnemonic/hdPath")
	}

	const privkey = child.privateKey
	const pubkeyUncompressed = secp256k1.getPublicKey(privkey, false)
	const pubkeyCompressed = secp256k1.getPublicKey(privkey, true)
	const defaultPrefix = config.prefix ?? "cosmos"
	const getAddress = (prefix?: string) =>
		keccakBech32Address(pubkeyUncompressed, prefix ?? defaultPrefix)

	const buildBodyBytes = (messages: ProtoMsg[], memo?: string): Uint8Array => {
		const anyMessages = messages.map((m) => ({
			typeUrl: m.typeUrl,
			value: toBinary(m.schema, m.value)
		}))
		const body = create(TxBodySchema, {
			messages: anyMessages,
			memo: memo ?? ""
		})
		return toBinary(TxBodySchema, body)
	}

	const buildAuthInfoBytes = (
		sequence: bigint,
		feeAmount: string,
		feeDenom: string,
		gas: bigint
	) => {
		const modeInfo = create(ModeInfoSchema, {
			sum: { case: "single", value: { mode: SignMode.DIRECT } }
		})
		const signerInfo = create(SignerInfoSchema, {
			publicKey: encodeEthPubkeyAny(pubkeyCompressed),
			modeInfo,
			sequence
		})
		const fee = create(FeeSchema, {
			amount: [{ amount: feeAmount, denom: feeDenom }],
			gasLimit: gas
		})

		const authInfo = create(AuthInfoSchema, {
			signerInfos: [signerInfo],
			fee
		})

		return toBinary(AuthInfoSchema, authInfo)
	}

	const signDirect = (signDocBytes: Uint8Array): Uint8Array => {
		const hash = keccak_256(signDocBytes)
		return secp256k1.sign(hash, privkey, { prehash: false })
	}

	const sign = (messages: ProtoMsg[], opts: SignOptions) => {
		const gasLimit = BigInt(opts.gasLimit ?? 200000n)
		const feeAmount = opts.feeAmount ?? "2000"
		const feeDenom = opts.feeDenom

		const bodyBytes = buildBodyBytes(messages, opts.memo)
		const authInfoBytes = buildAuthInfoBytes(
			BigInt(opts.sequence),
			String(feeAmount),
			feeDenom,
			gasLimit
		)

		const signDoc = create(SignDocSchema, {
			bodyBytes,
			authInfoBytes,
			chainId: opts.chainId,
			accountNumber: BigInt(opts.accountNumber)
		})

		const signDocBytes = toBinary(SignDocSchema, signDoc)
		const signature = signDirect(signDocBytes)

		const txRaw = create(TxRawSchema, {
			bodyBytes,
			authInfoBytes,
			signatures: [signature]
		})

		const txRawBytes = toBinary(TxRawSchema, txRaw)
		const txRawBase64 = Buffer.from(txRawBytes).toString("base64")

		return {
			bodyBytes,
			authInfoBytes,
			signature,
			txRawBytes,
			txRawBase64
		}
	}

	return {
		getAddress,
		sign
	}
}
