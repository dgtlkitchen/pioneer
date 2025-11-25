import { describe, expect, test } from "bun:test"
import { create } from "@bufbuild/protobuf"
import { createAuthV1beta1QueryClient } from "../../gen/cosmos/auth/grpc"
import { QueryBalanceRequestSchema } from "../../gen/cosmos/bank/descriptor/v1beta1/query_pb"
import { MsgSendSchema } from "../../gen/cosmos/bank/descriptor/v1beta1/tx_pb"
import { createBankV1beta1QueryClient } from "../../gen/cosmos/bank/grpc"
import {
	BroadcastMode,
	GetTxRequestSchema
} from "../../gen/cosmos/tx/descriptor/v1beta1/service_pb"
import { createTxV1beta1ServiceClient } from "../../gen/cosmos/tx/grpc"
import { createEthermintSigner } from "../../src/signer/ethsecp256k1"

const GRPC_ENDPOINT = process.env.PIONEER_GRPC_ENDPOINT
const MNEMONIC = process.env.PIONEER_MNEMONIC
const CHAIN_ID = process.env.PIONEER_CHAIN_ID
const DENOM = process.env.PIONEER_DENOM
const ADDRESS_PREFIX = process.env.PIONEER_ADDRESS_PREFIX
const TEST_ADDRESS = process.env.PIONEER_TEST_ADDRESS
const RUN_LIVE = process.env.PIONEER_RUN_LIVE_TESTS === "true"

const hasSignerConfig = Boolean(MNEMONIC && ADDRESS_PREFIX && CHAIN_ID && DENOM)
const derivedAddress =
	MNEMONIC && ADDRESS_PREFIX && hasSignerConfig
		? createEthermintSigner({
				mnemonic: MNEMONIC,
				prefix: ADDRESS_PREFIX
			}).getAddress(ADDRESS_PREFIX)
		: undefined
const address = TEST_ADDRESS ?? derivedAddress

if (!RUN_LIVE) {
	throw new Error(
		"Set PIONEER_RUN_LIVE_TESTS=true to exercise gRPC live network tests"
	)
}
if (!GRPC_ENDPOINT) {
	throw new Error(
		"PIONEER_GRPC_ENDPOINT is required for gRPC integration tests"
	)
}
if (!DENOM) {
	throw new Error("PIONEER_DENOM is required for gRPC integration tests")
}
if (!MNEMONIC) {
	throw new Error("PIONEER_MNEMONIC is required for gRPC integration tests")
}
if (!CHAIN_ID) {
	throw new Error("PIONEER_CHAIN_ID is required for gRPC integration tests")
}
if (!ADDRESS_PREFIX) {
	throw new Error(
		"PIONEER_ADDRESS_PREFIX is required for gRPC integration tests"
	)
}
if (!address) {
	throw new Error(
		"gRPC tests require either PIONEER_TEST_ADDRESS or a valid signer-derived address"
	)
}

describe("Pioneer gRPC live wiring", () => {
	const bank = createBankV1beta1QueryClient({ baseUrl: GRPC_ENDPOINT })
	const auth = createAuthV1beta1QueryClient({ baseUrl: GRPC_ENDPOINT })
	const tx = createTxV1beta1ServiceClient({ baseUrl: GRPC_ENDPOINT })

	const waitForTxCommit = async (hash: string) => {
		await new Promise((resolve) => setTimeout(resolve, 10_000))
		const res = await tx.getTx(create(GetTxRequestSchema, { hash }))
		const txRes = res.txResponse
		if (!txRes || txRes.height <= 0n) {
			throw new Error(
				`Tx ${hash} not included in a block after waiting for commit`
			)
		}
	}

	const balanceAddress = address
	const denom = DENOM

	test("bank balance query succeeds", async () => {
		const response = await bank.balance(
			create(QueryBalanceRequestSchema, {
				address: balanceAddress,
				denom
			})
		)

		expect(response.balance?.denom).toBe(denom)
		expect(response.balance?.amount?.length ?? 0).toBeGreaterThan(0)
	})

	const chainId = CHAIN_ID
	const mnemonic = MNEMONIC
	const prefix = ADDRESS_PREFIX
	const signerAddress = address

	test("sign and broadcast MsgSend over gRPC", async () => {
		const signer = createEthermintSigner({
			mnemonic,
			prefix
		})

		const accountInfo = await auth.accountInfo({ address: signerAddress })
		const baseAccount = accountInfo.info
		if (!baseAccount) {
			throw new Error("Account info missing in gRPC response")
		}

		const msgSend = create(MsgSendSchema, {
			fromAddress: signerAddress,
			toAddress: signerAddress,
			amount: [{ denom, amount: "1" }]
		})

		const signAndBroadcast = (sequence: bigint) => {
			const { txRawBytes } = signer.sign(
				[
					{
						typeUrl: "/cosmos.bank.v1beta1.MsgSend",
						schema: MsgSendSchema,
						value: msgSend
					}
				],
				{
					chainId,
					accountNumber: BigInt(baseAccount.accountNumber ?? 0),
					sequence,
					feeDenom: denom,
					feeAmount: "2000",
					gasLimit: "200000",
					memo: `pioneer-e2e-grpc-${Date.now()}`
				}
			)

			return tx.broadcastTx({
				txBytes: txRawBytes,
				mode: BroadcastMode.SYNC
			})
		}

		const res = await signAndBroadcast(BigInt(baseAccount.sequence ?? 0))

		const txRes = res.txResponse
		expect(txRes).toBeDefined()
		if (!txRes) return

		expect(txRes.txhash.length).toBeGreaterThan(0)
		expect(txRes.code).toBe(0)
		// BroadcastMode.SYNC guarantees CheckTx was run; we assert CheckTx success here.

		await waitForTxCommit(txRes.txhash)
	}, 20000)
})
