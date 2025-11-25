import { generate, ProtoGenOptions } from "../src/generator/index.ts"


const outPath = new URL("../gen", import.meta.url).pathname
const moduleIgnoreList: string[] = []
const grpcEndpoint =
	process.env.PIONEER_GRPC_ENDPOINT ?? "http://localhost:9090"

const options: ProtoGenOptions = {
	grpcEndpoint,
	modules: {
		common: true,
		grpc: true,
		rest: true,
		rpc: true
	}
}

const runGen = async () => {
	try {
		await generate({ outPath, options, moduleIgnoreList })
		console.log("Generation complete!")
	} catch (error) {
		console.error("Generation failed:", error)
		process.exit(1)
	}
}

await runGen()
