import { describe, expect, test } from "bun:test"
import { create } from "@bufbuild/protobuf"
import { QueryAccountInfoRequestSchema } from "../../gen/cosmos/auth/descriptor/v1beta1/query_pb"
import { createAuthV1beta1QueryRpcClient } from "../../gen/cosmos/auth/rpc"
import { QueryBalanceRequestSchema } from "../../gen/cosmos/bank/descriptor/v1beta1/query_pb"
import { MsgSendSchema } from "../../gen/cosmos/bank/descriptor/v1beta1/tx_pb"
import { createBankV1beta1QueryRpcClient } from "../../gen/cosmos/bank/rpc"
import {
	BroadcastMode,
	BroadcastTxRequestSchema,
	GetTxRequestSchema
} from "../../gen/cosmos/tx/descriptor/v1beta1/service_pb"
import { createTxV1beta1ServiceRpcClient } from "../../gen/cosmos/tx/rpc"
import { createEthermintSigner } from "../../src/signer/ethsecp256k1"

const RPC_ENDPOINT =
	process.env.PIONEER_RPC_ENDPOINT ?? process.env.TENDERMINT_RPC_ENDPOINT
const MNEMONIC = process.env.PIONEER_MNEMONIC
const CHAIN_ID = process.env.PIONEER_CHAIN_ID
const DENOM = process.env.PIONEER_DENOM
const ADDRESS_PREFIX = process.env.PIONEER_ADDRESS_PREFIX
const TEST_ADDRESS = process.env.PIONEER_TEST_ADDRESS
const RUN_LIVE = process.env.PIONEER_RUN_LIVE_TESTS === "true"

const hasSignerConfig = Boolean(MNEMONIC && ADDRESS_PREFIX && CHAIN_ID && DENOM)
const derivedAddress =
	hasSignerConfig && MNEMONIC && ADDRESS_PREFIX
		? createEthermintSigner({
				mnemonic: MNEMONIC,
				prefix: ADDRESS_PREFIX
			}).getAddress(ADDRESS_PREFIX)
		: undefined
const address = TEST_ADDRESS ?? derivedAddress

if (!RUN_LIVE) {
	throw new Error(
		"Set PIONEER_RUN_LIVE_TESTS=true to exercise RPC live network tests"
	)
}
if (!RPC_ENDPOINT) {
	throw new Error(
		"PIONEER_RPC_ENDPOINT or TENDERMINT_RPC_ENDPOINT is required for RPC integration tests"
	)
}
if (!DENOM) {
	throw new Error("PIONEER_DENOM is required for RPC integration tests")
}
if (!MNEMONIC) {
	throw new Error("PIONEER_MNEMONIC is required for RPC integration tests")
}
if (!CHAIN_ID) {
	throw new Error("PIONEER_CHAIN_ID is required for RPC integration tests")
}
if (!ADDRESS_PREFIX) {
	throw new Error(
		"PIONEER_ADDRESS_PREFIX is required for RPC integration tests"
	)
}
if (!address) {
	throw new Error(
		"RPC tests require either PIONEER_TEST_ADDRESS or a valid signer-derived address"
	)
}

describe("Pioneer Tendermint RPC live wiring", () => {
	const bank = createBankV1beta1QueryRpcClient({ endpoint: RPC_ENDPOINT })
	const auth = createAuthV1beta1QueryRpcClient({ endpoint: RPC_ENDPOINT })
	const tx = createTxV1beta1ServiceRpcClient({ endpoint: RPC_ENDPOINT })

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

	test("bank balance query succeeds over Tendermint RPC", async () => {
		if (!address || !DENOM)
			throw new Error("address or denom missing for balance test")
		const response = await bank.balance(
			create(QueryBalanceRequestSchema, {
				address,
				denom: DENOM
			})
		)

		expect(response.balance?.denom).toBe(DENOM)
		expect(response.balance?.amount?.length ?? 0).toBeGreaterThan(0)
	})

	test("sign and broadcast MsgSend over Tendermint RPC", async () => {
		if (!MNEMONIC || !ADDRESS_PREFIX || !DENOM || !CHAIN_ID)
			throw new Error("signer config missing")
		const signer = createEthermintSigner({
			mnemonic: MNEMONIC,
			prefix: ADDRESS_PREFIX
		})

		const accountInfo = await auth.accountInfo(
			create(QueryAccountInfoRequestSchema, { address: address ?? "" })
		)

		const baseAccount = accountInfo.info
		if (!baseAccount) {
			throw new Error("Account info missing in Tendermint RPC response")
		}

		const msgSend = create(MsgSendSchema, {
			fromAddress: address ?? "",
			toAddress: address ?? "",
			amount: [{ denom: DENOM, amount: "1" }]
		})

		const { txRawBytes } = signer.sign(
			[
				{
					typeUrl: "/cosmos.bank.v1beta1.MsgSend",
					schema: MsgSendSchema,
					value: msgSend
				}
			],
			{
				chainId: CHAIN_ID,
				accountNumber: BigInt(baseAccount.accountNumber ?? 0),
				sequence: BigInt(baseAccount.sequence ?? 0),
				feeDenom: DENOM,
				feeAmount: "2000",
				gasLimit: "200000",
				memo: `pioneer-e2e-rpc-${Date.now()}`
			}
		)

		const initialBroadcast = create(BroadcastTxRequestSchema, {
			txBytes: txRawBytes,
			mode: BroadcastMode.SYNC
		})

		const res = await tx.broadcastTx(initialBroadcast)
		const txRes = res.txResponse
		expect(txRes?.txhash?.length ?? 0).toBeGreaterThan(0)
		expect(txRes?.code).toBe(0)

		if (txRes?.txhash) {
			await waitForTxCommit(txRes.txhash)
		}
	}, 20000)
})
