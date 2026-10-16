import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
	copyFile,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	writeFile
} from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const schemas = {
	"google/api/http.proto": `syntax="proto3"; package google.api;
message HttpRule { string selector=1; oneof pattern { string get=2; string put=3; string post=4; string delete=5; string patch=6; } string body=7; repeated HttpRule additional_bindings=11; string response_body=12; }`,
	"google/api/annotations.proto": `syntax="proto3"; package google.api;
import "google/api/http.proto"; import "google/protobuf/descriptor.proto";
extend google.protobuf.MethodOptions { HttpRule http=72295728; }`,
	"cosmos/base/v1beta1/coin.proto": `syntax="proto3"; package cosmos.base.v1beta1; message Coin { string denom=1; string amount=2; }`,
	"cosmos/tx/signing/v1beta1/signing.proto": `syntax="proto3"; package cosmos.tx.signing.v1beta1; enum SignMode { SIGN_MODE_UNSPECIFIED=0; SIGN_MODE_DIRECT=1; }`,
	"cosmos/tx/v1beta1/tx.proto": `syntax="proto3"; package cosmos.tx.v1beta1;
import "google/protobuf/any.proto"; import "cosmos/base/v1beta1/coin.proto"; import "cosmos/tx/signing/v1beta1/signing.proto";
message SignDoc { bytes body_bytes=1; bytes auth_info_bytes=2; string chain_id=3; uint64 account_number=4; }
message TxRaw { bytes body_bytes=1; bytes auth_info_bytes=2; repeated bytes signatures=3; }
message TxBody { repeated google.protobuf.Any messages=1; string memo=2; uint64 timeout_height=3; }
message AuthInfo { repeated SignerInfo signer_infos=1; Fee fee=2; }
message SignerInfo { google.protobuf.Any public_key=1; ModeInfo mode_info=2; uint64 sequence=3; }
message ModeInfo { oneof sum { Single single=1; } message Single { cosmos.tx.signing.v1beta1.SignMode mode=1; } }
message Fee { repeated cosmos.base.v1beta1.Coin amount=1; uint64 gas_limit=2; string payer=3; string granter=4; }`,
	"example/v1/service.proto": `syntax="proto3"; package example.v1; import "google/api/annotations.proto";
message MsgSend { string sender=1; bytes payload=2; } message MsgSendResponse { uint64 sequence=1; }
message QueryGetRequest { string name=1; uint64 height=2; } message QueryGetResponse { bytes value=1; uint64 height=2; }
service Msg { rpc Send(MsgSend) returns (MsgSendResponse); }
service Query { rpc Get(QueryGetRequest) returns (QueryGetResponse) { option (google.api.http).get="/example/v1/records/{name}"; } }`
}

function inside(root, path) {
	const suffix = relative(root, path)
	assert(
		suffix !== "" &&
			!isAbsolute(suffix) &&
			suffix !== ".." &&
			!suffix.startsWith(`..${sep}`),
		"Validate fixture path: target escapes disposable root"
	)
}

function member(path) {
	assert(
		typeof path === "string" &&
			path.length < 4096 &&
			!/[\\:]/.test(path) &&
			Array.from(path).every((character) => character.charCodeAt(0) > 31) &&
			!isAbsolute(path),
		"Validate fixture member: unsafe path"
	)
	assert(
		path
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== ".."),
		"Validate fixture member: unsafe segment"
	)
	return path
}

async function file(root, path) {
	member(path)
	const parts = path.split("/")
	let absolute = root
	for (let index = 0; index < parts.length; index += 1) {
		absolute = join(absolute, parts[index])
		const info = await lstat(absolute)
		assert(
			!info.isSymbolicLink(),
			"Validate fixture file: link traversal is forbidden"
		)
		assert(
			index === parts.length - 1 ? info.isFile() : info.isDirectory(),
			"Validate fixture file: unexpected member type"
		)
	}
	inside(root, await realpath(absolute))
	return absolute
}

async function json(path) {
	const info = await lstat(path)
	assert(
		info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024,
		"Read fixture JSON: expected a regular file below eight MiB"
	)
	return JSON.parse(await readFile(path, "utf8"))
}

async function sha256(path) {
	const info = await lstat(path)
	assert(
		info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024,
		"Hash fixture file: expected a bounded regular file"
	)
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex")
}

async function prepare(config) {
	const parent = await realpath(dirname(config.root))
	assert.equal(
		parent,
		resolve(dirname(config.root)),
		"Prepare fixture root: parent contains links"
	)
	assert.equal(
		await realpath(config.prefix),
		resolve(config.prefix),
		"Prepare installed prefix: unexpected link"
	)
	assert(
		Array.isArray(config.consumer) &&
			config.consumer.length > 0 &&
			config.consumer.length <= 50000,
		"Prepare runtime closure: missing or oversized accepted inventory"
	)
	const seen = new Set()
	for (const entry of config.consumer) {
		assert(
			entry && typeof entry === "object" && !Array.isArray(entry),
			"Prepare runtime closure: expected a member object"
		)
		assert.deepEqual(
			Object.keys(entry).sort(),
			["path", "sha256", "source"],
			"Prepare runtime closure: unexpected member fields"
		)
		member(entry.path)
		member(entry.source)
		assert(
			entry.path.startsWith("node_modules/"),
			"Prepare runtime closure: unexpected destination"
		)
		assert.match(entry.sha256, /^[a-f0-9]{64}$/)
		const normalized = entry.path.normalize("NFC").toLowerCase()
		assert(
			!seen.has(normalized),
			"Prepare runtime closure: duplicate destination"
		)
		seen.add(normalized)
	}
	await mkdir(config.root, { recursive: false })
	await writeFile(
		join(config.root, "package.json"),
		'{"private":true,"type":"module"}\n',
		{ flag: "wx", mode: 0o644 }
	)
	for (const [path, source] of Object.entries(schemas)) {
		const target = join(config.root, "proto", path)
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, source, { flag: "wx", mode: 0o644 })
	}
	for (const entry of config.consumer) {
		const source = await file(config.prefix, entry.source)
		assert.equal(
			await sha256(source),
			entry.sha256,
			"Prepare runtime closure: source digest differs from approval"
		)
		const target = join(config.root, entry.path)
		await mkdir(dirname(target), { recursive: true })
		await copyFile(source, target, constants.COPYFILE_EXCL)
		assert.equal(
			await sha256(target),
			entry.sha256,
			"Prepare runtime closure: copy changed bytes"
		)
	}
}

async function windowsInterpreter() {
	const systemRoot = process.env.SystemRoot
	const command = process.env.ComSpec
	for (const path of [systemRoot, command]) {
		assert(
			typeof path === "string" &&
				/^[A-Za-z]:[\\/]/.test(path) &&
				isAbsolute(path) &&
				Array.from(path).every(
					(character) =>
						character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127
				),
			"Validate Windows interpreter: expected an absolute local system path"
		)
		assert(
			path.split(/[\\/]/).every((part) => part !== "." && part !== ".."),
			"Validate Windows interpreter: unsafe path segment"
		)
	}
	for (const path of [systemRoot, join(systemRoot, "System32")]) {
		const info = await lstat(path)
		assert(
			info.isDirectory() && !info.isSymbolicLink(),
			"Validate Windows interpreter: system directory contains a link"
		)
		assert.equal(
			(await realpath(path)).toLowerCase(),
			resolve(path).toLowerCase(),
			"Validate Windows interpreter: system directory is not canonical"
		)
	}
	const expected = join(systemRoot, "System32", "cmd.exe")
	for (const path of [expected, command]) {
		const info = await lstat(path)
		assert(
			info.isFile() && !info.isSymbolicLink(),
			"Validate Windows interpreter: expected a regular cmd.exe"
		)
	}
	const canonical = await realpath(expected)
	assert.equal(
		(await realpath(command)).toLowerCase(),
		canonical.toLowerCase(),
		"Validate Windows interpreter: ComSpec does not identify native cmd.exe"
	)
	assert.equal(
		resolve(command).toLowerCase(),
		canonical.toLowerCase(),
		"Validate Windows interpreter: ComSpec is not canonical"
	)
	return canonical
}

async function cli(config, interpreter) {
	const args = [
		"--input-path",
		"proto",
		"--output-path",
		"sdk",
		"--package-name",
		"@example/cold-sdk",
		"--react"
	]
	const options = {
		cwd: config.root,
		timeout: 120000,
		maxBuffer: 4 * 1024 * 1024,
		env: process.env
	}
	if (process.platform === "win32") {
		assert(
			typeof interpreter === "string",
			"Invoke installed CLI: missing validated native interpreter"
		)
		return promisify(execFile)(
			interpreter,
			["/d", "/s", "/c", `pioneer.cmd ${args.join(" ")}`],
			options
		)
	}
	return promisify(execFile)("pioneer", args, options)
}

async function check(config) {
	const interpreter =
		process.platform === "win32" ? await windowsInterpreter() : null
	const root = await realpath(config.root)
	assert.equal(
		root,
		resolve(config.root),
		"Check fixture root: unexpected link"
	)
	assert.equal(
		process.env.NODE_PATH,
		undefined,
		"Check runtime environment: NODE_PATH is forbidden"
	)
	assert.equal(
		process.env.NODE_OPTIONS,
		undefined,
		"Check runtime environment: NODE_OPTIONS is forbidden"
	)
	const require = createRequire(join(root, "package.json"))
	for (const entry of config.consumer)
		assert.equal(
			await sha256(await file(root, entry.path)),
			entry.sha256,
			"Check runtime closure: copied dependency changed"
		)
	for (const name of [
		"@bufbuild/protobuf",
		"@scure/base",
		"react",
		"@tanstack/react-query"
	])
		inside(join(root, "node_modules"), await realpath(require.resolve(name)))
	const prefix = await realpath(config.prefix)
	assert.equal(
		prefix,
		resolve(config.prefix),
		"Check installed prefix: unexpected link"
	)
	const packageRoot =
		process.platform === "win32"
			? "node_modules/@vastward/pioneer"
			: "lib/node_modules/@vastward/pioneer"
	const packagePath = await file(prefix, `${packageRoot}/package.json`)
	const installed = await json(packagePath)
	assert.equal(
		installed.name,
		"@vastward/pioneer",
		"Check installed package: wrong name"
	)
	assert.equal(
		installed.version,
		"0.0.1",
		"Check installed package: wrong version"
	)
	assert.equal(
		installed.license,
		"Apache-2.0",
		"Check installed package: wrong license"
	)
	assert.deepEqual(installed.bin, { pioneer: "./dist/cli.js" })
	assert.deepEqual(installed.exports["."], {
		types: "./dist/types/index.d.ts",
		import: "./dist/index.js"
	})
	for (const path of [
		"LICENSE",
		"dist/cli.js",
		"dist/index.js",
		"dist/types/index.d.ts",
		"npm-shrinkwrap.json",
		...[
			"comet",
			"react-options",
			"transaction",
			"rest",
			"message",
			"rpc",
			"react-context"
		].map((name) => `src/runtime/${name}.ts`)
	])
		await file(prefix, `${packageRoot}/${path}`)
	const installedRequire = createRequire(packagePath)
	for (const name of [
		"@bufbuild/buf/bin/buf",
		"@bufbuild/protoc-gen-es/bin/protoc-gen-es",
		"typescript"
	])
		inside(
			join(prefix, packageRoot),
			await realpath(installedRequire.resolve(name))
		)
	inside(prefix, await realpath(config.bin))
	assert.equal(
		process.env.PATH.split(sep === "\\" ? ";" : ":")[0],
		dirname(config.bin),
		"Check installed bin: PATH does not prioritize accepted prefix"
	)
	const expectedName = process.platform === "win32" ? "pioneer.cmd" : "pioneer"
	assert.equal(
		config.bin,
		join(dirname(config.bin), expectedName),
		"Check installed bin: wrong native command name"
	)
	const sdk = join(root, "sdk")
	const provenancePath = await file(root, "sdk/provenance.json")
	const before = await readFile(provenancePath)
	const provenance = await json(provenancePath)
	assert.equal(
		provenance.pioneer,
		1,
		"Check generated provenance: wrong schema"
	)
	assert.equal(
		provenance.generator,
		"protoc-gen-es@2.16.0",
		"Check generated provenance: wrong generator"
	)
	assert.match(provenance.descriptorSha256, /^[a-f0-9]{64}$/)
	assert(
		provenance.artifacts && Object.keys(provenance.artifacts).length > 0,
		"Check generated provenance: missing inventory"
	)
	for (const [path, expected] of Object.entries(provenance.artifacts))
		assert.equal(
			await sha256(await file(sdk, path)),
			expected,
			"Check generated member: digest mismatch"
		)
	const manifest = await json(join(sdk, "package.json"))
	assert.equal(manifest.name, "@example/cold-sdk")
	assert.deepEqual(manifest.exports["."], {
		types: "./dist/index.d.ts",
		import: "./dist/index.js"
	})
	const corruptPath = await file(sdk, "dist/index.js")
	const original = await readFile(corruptPath)
	try {
		await writeFile(corruptPath, "invalid fixture bytes\n")
		await assert.rejects(cli(config, interpreter), /modified\/unmanaged/)
		assert.deepEqual(await readFile(provenancePath), before)
	} finally {
		await writeFile(corruptPath, original)
	}
	const missing = join(root, "removed-member.js")
	await rename(corruptPath, missing)
	try {
		await assert.rejects(cli(config, interpreter), /missing recorded artifact/)
		assert.deepEqual(await readFile(provenancePath), before)
	} finally {
		await rename(missing, corruptPath)
	}
	const runtime = await import(pathToFileURL(join(sdk, "dist/index.js")).href)
	const transaction = await import(
		pathToFileURL(join(sdk, "dist/cosmos/tx/v1beta1/tx_pb.js")).href
	)
	const service = await import(
		pathToFileURL(join(sdk, "dist/example/v1/service_client.js")).href
	)
	const messages = await import(
		pathToFileURL(join(sdk, "dist/example/v1/service_pb.js")).href
	)
	const hooks = await import(
		pathToFileURL(join(sdk, "dist/react/example/tx/use-send.js")).href
	)
	const { create, fromBinary, toBinary } = await import(
		pathToFileURL(require.resolve("@bufbuild/protobuf")).href
	)
	const { AnySchema } = await import(
		pathToFileURL(require.resolve("@bufbuild/protobuf/wkt")).href
	)
	const hash = "AB".repeat(32)
	const request = { sender: "vast1fixture", payload: new Uint8Array([1, 2]) }
	const response = create(AnySchema, {
		typeUrl: "/example.v1.MsgSendResponse",
		value: toBinary(
			messages.MsgSendResponseSchema,
			create(messages.MsgSendResponseSchema, { sequence: 9007199254740993n })
		)
	})
	const signal = new AbortController().signal
	const receipt = await hooks
		.sendNativeMutationOptions({
			chainId: "fixture-1",
			rpc: { baseUrl: "https://fixture.invalid" },
			signerAddress: request.sender,
			capability: "native-tx-v1",
			submitNative: async (input) => {
				assert.equal(input.signal, signal)
				assert.deepEqual(input.message, service.messages.send(request))
				return { hash, height: 9007199254740993n, responses: [response] }
			}
		})
		.mutationFn({ request, signal })
	assert.equal(receipt.hash, hash)
	assert.equal(receipt.height, 9007199254740993n)
	assert.deepEqual(receipt.responses, [response])
	assert.equal(receipt.response.sequence, 9007199254740993n)
	const envelope = (result) =>
		new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))
	const query = service.createQueryRpcClient({
		baseUrl: "https://fixture.invalid",
		fetch: async () =>
			envelope({
				response: { code: 17, codespace: "fixture", log: "query rejected" }
			})
	})
	await assert.rejects(
		query.get({ name: "fixture" }),
		(error) =>
			error instanceof runtime.AbciQueryError &&
			error.code === 17 &&
			error.codespace === "fixture" &&
			error.log === "query rejected" &&
			error.path === "/example.v1.Query/Get"
	)
	for (const preAborted of [true, false]) {
		const controller = new AbortController()
		const reason = new Error("fixture cancellation")
		if (preAborted) controller.abort(reason)
		const client = runtime.createCometClient({
			baseUrl: "https://fixture.invalid",
			fetch: async (_url, init) => {
				if (!preAborted) controller.abort(reason)
				assert.equal(init.signal.reason, reason)
				init.signal.throwIfAborted()
				throw new Error("Check cancellation: request continued after abort")
			}
		})
		await assert.rejects(
			client.transaction(hash, { signal: controller.signal }),
			(error) => error === reason
		)
	}
	const signDoc = fromBinary(
		transaction.SignDocSchema,
		runtime.createDirectSignDoc({
			chainId: "fixture-1",
			accountNumber: 9007199254740993n,
			sequence: 7n,
			messages: [service.messages.send(request)],
			fee: {
				amount: [{ denom: "ucred", amount: "9007199254740993" }],
				gasLimit: 200000n,
				payer: request.sender
			},
			timeoutHeight: 99n
		})
	)
	const auth = fromBinary(transaction.AuthInfoSchema, signDoc.authInfoBytes)
	assert.equal(auth.fee.amount[0].amount, "9007199254740993")
	assert.equal(auth.fee.gasLimit, 200000n)
	assert.equal(signDoc.accountNumber, 9007199254740993n)
	const raw = fromBinary(
		transaction.TxRawSchema,
		runtime.assembleTransaction(
			toBinary(transaction.SignDocSchema, signDoc),
			new Uint8Array([8, 9])
		)
	)
	assert.deepEqual(raw.bodyBytes, signDoc.bodyBytes)
	assert.deepEqual(raw.authInfoBytes, signDoc.authInfoBytes)
	const included = runtime.createCometClient({
		baseUrl: "https://fixture.invalid",
		fetch: async () =>
			envelope({
				hash,
				height: "9",
				tx_result: { code: 0, codespace: "", log: "included", data: "AQI=" }
			})
	})
	const actual = await included.transaction(hash)
	assert.equal(
		actual.codespace,
		"",
		"Check Comet receipt: runtime lost codespace"
	)
	assert.equal(actual.log, "included", "Check Comet receipt: runtime lost log")
	assert.equal(
		actual.data,
		"AQI=",
		"Check Comet receipt: runtime lost result data"
	)
	const zero = runtime.createCometClient({
		baseUrl: "https://fixture.invalid",
		fetch: async () => envelope({ hash, height: "0", tx_result: { code: 0 } })
	})
	await assert.rejects(
		zero.transaction(hash),
		"Check Comet receipt: zero height must not qualify as inclusion"
	)
	assert.match(config.referenceSha256, /^[a-f0-9]{64}$/)
	return {
		identity: config.identity,
		candidateSha256: config.candidateSha256,
		referenceSha256: config.referenceSha256,
		toolchain: config.toolchain,
		bin: config.bin,
		checks: [
			"assets",
			"provenance",
			"runtime",
			"receipt",
			"cancellation",
			"abci",
			"fees",
			"corruption",
			"missing-member"
		]
	}
}

const [mode, inputFlag, inputPath, outputFlag, outputPath, ...extra] =
	process.argv.slice(2)
assert(
	extra.length === 0 &&
		inputFlag === "--input" &&
		outputFlag === "--output" &&
		["prepare", "check"].includes(mode),
	"Invoke fixture: expected prepare|check --input PATH --output PATH"
)
assert(
	inputPath && outputPath && resolve(inputPath) !== resolve(outputPath),
	"Invoke fixture: input and output must differ"
)
const config = await json(inputPath)
assert(
	config && typeof config === "object" && !Array.isArray(config),
	"Read fixture input: expected an object"
)
assert.equal(typeof config.root, "string")
assert.equal(typeof config.prefix, "string")
assert(
	isAbsolute(config.root) && isAbsolute(config.prefix),
	"Read fixture input: paths must be absolute"
)
for (const [parent, child] of [
	[config.root, config.prefix],
	[config.prefix, config.root]
]) {
	const suffix = relative(resolve(parent), resolve(child))
	assert(
		isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`),
		"Read fixture input: installed and consumer roots must not overlap"
	)
}
const result = mode === "prepare" ? await prepare(config) : await check(config)
await writeFile(
	outputPath,
	`${JSON.stringify(result ?? { prepared: true })}\n`,
	{ flag: "wx", mode: 0o644 }
)
