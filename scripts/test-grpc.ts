import { create, toBinary } from "@bufbuild/protobuf"
import { Secp256k1Auth } from "@interchainjs/auth/secp256k1"
import { DirectSigner } from "@interchainjs/cosmos/signers/direct"
import { Bip39, Random } from "@interchainjs/crypto"
import { HDPath } from "@interchainjs/types"
import { type MsgSend, MsgSendSchema } from "../generated/common/cosmos/bank/v1beta1/tx_pb.ts"
import {
	type SimulateRequest,
	SimulateRequestSchema
} from "../generated/common/cosmos/tx/v1beta1/service_pb.ts"
import { createBankQueryClient } from "../generated/grpc/cosmos/bank/v1beta1/Query.ts"
import { createTxServiceClient } from "../generated/grpc/cosmos/tx/v1beta1/Service.ts"

const mnemonic = Bip39.encode(Random.getBytes(16)).toString()
const [auth] = Secp256k1Auth.fromMnemonic(mnemonic, [HDPath.cosmos(0, 0, 0).toString()])
const signer = new DirectSigner(auth, [], "https://rpc.junotest.basementnodes.ca/", {
	prefix: "juno"
})
const address = await signer.getAddress()
console.log("Wallet address:", address)

const bankQueryClient = createBankQueryClient({
	baseUrl: "https://grpc.junotest.basementnodes.ca/"
})
const bankQueryTest = await bankQueryClient.balance({
	address: "juno1t4v3h355vsvexz46nz6h9repmgxgfml85r78rc",
	denom: "ujuno"
})

console.log("bankQueryTest", bankQueryTest)

const msgSend: MsgSend = create(MsgSendSchema, {
	fromAddress: address,
	toAddress: "juno1t4v3h355vsvexz46nz6h9repmgxgfml85r78rc",
	amount: [
		{
			denom: "ujuno",

			amount: "10000"
		}
	]
})
console.log("msgSend", msgSend)

const testMsg = { typeUrl: msgSend.$typeName, value: msgSend }
const signResponse = signer.sign({ messages: [testMsg] })
console.log("signResponse", signResponse)

const txClient = createTxServiceClient({
	baseUrl: "https://grpc.junotest.basementnodes.ca/"
})
const simulateRequest: SimulateRequest = create(SimulateRequestSchema, {
	txBytes: toBinary(MsgSendSchema, msgSend)
})
const simulateResponse = await txClient.simulate(simulateRequest)
console.log("simulateResponse", simulateResponse)

// txClient.broadcastTx({
// 	txBytes: toBinary(msgSend)
// })
