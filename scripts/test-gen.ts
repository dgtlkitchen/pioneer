import { join } from "node:path"
import { generate } from "../src/index.ts"
import type { ProtoGenOptions } from "../src/types/index.js"

const protoDirs = [join(process.cwd(), "proto")]
const moduleIgnoreList = ["cosmos/reflection", "cosmos/autocli"]
const outPath = join(process.cwd(), "generated")

const options: ProtoGenOptions = {
	modules: {
		grpc: true,
		grpcWeb: true,
		rest: true,
		rpc: true
	}
}

const runGen = async () => {
	try {
		await generate({ protoDirs, outPath, options, moduleIgnoreList })
		console.log("Generation complete!")
	} catch (error) {
		console.error("Generation failed:", error)
		process.exit(1)
	}
}

await runGen()
