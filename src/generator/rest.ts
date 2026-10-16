import { posix } from "node:path"
import type { FileRegistry } from "@bufbuild/protobuf"
import { protobuf, wkt } from "./protobuf.js"

const specifier = (from: string, to: string) => {
	const path = posix.relative(posix.dirname(from), to)
	return path.startsWith(".") ? path : `./${path}`
}

type HttpRule = { pattern: { case?: string; value?: unknown }; body?: unknown }

export type Operation = {
	file: string
	service: string
	symbol: string
	method: string
	localName: string
	input: string
	output: string
	kind: "query" | "tx"
	transport: "rest" | "rpc" | "message"
	factory: string
	rpcFactory?: string
}
function httpRule(value: unknown): value is HttpRule {
	return (
		typeof value === "object" &&
		value !== null &&
		"pattern" in value &&
		typeof value.pattern === "object" &&
		value.pattern !== null
	)
}

/** Adds clients, registry, root index and operations.json beside the in-memory schemas. */
export function generateClients(
	files: Map<string, string>,
	registry: FileRegistry,
	cosmos: boolean
): Operation[] {
	const http = registry.getExtension("google.api.http")
	const registryImports: string[] = []
	const registryNames: string[] = []
	const operations: Operation[] = []
	for (const file of registry.files) {
		if (file.name.startsWith("google/protobuf/")) {
			const entry = Object.entries(wkt).find(
				([, value]) =>
					typeof value === "object" &&
					value !== null &&
					"kind" in value &&
					value.kind === "file" &&
					"proto" in value &&
					value.proto.name === file.proto.name
			)
			if (!entry)
				throw new Error(`Missing runtime well-known file: ${file.name}`)
			const alias = `f${registryNames.length}`
			registryImports.push(
				`import { ${entry[0]} as ${alias} } from "@bufbuild/protobuf/wkt"`
			)
			registryNames.push(alias)
			continue
		}
		const generated = files.get(`${file.name}_pb.ts`)
		const fileName = generated?.match(/export const (file_\w+):/)?.[1]
		if (!generated || !fileName)
			throw new Error(`Missing generated file export: ${file.name}`)
		const alias = `f${registryNames.length}`
		registryImports.push(
			`import { ${fileName} as ${alias} } from "./${file.name}_pb.js"`
		)
		registryNames.push(alias)
		const clientPath = `${file.name}_client.ts`
		const serviceExports = [
			...generated.matchAll(/export const ([\w$]+): GenService/g)
		].map((match) => match[1])
		const lines: string[] = []
		const services = new Set<string>()
		let usesRest = false
		let usesRpc = false
		let usesMessages = false
		for (const [index, service] of file.services.entries()) {
			const symbol = serviceExports[index]
			if (!symbol)
				throw new Error(`Missing generated service export: ${service.typeName}`)
			const describe = (method: (typeof service.methods)[number]) => ({
				file: file.name,
				service: service.typeName,
				symbol,
				method: method.name,
				localName: method.localName,
				input: method.input.typeName,
				output: method.output.typeName
			})
			const call = (method: (typeof service.methods)[number]) =>
				`${method.localName}: UnaryCall<typeof ${symbol}.method.${method.localName}.input, typeof ${symbol}.method.${method.localName}.output>`
			if (cosmos && service.name === "Msg") {
				usesMessages = true
				services.add(symbol)
				lines.push("export const messages: {")
				for (const method of service.methods)
					lines.push(
						`${method.localName}: (input: MessageInitShape<typeof ${symbol}.method.${method.localName}.input>) => Any`
					)
				lines.push("} = {")
				for (const method of service.methods) {
					lines.push(
						`${method.localName}: message(${symbol}.method.${method.localName}.input),`
					)
					operations.push({
						...describe(method),
						kind: "tx",
						transport: "message",
						factory: "messages"
					})
				}
				lines.push("}")
				continue
			}
			const methods: string[] = []
			const signatures: string[] = []
			for (const method of service.methods) {
				if (method.methodKind !== "unary" || !method.proto.options || !http)
					continue
				const rule = protobuf.getExtension(method.proto.options, http)
				if (
					!httpRule(rule) ||
					typeof rule.pattern.value !== "string" ||
					!["get", "post", "put", "patch", "delete"].includes(
						rule.pattern.case ?? ""
					)
				)
					continue
				const binding = {
					method: rule.pattern.case?.toUpperCase(),
					path: rule.pattern.value,
					body: typeof rule.body === "string" ? rule.body : ""
				}
				signatures.push(call(method))
				methods.push(
					`${method.localName}: bindRest({ ...config, registry: config.registry ?? registry }, ${symbol}.method.${method.localName}, ${JSON.stringify(binding)}),`
				)
				operations.push({
					...describe(method),
					kind:
						rule.pattern.case === "get" || service.name === "Query"
							? "query"
							: "tx",
					transport: "rest",
					factory: `create${service.name}Client`
				})
			}
			if (methods.length) {
				usesRest = true
				services.add(symbol)
				lines.push(
					`export function create${service.name}Client(config: RestClientConfig): {`,
					...signatures,
					"} {",
					"return {",
					...methods,
					"}",
					"}"
				)
			}
			// Cosmos module queries are ABCI routes; arbitrary protobuf services,
			// transaction lookup, node-info and reflection are not assumed to be.
			if (cosmos && service.name === "Query") {
				usesRpc = true
				services.add(symbol)
				const unary = service.methods.filter(
					(method) => method.methodKind === "unary"
				)
				lines.push(
					`export function create${service.name}RpcClient(config: RestClientConfig): {`,
					...unary.map(call),
					"} {",
					"return {"
				)
				for (const method of unary) {
					lines.push(
						`${method.localName}: bindRpc(config, ${symbol}.method.${method.localName}),`
					)
					const operation = operations.find(
						(entry) =>
							entry.service === service.typeName && entry.method === method.name
					)
					if (operation) operation.rpcFactory = `create${service.name}RpcClient`
					else
						operations.push({
							...describe(method),
							kind: "query",
							transport: "rpc",
							factory: `create${service.name}RpcClient`
						})
				}
				lines.push("}", "}")
			}
		}
		if (!lines.length) continue
		const imports = ["// Generated by Pioneer. DO NOT EDIT."]
		if (usesRest || usesRpc)
			imports.push(
				`import { ${usesRest ? "bindRest, " : ""}type RestClientConfig, type UnaryCall } from "${specifier(clientPath, "runtime/rest.js")}"`
			)
		if (usesRest)
			imports.push(
				`import { registry } from "${specifier(clientPath, "registry.js")}"`
			)
		if (usesRpc)
			imports.push(
				`import { bindRpc } from "${specifier(clientPath, "runtime/rpc.js")}"`
			)
		if (usesMessages)
			imports.push(
				'import type { MessageInitShape } from "@bufbuild/protobuf"',
				'import type { Any } from "@bufbuild/protobuf/wkt"',
				`import { message } from "${specifier(clientPath, "runtime/message.js")}"`
			)
		imports.push(
			`import { ${[...services].join(", ")} } from "./${file.name.split("/").at(-1)}_pb.js"`
		)
		files.set(clientPath, `${[...imports, ...lines].join("\n")}\n`)
	}
	files.set(
		"registry.ts",
		`// Generated by Pioneer. DO NOT EDIT.\nimport { createRegistry, type Registry } from "@bufbuild/protobuf"\n${registryImports.join("\n")}\nexport const registry: Registry = createRegistry(${registryNames.join(", ")})\n`
	)
	files.set(
		"index.ts",
		`export * from "./runtime/rest.js"\nexport * from "./runtime/rpc.js"\nexport * from "./runtime/message.js"\n${cosmos ? 'export * from "./runtime/transaction.js"\nexport * from "./runtime/comet.js"\n' : ""}export { create, fromBinary, toBinary, fromJson, toJson } from "@bufbuild/protobuf"\nexport type { DescMessage, DescMethodUnary, MessageInitShape, MessageShape, JsonValue } from "@bufbuild/protobuf"\nexport type { Any } from "@bufbuild/protobuf/wkt"\nexport { registry } from "./registry.js"\n`
	)
	operations.sort((a, b) =>
		`${a.service}/${a.method}`.localeCompare(`${b.service}/${b.method}`, "en")
	)
	files.set("operations.json", `${JSON.stringify(operations, null, 2)}\n`)
	return operations
}
