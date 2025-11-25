import { describe, expect, test } from "bun:test"
import { create } from "@bufbuild/protobuf"
import { QueryAccountInfoRequestSchema } from "../../gen/cosmos/auth/descriptor/v1beta1/query_pb"
import { createAuthV1beta1QueryRestClient } from "../../gen/cosmos/auth/rest"
import { QueryBalanceRequestSchema } from "../../gen/cosmos/bank/descriptor/v1beta1/query_pb"
import { MsgSendSchema } from "../../gen/cosmos/bank/descriptor/v1beta1/tx_pb"
import { createBankV1beta1QueryRestClient } from "../../gen/cosmos/bank/rest"
import {
	BroadcastMode,
	BroadcastTxRequestSchema,
	GetTxRequestSchema
} from "../../gen/cosmos/tx/descriptor/v1beta1/service_pb"
import { createTxV1beta1ServiceRestClient } from "../../gen/cosmos/tx/rest"
import { createEthermintSigner } from "../../src/signer/ethsecp256k1"

const REST_ENDPOINT = process.env.PIONEER_REST_ENDPOINT
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
		"Set PIONEER_RUN_LIVE_TESTS=true to exercise REST live network tests"
	)
}
if (!REST_ENDPOINT) {
	throw new Error(
		"PIONEER_REST_ENDPOINT is required for REST integration tests"
	)
}
if (!DENOM) {
	throw new Error("PIONEER_DENOM is required for REST integration tests")
}
if (!MNEMONIC) {
	throw new Error("PIONEER_MNEMONIC is required for REST integration tests")
}
if (!CHAIN_ID) {
	throw new Error("PIONEER_CHAIN_ID is required for REST integration tests")
}
if (!ADDRESS_PREFIX) {
	throw new Error(
		"PIONEER_ADDRESS_PREFIX is required for REST integration tests"
	)
}
if (!address) {
	throw new Error(
		"REST tests require either PIONEER_TEST_ADDRESS or a valid signer-derived address"
	)
}

describe("Pioneer REST live wiring", () => {
	const bank = createBankV1beta1QueryRestClient({ baseUrl: REST_ENDPOINT })
	const auth = createAuthV1beta1QueryRestClient({ baseUrl: REST_ENDPOINT })
	const tx = createTxV1beta1ServiceRestClient({ baseUrl: REST_ENDPOINT })

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

	test("bank balance query succeeds over REST", async () => {
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

	test("sign and broadcast MsgSend over REST", async () => {
		const signer = createEthermintSigner({
			mnemonic,
			prefix
		})

		const accountInfo = await auth.accountInfo(
			create(QueryAccountInfoRequestSchema, { address: signerAddress })
		)

		const baseAccount = accountInfo.info
		if (!baseAccount) {
			throw new Error("Account info missing in REST response")
		}

		const msgSend = create(MsgSendSchema, {
			fromAddress: signerAddress,
			toAddress: signerAddress,
			amount: [{ denom, amount: "1" }]
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
				chainId,
				accountNumber: BigInt(baseAccount.accountNumber ?? 0),
				sequence: BigInt(baseAccount.sequence ?? 0),
				feeDenom: denom,
				feeAmount: "2000",
				gasLimit: "200000",
				memo: `pioneer-e2e-rest-${Date.now()}`
			}
		)

		const initialBroadcast = create(BroadcastTxRequestSchema, {
			txBytes: txRawBytes,
			mode: BroadcastMode.SYNC
		})

		const res = await tx.broadcastTx(initialBroadcast)
		if (!res.txResponse) {
			throw new Error("REST broadcast returned no txResponse")
		}
		const txHash = res.txResponse.txhash
		if (!txHash) {
			throw new Error("Tx hash missing from broadcast response")
		}
		expect(txHash.length).toBeGreaterThan(0)

		// BroadcastMode.SYNC guarantees CheckTx was run; we assert CheckTx success here.
		expect(res.txResponse.code).toBe(0)
		await waitForTxCommit(txHash)
	}, 20000)
})
