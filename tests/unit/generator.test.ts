import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import ts from "typescript"
import { generate } from "../../src/generator/index.js"
import { generateReact } from "../../src/generator/react.js"
import { toolRoot } from "../../src/paths.js"
import { createCometClient } from "../../src/runtime/comet.js"

// Strict-check results are cached by content; keep this run's cache disposable.
process.env.PIONEER_CACHE_DIR = await fs.mkdtemp(
	join(tmpdir(), "pioneer-test-cache-")
)

function cometClient(height: unknown, fields: Record<string, unknown>) {
	return createCometClient({
		baseUrl: "https://fixture.invalid",
		fetch: async () =>
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: { hash: "AB".repeat(32), height, tx_result: fields }
				})
			)
	})
}

test("Comet transaction preserves supplied metadata and bigint height", async () => {
	const cases: {
		code: number
		codespace?: string
		log?: string
		data?: string | null
	}[] = [
		{ code: 0, codespace: "", log: "included", data: "AQI=" },
		{ code: 17, codespace: "sdk", log: "rejected", data: "" },
		{ code: 0, data: null },
		{ code: 0 }
	]
	for (const fields of cases) {
		const client = cometClient("9007199254740993", fields)
		expect(await client.transaction("ab".repeat(32))).toEqual({
			hash: "AB".repeat(32),
			height: 9007199254740993n,
			code: fields.code,
			codespace: fields.codespace,
			log: fields.log,
			data: fields.data
		})
	}
})

test("Comet transaction rejects malformed supplied metadata", async () => {
	for (const fields of [
		{ codespace: null },
		{ codespace: 1 },
		{ log: null },
		{ log: false },
		{ data: 2 },
		{ data: [] }
	]) {
		const client = cometClient("9", { code: 0, ...fields })
		await expect(client.transaction("AB".repeat(32))).rejects.toThrow(
			"Malformed Comet transaction"
		)
	}
})

test("Comet transaction requires a canonical positive inclusion height", async () => {
	for (const height of ["0", "-1", "01", 0]) {
		const client = cometClient(height, { code: 0 })
		await expect(client.transaction("AB".repeat(32))).rejects.toThrow(
			"Malformed Comet transaction result"
		)
	}
	const client = cometClient("1", { code: 0 })
	expect((await client.transaction("AB".repeat(32)))?.height).toBe(1n)
})

test("generic input produces a compiled package, with stable regeneration and safe failure", async () => {
	const temporary = await fs.mkdtemp(join(tmpdir(), "pioneer-test-"))
	try {
		const input = join(temporary, "proto")
		const output = join(temporary, "sdk")
		await fs.cp(join(toolRoot, "tests/fixtures/proto"), input, {
			recursive: true
		})
		const options = {
			inputPath: input,
			outputPath: output,
			packageName: "@example/sdk"
		}
		const first = await generate(options)
		expect(first.files).toBe(1)
		const manifest = JSON.parse(
			await fs.readFile(join(output, "package.json"), "utf8")
		)
		expect(manifest.name).toBe("@example/sdk")
		expect(manifest.exports["."].types).toBe("./dist/index.d.ts")
		expect(manifest.exports["./operations.json"]).toBe("./operations.json")
		expect(
			JSON.parse(await fs.readFile(join(output, "operations.json"), "utf8"))
		).toEqual([])
		expect(manifest.dependencies).toEqual({
			"@bufbuild/protobuf": "2.16.0",
			"@scure/base": "2.4.0"
		})
		await expect(
			fs.stat(join(output, "runtime/transaction.ts"))
		).rejects.toMatchObject({ code: "ENOENT" })
		await expect(
			fs.stat(join(output, "example/v1/example_client.ts"))
		).rejects.toMatchObject({ code: "ENOENT" })
		const before = await fs.readFile(join(output, "provenance.json"), "utf8")
		expect(JSON.parse(before).inputSha256).toMatch(/^[0-9a-f]{64}$/)
		// The strict check of this exact content is recorded for reuse.
		expect(
			(
				await fs.readdir(
					join(process.env.PIONEER_CACHE_DIR ?? "", "typecheck-v1")
				)
			).length
		).toBeGreaterThan(0)
		const unchanged = (await fs.stat(join(output, "provenance.json"))).mtimeMs
		await fs.writeFile(join(output, ".DS_Store"), "synthetic Finder metadata")
		expect((await generate(options)).descriptorSha256).toBe(
			first.descriptorSha256
		)
		// Unchanged verified input is a no-op: nothing is rewritten or staged.
		expect((await fs.stat(join(output, "provenance.json"))).mtimeMs).toBe(
			unchanged
		)
		// A different requested version regenerates in place: only changed files
		// are rewritten, and the new identity is recorded.
		const untouched = (await fs.stat(join(output, "dist/index.js"))).mtimeMs
		await generate({ ...options, packageVersion: "0.2.0" })
		expect(
			JSON.parse(await fs.readFile(join(output, "package.json"), "utf8"))
				.version
		).toBe("0.2.0")
		expect((await fs.stat(join(output, "dist/index.js"))).mtimeMs).toBe(
			untouched
		)
		await generate(options)
		expect(await fs.readFile(join(output, "provenance.json"), "utf8")).toBe(
			before
		)
		expect(await fs.readFile(join(output, ".DS_Store"), "utf8")).toBe(
			"synthetic Finder metadata"
		)
		// Resolve already-approved runtimes from a temporary consumer, without
		// installing dependencies or placing node_modules in the generated SDK.
		await fs.symlink(
			join(toolRoot, "node_modules"),
			join(temporary, "node_modules"),
			"dir"
		)
		const sdk = await import(pathToFileURL(join(output, "dist/index.js")).href)
		const schema = sdk.registry.getMessage("example.v1.Record")
		const value = sdk.fromJson(schema, {
			name: "example",
			pagination: { total: "9007199254740993", key: "AQI=" },
			labels: { snake_key: "unchanged" }
		})
		expect(value.pagination.total).toBe(9007199254740993n)
		expect(value.pagination.key).toEqual(new Uint8Array([1, 2]))
		expect(value.labels.snake_key).toBe("unchanged")
		const provenance = JSON.parse(before)
		// A deleted artifact is regenerated, byte-identical.
		for (const path of Object.keys(provenance.artifacts)) {
			const target = join(output, path)
			const bytes = await fs.readFile(target)
			await fs.unlink(target)
			await generate(options)
			expect((await fs.readFile(target)).equals(bytes)).toBe(true)
			expect(await fs.readFile(join(output, "provenance.json"), "utf8")).toBe(
				before
			)
		}
		// Recorded hashes are trusted: content edits are not read back, so they
		// survive an unchanged regeneration and are left to version control.
		const readme = await fs.readFile(join(output, "README.md"))
		await fs.writeFile(join(output, "README.md"), "owner modification")
		await generate(options)
		expect(await fs.readFile(join(output, "README.md"), "utf8")).toBe(
			"owner modification"
		)
		await fs.writeFile(join(output, "README.md"), readme)
		for (const path of ["unmanaged.txt", "dist/.hidden", "dist/extra.js"]) {
			await fs.writeFile(join(output, path), "unmanaged")
			try {
				await expect(generate(options)).rejects.toThrow("unmanaged")
			} finally {
				await fs.unlink(join(output, path))
			}
		}
		await fs.mkdir(join(output, "unmanaged-directory"))
		await expect(generate(options)).rejects.toThrow("unmanaged")
		await fs.rmdir(join(output, "unmanaged-directory"))
		await fs.symlink(join(output, "README.md"), join(output, "unmanaged-link"))
		await expect(generate(options)).rejects.toThrow("unmanaged")
		await fs.unlink(join(output, "unmanaged-link"))
		for (const invalid of [
			null,
			{ ...provenance, pioneer: 2 },
			{ ...provenance, generator: "unreviewed-generator" },
			{ ...provenance, descriptorSha256: "invalid" },
			{ ...provenance, inputSha256: "invalid" },
			{ ...provenance, sources: [{ name: "proto", sha256: "invalid" }] },
			{ ...provenance, artifacts: {} },
			{ ...provenance, artifacts: { "../outside": "a".repeat(64) } },
			{ ...provenance, artifacts: { "package.json": false } }
		]) {
			await fs.writeFile(
				join(output, "provenance.json"),
				JSON.stringify(invalid)
			)
			try {
				await expect(generate(options)).rejects.toThrow()
			} finally {
				await fs.writeFile(join(output, "provenance.json"), before)
			}
		}
		await expect(
			generate({ ...options, packageName: "@other/sdk" })
		).rejects.toThrow("package identity")
		expect(await fs.readFile(join(output, "provenance.json"), "utf8")).toBe(
			before
		)
		await fs.writeFile(join(input, "broken.proto"), "not a protobuf file")
		await expect(generate(options)).rejects.toThrow()
		expect(await fs.readFile(join(output, "provenance.json"), "utf8")).toBe(
			before
		)
	} finally {
		await fs.rm(temporary, { recursive: true, force: true })
	}
}, 120_000)

test("compiled CLI exposes the requested flags without reading an environment file", async () => {
	const { stdout } = await promisify(execFile)(
		"node",
		[join(toolRoot, "dist/cli.js"), "--help"],
		{ cwd: tmpdir(), timeout: 10_000 }
	)
	expect(stdout).toContain("--input-path")
	expect(stdout).toContain("--output-path")
	expect(stdout).toContain("--package-name")
	expect(stdout).toContain("--ignore-path")
	expect(stdout).toContain("--react")
	expect(stdout).toContain("--version")
	const metadata = JSON.parse(
		await fs.readFile(join(toolRoot, "package.json"), "utf8")
	)
	expect(metadata.name).toBe("@vastward/pioneer")
	expect(metadata.version).toBe("0.0.1")
	expect(metadata.license).toBe("Apache-2.0")
	expect(metadata.repository.url).toBe(
		"https://github.com/dgtlkitchen/pioneer.git"
	)
	const version = await promisify(execFile)(
		"node",
		[join(toolRoot, "dist/cli.js"), "--version"],
		{ cwd: tmpdir(), timeout: 10_000 }
	)
	expect(version.stdout.trim()).toBe(`${metadata.name} ${metadata.version}`)
	const helpAndVersion = await promisify(execFile)(
		"node",
		[join(toolRoot, "dist/cli.js"), "--help", "--version"],
		{ cwd: tmpdir(), timeout: 10_000 }
	)
	expect(helpAndVersion.stdout).toBe(stdout)
	for (const args of [[], ["--version", "--unknown-option"]]) {
		await expect(
			promisify(execFile)("node", [join(toolRoot, "dist/cli.js"), ...args], {
				cwd: tmpdir(),
				timeout: 10_000
			})
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining(
				args.length ? "Unknown option" : "--input-path and --output-path"
			)
		})
	}
})

test("compiled CLI reads identity from its package root, not the working directory", async () => {
	const temporary = await fs.mkdtemp(join(tmpdir(), "pioneer-version-test-"))
	try {
		await fs.cp(join(toolRoot, "dist"), join(temporary, "dist"), {
			recursive: true
		})
		await fs.symlink(
			join(toolRoot, "node_modules"),
			join(temporary, "node_modules"),
			"dir"
		)
		const path = join(temporary, "package.json")
		const metadata = { type: "module", name: "@example/cli", version: "9.8.7" }
		await fs.writeFile(path, JSON.stringify(metadata))
		const command = () =>
			promisify(execFile)(
				"node",
				[join(temporary, "dist/cli.js"), "--version"],
				{ cwd: toolRoot, timeout: 10_000 }
			)
		expect((await command()).stdout.trim()).toBe("@example/cli 9.8.7")
		for (const invalid of [
			{ ...metadata, name: 1 },
			{ ...metadata, name: " " },
			{ ...metadata, version: null },
			{ ...metadata, version: "" }
		]) {
			await fs.writeFile(path, JSON.stringify(invalid))
			await expect(command()).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining("Invalid CLI package name or version")
			})
		}
	} finally {
		await fs.rm(temporary, { recursive: true, force: true })
	}
})

test("ignored namespaces are absent, optional React output does not change core dependencies", async () => {
	const temporary = await fs.mkdtemp(join(tmpdir(), "pioneer-react-test-"))
	try {
		const input = join(temporary, "proto")
		const output = join(temporary, "sdk")
		await fs.cp(join(toolRoot, "tests/fixtures/proto"), input, {
			recursive: true
		})
		await fs.mkdir(join(input, "excluded"))
		await fs.writeFile(
			join(input, "excluded", "service.proto"),
			'syntax="proto3"; package excluded; message Hidden {}'
		)
		const result = await generate({
			inputPath: input,
			outputPath: output,
			ignorePaths: ["excluded"],
			react: true
		})
		expect(result.files).toBe(1)
		await expect(fs.stat(join(output, "excluded"))).rejects.toMatchObject({
			code: "ENOENT"
		})
		const manifest = JSON.parse(
			await fs.readFile(join(output, "package.json"), "utf8")
		)
		expect(manifest.dependencies).toEqual({
			"@bufbuild/protobuf": "2.16.0",
			"@scure/base": "2.4.0"
		})
		expect(manifest.peerDependenciesMeta.react.optional).toBe(true)
		expect(manifest.exports["./react"].types).toBe("./dist/react/index.d.ts")
		expect(await fs.readFile(join(output, "index.ts"), "utf8")).not.toContain(
			"react"
		)
		const readme = await fs.readFile(join(output, "README.md"), "utf8")
		expect(readme).toContain("QueryClientProvider")
		expect(readme).toContain(
			"https://tanstack.com/query/latest/docs/framework/react/quick-start"
		)
		expect(readme).toContain("Never share one module-global server cache")
		const regeneration = {
			inputPath: input,
			outputPath: output,
			ignorePaths: ["excluded"],
			react: true
		}
		expect((await generate({ ...regeneration, ignorePaths: [] })).files).toBe(2)
		for (const directory of ["excluded", "dist/excluded"])
			await fs.writeFile(
				join(output, directory, ".DS_Store"),
				"retained namespace metadata"
			)
		expect((await generate(regeneration)).descriptorSha256).toBe(
			result.descriptorSha256
		)
		for (const directory of ["excluded", "dist/excluded"])
			expect(
				await fs.readFile(join(output, directory, ".DS_Store"), "utf8")
			).toBe("retained namespace metadata")
		expect((await generate(regeneration)).descriptorSha256).toBe(
			result.descriptorSha256
		)
		await fs.writeFile(join(output, "excluded/unmanaged.txt"), "unmanaged")
		await expect(generate(regeneration)).rejects.toThrow("unmanaged")
		await fs.unlink(join(output, "excluded/unmanaged.txt"))
		await fs.symlink(
			join(toolRoot, "node_modules"),
			join(temporary, "node_modules"),
			"dir"
		)
		const runtimeTests = join(temporary, "native.test.js")
		await fs.writeFile(runtimeTests, generatedRuntimeTests)
		const { stdout, stderr } = await promisify(execFile)(
			process.execPath,
			["--no-env-file", "--no-install", "test", runtimeTests],
			{ cwd: temporary, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
		)
		expect(`${stdout}\n${stderr}`).toContain("0 fail")
		const typeTests = join(temporary, "native-types.ts")
		await fs.writeFile(typeTests, generatedTypeTests)
		const program = ts.createProgram([typeTests], {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			noEmit: true,
			skipLibCheck: false,
			types: [],
			lib: ["lib.esnext.d.ts", "lib.dom.d.ts"]
		})
		expect(
			ts
				.getPreEmitDiagnostics(program)
				.map((diagnostic) =>
					ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
				)
		).toEqual([])
	} finally {
		await fs.rm(temporary, { recursive: true, force: true })
	}
}, 120_000)

test("license options publish the SPDX license and license files", async () => {
	const temporary = await fs.mkdtemp(join(tmpdir(), "pioneer-license-test-"))
	try {
		const input = join(temporary, "proto")
		const output = join(temporary, "sdk")
		await fs.cp(join(toolRoot, "tests/fixtures/proto"), input, {
			recursive: true
		})
		const notice = join(temporary, "NOTICE")
		await fs.writeFile(notice, "Synthetic notice\n")
		const options = {
			inputPath: input,
			outputPath: output,
			license: "Apache-2.0",
			licenseFiles: [join(toolRoot, "LICENSE"), notice]
		}
		await generate(options)
		const manifest = JSON.parse(
			await fs.readFile(join(output, "package.json"), "utf8")
		)
		expect(manifest.license).toBe("Apache-2.0")
		expect(manifest.files).toEqual(
			expect.arrayContaining(["LICENSE", "NOTICE"])
		)
		expect(await fs.readFile(join(output, "LICENSE"), "utf8")).toBe(
			await fs.readFile(join(toolRoot, "LICENSE"), "utf8")
		)
		const provenance = JSON.parse(
			await fs.readFile(join(output, "provenance.json"), "utf8")
		)
		expect(Object.keys(provenance.artifacts)).toEqual(
			expect.arrayContaining(["LICENSE", "NOTICE"])
		)
		const readme = await fs.readFile(join(output, "README.md"), "utf8")
		expect(readme).toContain(
			"Licensed under Apache-2.0; see LICENSE and NOTICE."
		)
		expect(readme).not.toContain("UNLICENSED")
		// Changing license text is an input change and regenerates the file.
		await fs.writeFile(notice, "Updated notice\n")
		await generate(options)
		expect(await fs.readFile(join(output, "NOTICE"), "utf8")).toBe(
			"Updated notice\n"
		)
		await expect(
			generate({ ...options, license: "Apache-2.0; rm" })
		).rejects.toThrow("Invalid package license")
		const readmeFile = join(temporary, "README.md")
		await fs.writeFile(readmeFile, "collision")
		await expect(
			generate({ ...options, licenseFiles: [readmeFile] })
		).rejects.toThrow("collides with generated file")
	} finally {
		await fs.rm(temporary, { recursive: true, force: true })
	}
}, 120_000)

test("message hooks add native signatures beside unchanged legacy operations", () => {
	const files = generateReact([
		{
			file: "example/v1/example",
			service: "example.v1.Msg",
			symbol: "Msg",
			method: "Send",
			localName: "send",
			input: "example.v1.Record",
			output: "example.v1.Record",
			kind: "tx",
			transport: "message",
			factory: "messages"
		}
	])
	const source = files.get("react/example/tx/use-send.ts") ?? ""
	expect(source).toContain(
		'export type SendResponse = Awaited<ReturnType<ChainTxContext["submit"]>>'
	)
	expect(source).toContain(
		"export function sendMutationOptions(context: ChainTxContext)"
	)
	// Included-transaction invalidation lives in the shared runtime hook.
	expect(source).toContain(
		"return useSdkMutation(context, sendMutationOptions(context))"
	)
	expect(source).toContain(
		"export type SendNativeResponse = NativeMessageReceipt<typeof Msg.method.send.output>"
	)
	expect(source).toContain(
		"sendNativeMutationOptions(context: NativeChainTxContext): NativeMessageMutationOptions<typeof Msg.method.send.input, typeof Msg.method.send.output>"
	)
	expect(source).toContain(
		"UseMutationResult<SendNativeResponse, Error, NativeMutationVariables<SendRequest>>"
	)
	expect(source).toContain(
		"return useSdkNativeMutation(sendNativeMutationOptions(context))"
	)
})

test("synthetic Cosmos schemas compile Msg hooks, clients, DIRECT and Comet runtimes", async () => {
	const temporary = await fs.mkdtemp(join(tmpdir(), "pioneer-cosmos-test-"))
	try {
		const input = join(temporary, "proto")
		const output = join(temporary, "sdk")
		for (const [path, source] of Object.entries(cosmosSchemas)) {
			const target = join(input, path)
			await fs.mkdir(dirname(target), { recursive: true })
			await fs.writeFile(target, source)
		}
		await generate({ inputPath: input, outputPath: output, react: true })
		const operations = JSON.parse(
			await fs.readFile(join(output, "operations.json"), "utf8")
		)
		expect(operations).toEqual([
			{
				file: "example/v1/service",
				service: "example.v1.Msg",
				symbol: "Msg",
				method: "Send",
				localName: "send",
				input: "example.v1.MsgSend",
				output: "example.v1.MsgSendResponse",
				kind: "tx",
				transport: "message",
				factory: "messages"
			},
			{
				file: "example/v1/service",
				service: "example.v1.Query",
				symbol: "Query",
				method: "Get",
				localName: "get",
				input: "example.v1.QueryGetRequest",
				output: "example.v1.QueryGetResponse",
				kind: "query",
				transport: "rest",
				factory: "createQueryClient",
				rpcFactory: "createQueryRpcClient"
			}
		])
		await fs.symlink(
			join(toolRoot, "node_modules"),
			join(temporary, "node_modules"),
			"dir"
		)
		const runtimeTests = join(temporary, "cosmos.test.js")
		await fs.writeFile(runtimeTests, cosmosRuntimeTests)
		const { stdout, stderr } = await promisify(execFile)(
			process.execPath,
			["--no-env-file", "--no-install", "test", runtimeTests],
			{ cwd: temporary, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
		)
		expect(`${stdout}\n${stderr}`).toContain("0 fail")
		const typeTests = join(temporary, "cosmos-types.ts")
		await fs.writeFile(typeTests, cosmosTypeTests)
		const program = ts.createProgram([typeTests], {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			noEmit: true,
			skipLibCheck: false,
			types: [],
			lib: ["lib.esnext.d.ts", "lib.dom.d.ts"]
		})
		expect(
			ts
				.getPreEmitDiagnostics(program)
				.map((diagnostic) =>
					ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
				)
		).toEqual([])
	} finally {
		await fs.rm(temporary, { recursive: true, force: true })
	}
}, 120_000)

// Canonical field numbers cover the consumed subset without ambient chain schemas.
const cosmosSchemas = {
	"google/api/http.proto": `syntax = "proto3";
package google.api;
message HttpRule {
  string selector = 1;
  oneof pattern {
    string get = 2;
    string put = 3;
    string post = 4;
    string delete = 5;
    string patch = 6;
  }
  string body = 7;
  repeated HttpRule additional_bindings = 11;
  string response_body = 12;
}`,
	"google/api/annotations.proto": `syntax = "proto3";
package google.api;
import "google/api/http.proto";
import "google/protobuf/descriptor.proto";
extend google.protobuf.MethodOptions { HttpRule http = 72295728; }`,
	"cosmos/base/v1beta1/coin.proto": `syntax = "proto3";
package cosmos.base.v1beta1;
message Coin { string denom = 1; string amount = 2; }`,
	"cosmos/tx/signing/v1beta1/signing.proto": `syntax = "proto3";
package cosmos.tx.signing.v1beta1;
enum SignMode { SIGN_MODE_UNSPECIFIED = 0; SIGN_MODE_DIRECT = 1; }`,
	"cosmos/tx/v1beta1/tx.proto": `syntax = "proto3";
package cosmos.tx.v1beta1;
import "google/protobuf/any.proto";
import "cosmos/base/v1beta1/coin.proto";
import "cosmos/tx/signing/v1beta1/signing.proto";
message SignDoc {
  bytes body_bytes = 1;
  bytes auth_info_bytes = 2;
  string chain_id = 3;
  uint64 account_number = 4;
}
message TxRaw {
  bytes body_bytes = 1;
  bytes auth_info_bytes = 2;
  repeated bytes signatures = 3;
}
message TxBody {
  repeated google.protobuf.Any messages = 1;
  string memo = 2;
  uint64 timeout_height = 3;
}
message AuthInfo { repeated SignerInfo signer_infos = 1; Fee fee = 2; }
message SignerInfo {
  google.protobuf.Any public_key = 1;
  ModeInfo mode_info = 2;
  uint64 sequence = 3;
}
message ModeInfo {
  oneof sum { Single single = 1; }
  message Single { cosmos.tx.signing.v1beta1.SignMode mode = 1; }
}
message Fee {
  repeated cosmos.base.v1beta1.Coin amount = 1;
  uint64 gas_limit = 2;
  string payer = 3;
  string granter = 4;
}`,
	"example/v1/service.proto": `syntax = "proto3";
package example.v1;
import "google/api/annotations.proto";
message MsgSend { string sender = 1; bytes payload = 2; }
message MsgSendResponse { uint64 sequence = 1; }
message QueryGetRequest { string name = 1; uint64 height = 2; }
message QueryGetResponse { bytes value = 1; uint64 height = 2; }
service Msg { rpc Send(MsgSend) returns (MsgSendResponse); }
service Query {
  rpc Get(QueryGetRequest) returns (QueryGetResponse) {
    option (google.api.http).get = "/example/v1/records/{name}";
  }
}`
}

const cosmosTypeTests = `
import type { NativeChainTxContext, ChainTxContext } from "./sdk/dist/react/context.js"
import { sendMutationOptions, sendNativeMutationOptions, useSendNative } from "./sdk/dist/react/example/tx/use-send.js"
import type { SendNativeResponse, SendRequest } from "./sdk/dist/react/example/tx/use-send.js"
type Assert<T extends true> = T
type Reject<A, B> = [A] extends [B] ? false : true
declare const native: NativeChainTxContext
declare const legacy: ChainTxContext
declare const signal: AbortSignal
export const result: Promise<SendNativeResponse> = sendNativeMutationOptions(native).mutationFn({ request: { sender: "vast1signer", payload: new Uint8Array([1]) }, signal })
export const legacyOptions = sendMutationOptions(legacy)
export type ResponseSequence = Assert<SendNativeResponse["response"]["sequence"] extends bigint ? true : false>
export type InvalidRequest = Assert<Reject<{ sender: number }, SendRequest>>
export type HookVariables = Assert<Reject<SendRequest, Parameters<ReturnType<typeof useSendNative>["mutate"]>[0]>>
`

const cosmosRuntimeTests = `
import { expect, test } from "bun:test"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { AnySchema } from "@bufbuild/protobuf/wkt"
import { base64 } from "@scure/base"
import { assembleTransaction, createDirectSignDoc, createCometClient, JsonRpcError, HttpError } from "./sdk/dist/index.js"
import { AuthInfoSchema, SignDocSchema, TxBodySchema, TxRawSchema } from "./sdk/dist/cosmos/tx/v1beta1/tx_pb.js"
import { SignMode } from "./sdk/dist/cosmos/tx/signing/v1beta1/signing_pb.js"
import { MsgSendSchema, MsgSendResponseSchema, QueryGetRequestSchema, QueryGetResponseSchema } from "./sdk/dist/example/v1/service_pb.js"
import { messages, createQueryClient, createQueryRpcClient } from "./sdk/dist/example/v1/service_client.js"
import { sendMutationOptions, sendNativeMutationOptions, useSendNative } from "./sdk/dist/react/example/tx/use-send.js"

const hash = "AB".repeat(32)
const envelope = result => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))
const failure = (code, data) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, data } }))

test("generated Msg factories and compiled hook options preserve legacy and native submission", async () => {
  const request = { sender: "vast1signer", payload: new Uint8Array([1, 2]) }
  const packed = messages.send(request)
  expect(packed.typeUrl).toBe("/example.v1.MsgSend")
  expect(fromBinary(MsgSendSchema, packed.value)).toEqual(create(MsgSendSchema, request))
  expect(typeof useSendNative).toBe("function")
  const provider = { chainId: "chain-1", rpc: { baseUrl: "https://rpc.example" }, signerAddress: request.sender }
  const legacyReceipt = { txResponse: { height: 9n, code: 0, txhash: hash } }
  let legacyCalls = 0
  expect(await sendMutationOptions({ ...provider, submit: async message => {
    legacyCalls++
    expect(message).toEqual(packed)
    return legacyReceipt
  } }).mutationFn(request)).toBe(legacyReceipt)
  expect(legacyCalls).toBe(1)
  const signal = new AbortController().signal
  let nativeCalls = 0
  const response = create(AnySchema, { typeUrl: "/example.v1.MsgSendResponse", value: toBinary(MsgSendResponseSchema, create(MsgSendResponseSchema, { sequence: 9007199254740993n })) })
  const result = await sendNativeMutationOptions({ ...provider, capability: "native-tx-v1", submitNative: async input => {
    nativeCalls++
    expect(input.message).toEqual(packed)
    expect(input.signal).toBe(signal)
    return { hash, height: 9n, responses: [response] }
  } }).mutationFn({ request, signal })
  expect(nativeCalls).toBe(1)
  expect(result.hash).toBe(hash)
  expect(result.height).toBe(9n)
  expect(result.response.sequence).toBe(9007199254740993n)
  expect(result.responses).toEqual([response])
})

test("generated annotated REST and ABCI query clients execute typed operations", async () => {
  const request = { name: "a/b", height: 9007199254740993n }
  const expected = create(QueryGetResponseSchema, { value: new Uint8Array([4, 5]), height: request.height })
  let restCalls = 0
  const rest = createQueryClient({ baseUrl: "https://rest.example", fetch: async (url, init) => {
    restCalls++
    expect(url.pathname).toBe("/example/v1/records/a%2Fb")
    expect(url.searchParams.get("height")).toBe("9007199254740993")
    expect(url.searchParams.has("name")).toBe(false)
    expect(init.method).toBe("GET")
    expect(init.body).toBeUndefined()
    expect(init.credentials).toBe("omit")
    expect(init.redirect).toBe("error")
    return new Response(JSON.stringify({ value: "BAU=", height: "9007199254740993" }))
  } })
  expect(await rest.get(request)).toEqual(expected)
  expect(restCalls).toBe(1)
  let rpcCalls = 0
  const rpc = createQueryRpcClient({ baseUrl: "https://rpc.example", fetch: async (_url, init) => {
    rpcCalls++
    const body = JSON.parse(init.body)
    expect(body.method).toBe("abci_query")
    expect(body.params.path).toBe("/example.v1.Query/Get")
    const bytes = Uint8Array.from(body.params.data.match(/../g), pair => Number.parseInt(pair, 16))
    expect(fromBinary(QueryGetRequestSchema, bytes)).toEqual(create(QueryGetRequestSchema, request))
    return envelope({ response: { code: 0, value: base64.encode(toBinary(QueryGetResponseSchema, expected)) } })
  } })
  expect(await rpc.get(request)).toEqual(expected)
  expect(rpcCalls).toBe(1)
})

test("DIRECT assembly preserves original noncanonical body and auth bytes", () => {
  const input = { chainId: "chain-1", accountNumber: 9007199254740993n, sequence: 7n, messages: [messages.send({ sender: "vast1signer" })], fee: { amount: [{ denom: "ucred", amount: "12" }], gasLimit: 200000n, payer: "vast1payer" }, memo: "memo", timeoutHeight: 99n }
  const doc = fromBinary(SignDocSchema, createDirectSignDoc(input))
  expect(doc.chainId).toBe(input.chainId)
  expect(doc.accountNumber).toBe(input.accountNumber)
  const body = fromBinary(TxBodySchema, doc.bodyBytes)
  expect(body.messages).toEqual(input.messages)
  expect(body.memo).toBe("memo")
  expect(body.timeoutHeight).toBe(99n)
  const auth = fromBinary(AuthInfoSchema, doc.authInfoBytes)
  expect(auth.signerInfos).toHaveLength(1)
  expect(auth.signerInfos[0].sequence).toBe(7n)
  expect(auth.signerInfos[0].modeInfo.sum).toMatchObject({ case: "single", value: { mode: SignMode.DIRECT } })
  expect(auth.fee.amount[0]).toMatchObject({ denom: "ucred", amount: "12" })
  expect(auth.fee.gasLimit).toBe(200000n)
  expect(auth.fee.payer).toBe("vast1payer")
  // Duplicate known fields and unknown fields detect decode/re-encode assembly.
  doc.bodyBytes = new Uint8Array([...doc.bodyBytes, 0x12, 1, 0x78, 0xa0, 0x06, 7])
  doc.authInfoBytes = new Uint8Array([...doc.authInfoBytes, ...toBinary(AuthInfoSchema, create(AuthInfoSchema, { fee: auth.fee })), 0xa0, 0x06, 9])
  expect(toBinary(TxBodySchema, fromBinary(TxBodySchema, doc.bodyBytes))).not.toEqual(doc.bodyBytes)
  expect(toBinary(AuthInfoSchema, fromBinary(AuthInfoSchema, doc.authInfoBytes))).not.toEqual(doc.authInfoBytes)
  const signature = new Uint8Array([8, 9])
  const raw = fromBinary(TxRawSchema, assembleTransaction(toBinary(SignDocSchema, doc), signature))
  expect(raw.bodyBytes).toEqual(doc.bodyBytes)
  expect(raw.authInfoBytes).toEqual(doc.authInfoBytes)
  expect(raw.signatures).toEqual([signature])
})

test("Comet status, broadcast and positive inclusion preserve hash matching and request bytes", async () => {
  const calls = []
  const client = createCometClient({ baseUrl: "https://rpc.example", fetch: async (_url, init) => {
    const request = JSON.parse(init.body)
    calls.push(request.method)
    expect(init.credentials).toBe("omit")
    expect(init.redirect).toBe("error")
    if (request.method === "status") return envelope({ node_info: { network: "chain-1" } })
    if (request.method === "broadcast_tx_sync") {
      expect(base64.decode(request.params.tx)).toEqual(new Uint8Array([1, 2]))
      return envelope({ hash: hash.toLowerCase(), code: 0 })
    }
    expect(request.method).toBe("tx")
    expect(base64.decode(request.params.hash)).toEqual(new Uint8Array(32).fill(0xab))
    expect(request.params.prove).toBe(false)
    return envelope({ hash: hash.toLowerCase(), height: "9007199254740993", tx_result: { code: 0 } })
  } })
  expect(await client.status()).toEqual({ chainId: "chain-1" })
  expect(await client.broadcastSync(new Uint8Array([1, 2]))).toMatchObject({ hash, code: 0 })
  expect(await client.transaction(hash.toLowerCase())).toMatchObject({ hash, height: 9007199254740993n, code: 0 })
  expect(calls).toEqual(["status", "broadcast_tx_sync", "tx"])
  const mismatch = createCometClient({ baseUrl: "https://rpc.example", fetch: async () => envelope({ hash: "CD".repeat(32), height: "9", tx_result: { code: 0 } }) })
  await expect(mismatch.transaction(hash)).rejects.toThrow("Mismatched Comet transaction hash")
})

test("Comet exact not-found is distinct from RPC, HTTP and transport failures", async () => {
  const absent = createCometClient({ baseUrl: "https://rpc.example", fetch: async () => failure(-32603, "tx (" + hash + ") not found") })
  expect(await absent.transaction(hash)).toBeUndefined()
  for (const [code, data] of [[-32603, "indexing disabled"], [-32603, "tx (" + "CD".repeat(32) + ") not found"], [-32602, "tx (" + hash + ") not found"]]) {
    const client = createCometClient({ baseUrl: "https://rpc.example", fetch: async () => failure(code, data) })
    await expect(client.transaction(hash)).rejects.toBeInstanceOf(JsonRpcError)
  }
  const http = createCometClient({ baseUrl: "https://rpc.example", fetch: async () => new Response("unavailable", { status: 503 }) })
  await expect(http.transaction(hash)).rejects.toBeInstanceOf(HttpError)
  const reason = new Error("transport disconnected")
  const transport = createCometClient({ baseUrl: "https://rpc.example", fetch: async () => { throw reason } })
  await expect(transport.transaction(hash)).rejects.toBe(reason)
})

test("Comet propagates cancellation for status, broadcast and transaction lookup", async () => {
  for (const operation of [client => client.status, client => options => client.broadcastSync(new Uint8Array([1]), options), client => options => client.transaction(hash, options)]) {
    for (const preAborted of [true, false]) {
      const controller = new AbortController()
      const reason = new Error("Comet cancelled")
      if (preAborted) controller.abort(reason)
      const client = createCometClient({ baseUrl: "https://rpc.example", fetch: async (_url, init) => {
        if (!preAborted) controller.abort(reason)
        expect(init.signal.aborted).toBe(true)
        expect(init.signal.reason).toBe(reason)
        init.signal.throwIfAborted()
        throw new Error("cancelled fetch unexpectedly continued")
      } })
      await expect(operation(client)({ signal: controller.signal })).rejects.toBe(reason)
    }
  }
})
`

const generatedTypeTests = `
import type { MessageInitShape } from "@bufbuild/protobuf"
import { Query, RecordSchema } from "./sdk/dist/example/v1/example_pb.js"
import type { ChainHookContext, ChainTxContext, NativeChainTxContext } from "./sdk/dist/react/context.js"
import { sdkMessageMutationOptions, sdkNativeMessageMutationOptions } from "./sdk/dist/react/options.js"
import type { NativeMessageMutationOptions, NativeMessageReceipt, NativeMutationVariables } from "./sdk/dist/react/options.js"
type Assert<T extends true> = T
type Reject<A, B> = [A] extends [B] ? false : true
type Request = MessageInitShape<typeof RecordSchema>
type Options = NativeMessageMutationOptions<typeof RecordSchema, typeof RecordSchema>
export type LegacyRejected = Assert<Reject<ChainTxContext, NativeChainTxContext>>
export type QueryRejected = Assert<Reject<ChainHookContext, NativeChainTxContext>>
export type SignalRequired = Assert<Reject<{ request: Request }, NativeMutationVariables<Request>>>
export type RequestRequired = Assert<Reject<{ signal: AbortSignal }, NativeMutationVariables<Request>>>
export type WrongRequestRejected = Assert<Reject<{ request: { name: number }; signal: AbortSignal }, NativeMutationVariables<Request>>>
export type NoScope = Assert<"scope" extends keyof Options ? false : true>
export type TypedName = Assert<NativeMessageReceipt<typeof RecordSchema>["response"]["name"] extends string ? true : false>
export type TypedHeight = Assert<NativeMessageReceipt<typeof RecordSchema>["height"] extends bigint ? true : false>
declare const native: NativeChainTxContext
declare const legacy: ChainTxContext
declare const signal: AbortSignal
declare const pack: (request: Request) => import("@bufbuild/protobuf/wkt").Any
export const nativeResult: Promise<NativeMessageReceipt<typeof RecordSchema>> = sdkNativeMessageMutationOptions(native, [], Query.method.get).mutationFn({ request: { name: "native" }, signal })
export const legacyOptions = sdkMessageMutationOptions(legacy, [], pack)
export type LegacyVariables = Assert<Reject<NativeMutationVariables<Request>, Parameters<NonNullable<typeof legacyOptions.mutationFn>>[0]>>
`

const generatedRuntimeTests = `
import { expect, test } from "bun:test"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { AnySchema } from "@bufbuild/protobuf/wkt"
import { QueryClient } from "@tanstack/react-query"
import { base64 } from "@scure/base"
import * as sdk from "./sdk/dist/index.js"
import { Query, RecordSchema } from "./sdk/dist/example/v1/example_pb.js"
import { requireNativeChainTxContext } from "./sdk/dist/react/context.js"
import { NativeResponseError, sdkKeys, sdkMessageMutationOptions, sdkNativeMessageMutationOptions, invalidateIncludedTransaction } from "./sdk/dist/react/options.js"
import { AbciQueryError, JsonRpcError, bindRpc } from "./sdk/dist/runtime/rpc.js"

const method = Query.method.get
const hash = "Ab".repeat(32)
const response = (value = new Uint8Array(), typeUrl = "/example.v1.Record") => create(AnySchema, { typeUrl, value })
const included = (responses = [response()]) => ({ hash, height: 9n, responses })
const context = (submitNative = async () => included()) => ({ chainId: "chain-1", rpc: { baseUrl: "https://rpc.example" }, signerAddress: "vast1signer", capability: "native-tx-v1", submitNative })
const variables = (request = {}) => ({ request, signal: new AbortController().signal })
const options = (provider = context()) => sdkNativeMessageMutationOptions(provider, sdkKeys.tx(provider, "example", "example.v1.Query/Get", provider.signerAddress), method)

test("legacy submission, variables, and included invalidation remain unchanged", async () => {
  let submitted
  const legacyReceipt = { txResponse: { height: 2n, code: 0, txhash: "legacy" } }
  const legacy = { ...context(), submit: async message => { submitted = message; return legacyReceipt } }
  const input = { name: "legacy" }
  const legacyOptions = sdkMessageMutationOptions(legacy, ["legacy"], request => sdk.message(RecordSchema)(request))
  expect(await legacyOptions.mutationFn(input)).toBe(legacyReceipt)
  expect(fromBinary(RecordSchema, submitted.value).name).toBe("legacy")
  expect(legacyOptions.retry).toBe(false)
  expect(legacyOptions.networkMode).toBe("always")
  expect(legacyOptions.gcTime).toBe(0)
  const cache = new QueryClient()
  const key = [...sdkKeys.all(legacy), "record"]
  cache.setQueryData(key, "value")
  await invalidateIncludedTransaction(cache, legacy, {})
  expect(cache.getQueryState(key).isInvalidated).toBe(false)
  await invalidateIncludedTransaction(cache, legacy, legacyReceipt)
  expect(cache.getQueryState(key).isInvalidated).toBe(true)
  cache.clear()
})

test("native keys exclude exact legacy defaults and retain explicit safe defaults", () => {
  const provider = context()
  const key = sdkKeys.tx(provider, "example", "example.v1.Query/Get", provider.signerAddress)
  const cache = new QueryClient()
  const legacyCallback = () => { throw new Error("legacy callback") }
  cache.setMutationDefaults(key, { onSuccess: legacyCallback, scope: { id: "legacy" } })
  const native = sdkNativeMessageMutationOptions(provider, key, method)
  expect(native.mutationKey).toEqual(["native-tx-v1", ...key])
  expect(cache.getMutationDefaults(native.mutationKey)).toEqual({})
  expect(native.retry).toBe(false)
  expect(native.networkMode).toBe("always")
  expect(native.gcTime).toBe(0)
  expect("scope" in native).toBe(false)
  expect("onSuccess" in native).toBe(false)
  // Actual application scope and persistence admission requires a separate consumer gate.
  cache.clear()
})

test("native capability rejects legacy, malformed providers, and later capability loss", async () => {
  let calls = 0
  const legacy = { chainId: "chain-1", rpc: { baseUrl: "https://rpc.example" }, signerAddress: "vast1signer", submit: async () => { calls++; return {} } }
  for (const invalid of [legacy, null, {}, { ...context(), capability: "native-tx-v2" }, { ...context(), submitNative: undefined }, { ...context(), signerAddress: " " }]) {
    expect(() => requireNativeChainTxContext(invalid)).toThrow()
    expect(() => options(invalid)).toThrow()
  }
  const provider = context(async () => { calls++; return included() })
  const native = options(provider)
  provider.capability = "legacy"
  await expect(native.mutationFn(variables())).rejects.toThrow("native-tx-v1")
  expect(calls).toBe(0)
})

test("missing signals, pre-abort, and wrong requests reject before submission", async () => {
  let calls = 0
  let reads = 0
  const request = { get name() { reads++; return "not packed" } }
  const native = options(context(async () => { calls++; return included() }))
  for (const invalid of [undefined, null, { request }, { request, signal: {} }]) {
    await expect(native.mutationFn(invalid)).rejects.toThrow("AbortSignal")
  }
  const controller = new AbortController()
  const reason = new Error("cancelled before preparation")
  controller.abort(reason)
  await expect(native.mutationFn({ request, signal: controller.signal })).rejects.toBe(reason)
  expect(reads).toBe(0)
  for (const invalid of [undefined, null, 4, [], { $typeName: "other.Request" }, { name: 42 }]) {
    await expect(native.mutationFn({ request: invalid, signal: new AbortController().signal })).rejects.toThrow()
  }
  expect(calls).toBe(0)
})

test("native packing detaches shared bytes, preserves unknown fields, and calls the adapter once", async () => {
  const shared = new Uint8Array(new SharedArrayBuffer(2))
  shared.set([1, 2])
  const request = fromBinary(RecordSchema, new Uint8Array([0xa0, 0x06, 0x07]))
  request.name = "before"
  request.pagination = create(RecordSchema.field.pagination.message, { key: shared, total: 9n })
  let captured
  let calls = 0
  const call = variables(request)
  const native = options(context(async input => {
    calls++
    captured = input
    await Promise.resolve()
    return included()
  }))
  const pending = native.mutationFn(call)
  request.name = "after"
  shared[0] = 9
  await pending
  expect(calls).toBe(1)
  expect(captured.signal).toBe(call.signal)
  expect(captured.message.typeUrl).toBe("/example.v1.Record")
  expect(captured.message.value.buffer instanceof ArrayBuffer).toBe(true)
  const packed = fromBinary(RecordSchema, captured.message.value)
  expect(packed.name).toBe("before")
  expect(packed.pagination.key).toEqual(new Uint8Array([1, 2]))
  expect(Array.from(toBinary(RecordSchema, packed)).slice(-3)).toEqual([0xa0, 0x06, 0x07])
})

test("cancellation or capability loss during packing prevents the callback", async () => {
  let calls = 0
  const controller = new AbortController()
  const reason = new Error("cancelled during packing")
  const provider = context(async () => { calls++; return included() })
  const native = options(provider)
  await expect(native.mutationFn({ request: { get name() { controller.abort(reason); return "cancelled" } }, signal: controller.signal })).rejects.toBe(reason)
  await expect(native.mutationFn(variables({ get name() { provider.capability = "legacy"; return "changed" } }))).rejects.toThrow("native-tx-v1")
  expect(calls).toBe(0)
})

test("confirmed receipts preserve hash, height, response bytes and Any unknown fields", async () => {
  const body = new Uint8Array([...toBinary(RecordSchema, create(RecordSchema, { name: "confirmed", pagination: { key: new Uint8Array([4, 5]) } })), 0xa0, 0x06, 0x07])
  const anyBytes = new Uint8Array([...toBinary(AnySchema, response(body)), 0xa0, 0x06, 0x09])
  const original = fromBinary(AnySchema, anyBytes)
  const shared = new Uint8Array(new SharedArrayBuffer(body.length))
  shared.set(body)
  original.value = shared
  const receipt = included([original])
  const result = await options(context(async () => receipt)).mutationFn(variables())
  shared.fill(0)
  expect(result.hash).toBe(hash)
  expect(result.height).toBe(9n)
  expect(result.response.name).toBe("confirmed")
  expect(result.responses).not.toBe(receipt.responses)
  expect(result.responses[0].value.buffer instanceof ArrayBuffer).toBe(true)
  expect(result.responses[0].value).toEqual(body)
  expect(toBinary(AnySchema, result.responses[0])).toEqual(anyBytes)
  expect(toBinary(RecordSchema, result.response)).toEqual(body)
  result.response.pagination.key.fill(0)
  expect(result.responses[0].value).toEqual(body)
})

test("count, exact URL, and decode failures retain complete validated inclusion", async () => {
  for (const responses of [[], [response(), response(new Uint8Array([1]))], [response(new Uint8Array(), "type.googleapis.com/example.v1.Record")], [response(new Uint8Array([0xff]))]]) {
    const receipt = included(responses)
    try {
      await options(context(async () => receipt)).mutationFn(variables())
      throw new Error("expected validation failure")
    } catch (error) {
      expect(error).toBeInstanceOf(NativeResponseError)
      expect(error.name).toBe("NativeResponseError")
      expect(error.txHash).toBe(hash)
      expect(error.height).toBe(9n)
      expect(error.receipt).toEqual(receipt)
      expect(error.receipt.responses.map(item => item.typeUrl)).toEqual(responses.map(item => item.typeUrl))
      expect(error.requestTypeUrl).toBe("/example.v1.Record")
      expect(error.responseTypeUrl).toBe("/example.v1.Record")
      expect(error.cause).toBeInstanceOf(Error)
    }
  }
})

test("malformed receipts expose only independently validated nullable identity", async () => {
  for (const receipt of [undefined, null, { txResponse: { height: 9n, txhash: hash } }, { hash }, { hash: "wrong", height: 9n, responses: [] }, { hash, height: 0n, responses: [] }, { hash, height: "9", responses: [] }, { hash, height: 9n, responses: {} }, { hash, height: 9n, responses: [null] }, { hash, height: 9n, responses: [{ $typeName: "google.protobuf.Any", typeUrl: "/example.v1.Record", value: [] }] }]) {
    try {
      await options(context(async () => receipt)).mutationFn(variables())
      throw new Error("expected validation failure")
    } catch (error) {
      expect(error).toBeInstanceOf(NativeResponseError)
      expect(error.receipt).toBeNull()
      expect(error.txHash).toBe(receipt?.hash === hash ? hash : null)
      expect(error.height).toBe(receipt?.height === 9n ? 9n : null)
      expect(error.cause).toBeInstanceOf(Error)
    }
  }
})

test("adapter rejection identity survives cancellation and post-broadcast uncertainty", async () => {
  for (const reason of [new Error("cancelled during signing", { cause: new Error("session changed") }), Object.assign(new Error("post-broadcast uncertainty"), { txHash: hash }), new DOMException("Aborted", "AbortError")]) {
    const controller = new AbortController()
    let calls = 0
    const native = options(context(async input => {
      calls++
      expect(input.signal).toBe(controller.signal)
      controller.abort(reason)
      throw reason
    }))
    await expect(native.mutationFn({ request: {}, signal: controller.signal })).rejects.toBe(reason)
    expect(calls).toBe(1)
  }
})

test("known inclusion wins over a later abort without a second submission", async () => {
  const controller = new AbortController()
  let calls = 0
  const native = options(context(async () => {
    calls++
    controller.abort(new Error("owner disposed after inclusion"))
    return included()
  }))
  const result = await native.mutationFn({ request: {}, signal: controller.signal })
  expect(result.hash).toBe(hash)
  expect(result.height).toBe(9n)
  expect(calls).toBe(1)
})

const query = (abci, inspect = () => {}) => bindRpc({ baseUrl: "https://rpc.example", fetch: async (url, init) => {
  inspect(url, init)
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { response: abci } }))
}}, method)

test("ABCI error identity uses one root/direct constructor and preserves validated fields before decoding", async () => {
  expect(sdk.AbciQueryError).toBe(AbciQueryError)
  for (const fields of [{ code: 7, codespace: "onboarding", log: "reservation expired" }, { code: 0xffffffff, codespace: "", log: "" }]) {
    try {
      await query({ ...fields, value: "not base64" })({})
      throw new Error("expected ABCI error")
    } catch (error) {
      expect(error).toBeInstanceOf(AbciQueryError)
      expect(error.name).toBe("AbciQueryError")
      expect(error.path).toBe("/example.v1.Query/Get")
      expect(error.code).toBe(fields.code)
      expect(error.codespace).toBe(fields.codespace)
      expect(error.log).toBe(fields.log)
    }
  }
  const cause = new Error("original")
  expect(new AbciQueryError("/query", { code: 1, codespace: "", log: "" }, { cause }).cause).toBe(cause)
})

test("ABCI malformed codes and supplied error fields reject without fabricated identity", async () => {
  const cases = [
    ...["1", null, -1, 1.5, 0x100000000].map(code => ({ code, codespace: "", log: "", value: "" })),
    { code: 1, log: "" }, { code: 1, codespace: "" },
    { code: 1, codespace: null, log: "" }, { code: 1, codespace: "", log: 1 },
    { code: 0, codespace: 2, value: "" }, { log: false, value: "" }
  ]
  for (const abci of cases) {
    try {
      await query(abci)({})
      throw new Error("expected malformed ABCI failure")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(AbciQueryError)
      expect(error.message).toContain("/example.v1.Query/Get")
      expect(error.message).toContain("Invalid ABCI")
    }
  }
})

test("zero and omitted ABCI codes preserve decoding and transport request safeguards", async () => {
  const value = base64.encode(toBinary(RecordSchema, create(RecordSchema, { name: "read" })))
  let calls = 0
  const inspect = (url, init) => {
    calls++
    expect(url.href).toBe("https://rpc.example/")
    expect(init.credentials).toBe("omit")
    expect(init.redirect).toBe("error")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body).params.path).toBe("/example.v1.Query/Get")
  }
  for (const fields of [{}, { code: 0 }, { code: 0, codespace: "", log: "" }]) {
    expect((await query({ ...fields, value }, inspect)({})).name).toBe("read")
  }
  expect(calls).toBe(3)
  expect((await query({ value: null })({})).name).toBe("")
  for (const invalid of [{}, { value: 1 }, { value: "%%%" }, { value: base64.encode(new Uint8Array([0xff])) }]) {
    await expect(query(invalid)({})).rejects.toThrow("Invalid ABCI value at /example.v1.Query/Get")
  }
})

test("RPC retains envelope, HTTP, size, URL, limits, JSON-RPC error and cancellation checks", async () => {
  for (const baseUrl of ["ftp://rpc.example", "https://user:secret@rpc.example", "https://rpc.example?q=1", "https://rpc.example/#fragment"]) {
    expect(() => bindRpc({ baseUrl }, method)).toThrow("Invalid chain RPC")
  }
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { maxResponseBytes: -1 }]) {
    expect(() => bindRpc({ baseUrl: "https://rpc.example", ...limits }, method)).toThrow("limits")
  }
  for (const envelope of [{ jsonrpc: "1.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, error: { code: "bad" } }]) {
    const call = bindRpc({ baseUrl: "https://rpc.example", fetch: async () => new Response(JSON.stringify(envelope)) }, method)
    await expect(call({})).rejects.toThrow()
  }
  const jsonRpc = bindRpc({ baseUrl: "https://rpc.example", fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, data: "detail" } })) }, method)
  await expect(jsonRpc({})).rejects.toBeInstanceOf(JsonRpcError)
  const http = bindRpc({ baseUrl: "https://rpc.example", fetch: async () => new Response("failed", { status: 503 }) }, method)
  await expect(http({})).rejects.toThrow()
  const oversized = bindRpc({ baseUrl: "https://rpc.example", maxResponseBytes: 1, fetch: async () => new Response("too large") }, method)
  await expect(oversized({})).rejects.toThrow()
  const controller = new AbortController()
  const reason = new Error("query cancelled")
  controller.abort(reason)
  const cancelled = bindRpc({ baseUrl: "https://rpc.example", fetch: async (_url, init) => { init.signal.throwIfAborted(); throw new Error("unexpected request") } }, method)
  await expect(cancelled({}, { signal: controller.signal })).rejects.toBe(reason)
})
`
