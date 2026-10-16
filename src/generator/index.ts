import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promises as fs, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { FileDescriptorProto } from "@bufbuild/protobuf/wkt"
import { toolRoot } from "../paths.js"
import { checkPackage, emitPackage } from "./emit.js"
import { protobuf, wkt } from "./protobuf.js"
import { generateSchemas, generatorVersion } from "./protoc.js"
import { generateReact } from "./react.js"
import { generateClients } from "./rest.js"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const runtimeDependencies = {
	"@bufbuild/protobuf": "2.16.0",
	"@scure/base": "2.4.0"
}
const digest = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex")
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
const sha256 = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{64}$/.test(value)

export type GenerateOptions = {
	inputPath: string
	outputPath: string
	/** Additional Buf roots. Later descriptors override matching paths. */
	dependencyPaths?: string[]
	packageName?: string
	packageVersion?: string
	ignorePaths?: string[]
	react?: boolean
}

function packageVersion(name: string) {
	for (const request of [`${name}/package.json`, name]) {
		let directory: string
		try {
			directory = dirname(require.resolve(request))
		} catch {
			continue
		}
		for (;;) {
			try {
				const metadata: unknown = JSON.parse(
					readFileSync(join(directory, "package.json"), "utf8")
				)
				if (
					record(metadata) &&
					metadata.name === name &&
					typeof metadata.version === "string"
				)
					return metadata.version
			} catch {}
			const parent = dirname(directory)
			if (parent === directory) break
			directory = parent
		}
	}
	throw new Error(`Cannot resolve installed ${name} version`)
}

let toolchain: Record<string, string> | undefined
let tool: Promise<string> | undefined
/** Versions that shape emitted bytes or the strict check. */
function toolchainVersions(): Record<string, string> {
	const versions =
		toolchain ??
		Object.fromEntries([
			["generator", generatorVersion],
			...[
				"typescript",
				"rolldown",
				"@bufbuild/protobuf",
				"@scure/base",
				"@tanstack/react-query",
				"react",
				"@types/react"
			].map((name) => [name, packageVersion(name)])
		])
	toolchain = versions
	return versions
}
/** Generator code, runtime templates and toolchain: a change invalidates unchanged-input reuse. */
function toolDigest() {
	tool ??= (async () => {
		const hash = createHash("sha256")
		hash.update(JSON.stringify(toolchainVersions()))
		for (const [label, directory] of [
			["generator", dirname(fileURLToPath(import.meta.url))],
			["runtime", join(toolRoot, "src/runtime")]
		]) {
			for (const name of (await fs.readdir(directory))
				.filter((entry) => /\.(?:[cm]?js|ts)$/.test(entry))
				.sort()) {
				hash.update(`\0${label}/${name}\0`)
				hash.update(await fs.readFile(join(directory, name)))
			}
		}
		return hash.digest("hex")
	})()
	return tool
}

async function writeTree(root: string, files: ReadonlyMap<string, string>) {
	const directories = new Set<string>()
	for (const path of files.keys()) {
		let parent = posix.dirname(path)
		while (parent !== "." && !directories.has(parent)) {
			directories.add(parent)
			parent = posix.dirname(parent)
		}
	}
	await Promise.all(
		[...directories].map((directory) =>
			fs.mkdir(join(root, directory), { recursive: true })
		)
	)
	const entries = [...files]
	let next = 0
	await Promise.all(
		Array.from({ length: 64 }, async () => {
			while (next < entries.length) {
				const [path, text] = entries[next++]
				await fs.writeFile(join(root, path), text)
			}
		})
	)
}

export async function generate(options: GenerateOptions) {
	const input = resolve(options.inputPath)
	const output = resolve(options.outputPath)
	const name = options.packageName ?? "generated-protobuf-sdk"
	const version = options.packageVersion ?? "0.1.0"
	const react = options.react ?? false
	const finderMetadata: string[] = []
	const ignorePaths = (options.ignorePaths ?? []).map((path) =>
		path.replace(/\/$/, "")
	)
	if (
		ignorePaths.some(
			(path) => !/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(path)
		)
	)
		throw new Error("Ignored paths must be relative protobuf namespace paths")
	if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
		throw new Error("Invalid npm package name")
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
		throw new Error("Invalid package version")
	if (output === input || input.startsWith(`${output}/`))
		throw new Error("Output must not contain the input source")
	let previousInput: string | undefined
	let previousArtifacts: ReadonlyMap<string, string> | undefined
	try {
		const previous: unknown = JSON.parse(
			await fs.readFile(join(output, "provenance.json"), "utf8")
		)
		if (
			!record(previous) ||
			previous.pioneer !== 1 ||
			typeof previous.generator !== "string" ||
			!/^protoc-gen-es@\d+\.\d+\.\d+$/.test(previous.generator) ||
			(previous.inputSha256 !== undefined && !sha256(previous.inputSha256)) ||
			!sha256(previous.descriptorSha256) ||
			typeof previous.react !== "boolean" ||
			!Array.isArray(previous.sources) ||
			previous.sources.length === 0 ||
			!previous.sources.every(
				(source: unknown) =>
					record(source) &&
					typeof source.name === "string" &&
					source.name.length > 0 &&
					sha256(source.sha256)
			) ||
			!Array.isArray(previous.files) ||
			!previous.files.every((file: unknown) => typeof file === "string") ||
			!Array.isArray(previous.ignorePaths) ||
			!previous.ignorePaths.every(
				(path: unknown) => typeof path === "string"
			) ||
			!record(previous.artifacts)
		)
			throw new Error("Output is not a Pioneer-generated package")
		const artifacts = new Map<string, string>()
		const directories = new Set<string>()
		for (const [path, hash] of Object.entries(previous.artifacts)) {
			if (
				!sha256(hash) ||
				path === "provenance.json" ||
				path.includes("\\") ||
				path
					.split("/")
					.some(
						(part) => !part || part.startsWith(".") || part === "node_modules"
					)
			)
				throw new Error(`Invalid provenance artifact: ${path}`)
			artifacts.set(path, hash)
			for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
				directories.add(parent)
		}
		if (!artifacts.has("package.json"))
			throw new Error("Missing package identity in provenance artifacts")
		if (!(await fs.lstat(output)).isDirectory())
			throw new Error("Output must be a dedicated artifact directory")
		const seen = new Set<string>()
		const inspect = async (directory: string) => {
			for (const entry of await fs.readdir(join(output, directory), {
				withFileTypes: true
			})) {
				const path = directory ? `${directory}/${entry.name}` : entry.name
				if (entry.isDirectory()) {
					const metadataCount = finderMetadata.length
					await inspect(path)
					if (!directories.has(path) && finderMetadata.length === metadataCount)
						throw new Error(`Output contains unmanaged member: ${path}`)
					continue
				}
				if (!entry.isFile())
					throw new Error(`Output contains unmanaged member: ${path}`)
				// Finder metadata is retained but never published as SDK content.
				if (entry.name === ".DS_Store") {
					finderMetadata.push(path)
					continue
				}
				if (path === "provenance.json") continue
				// Recorded hashes are trusted; content edits are left to version control.
				if (!artifacts.has(path))
					throw new Error(`Output contains unmanaged file: ${path}`)
				seen.add(path)
			}
		}
		await inspect("")
		// Deleted artifacts are simply written again.
		const deleted = [...artifacts.keys()].filter((path) => !seen.has(path))
		for (const path of deleted) artifacts.delete(path)
		const metadata: unknown = deleted.includes("package.json")
			? { name, version }
			: JSON.parse(await fs.readFile(join(output, "package.json"), "utf8"))
		if (
			!record(metadata) ||
			metadata.name !== name ||
			typeof metadata.version !== "string" ||
			!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)
		)
			throw new Error(
				"Output package identity does not match the requested package"
			)
		if (typeof previous.inputSha256 === "string" && !deleted.length)
			previousInput = previous.inputSha256
		previousArtifacts = artifacts
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error
		try {
			await fs.access(output)
			throw new Error(
				"Refusing to replace an existing non-generated output directory"
			)
		} catch (missing) {
			if (
				!(
					missing instanceof Error &&
					"code" in missing &&
					missing.code === "ENOENT"
				)
			)
				throw missing
		}
	}
	const temporary = await fs.mkdtemp(join(tmpdir(), "pioneer-"))
	try {
		const buf = [
			...(process.versions.bun ? ["--no-env-file", "--no-install"] : []),
			require.resolve("@bufbuild/buf/bin/buf")
		]
		const roots = [
			input,
			...(options.dependencyPaths ?? []).map((path) => resolve(path))
		]
		const builds = await Promise.allSettled(
			roots.map(async (path, index) => {
				const descriptorPath = join(temporary, `${index}.bin`)
				await exec(
					process.execPath,
					[
						...buf,
						"build",
						path,
						"--as-file-descriptor-set",
						"-o",
						descriptorPath
					],
					{ timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }
				)
				const bytes = await fs.readFile(descriptorPath)
				if (bytes.length > 32 * 1024 * 1024)
					throw new Error("Descriptor set exceeds 32 MiB")
				return bytes
			})
		)
		const sources = []
		const files = new Map<string, FileDescriptorProto>()
		for (const [index, build] of builds.entries()) {
			if (build.status === "rejected") throw build.reason
			sources.push({
				name: basename(roots[index]),
				sha256: digest(build.value)
			})
			for (const file of protobuf.fromBinary(
				wkt.FileDescriptorSetSchema,
				build.value
			).file)
				files.set(file.name, file)
		}
		for (const path of files.keys()) {
			if (
				ignorePaths.some(
					(ignore) =>
						path === `${ignore}.proto` || path.startsWith(`${ignore}/`)
				)
			)
				files.delete(path)
		}
		const ordered: FileDescriptorProto[] = []
		const visited = new Set<string>()
		const visiting = new Set<string>()
		const visit = (name: string) => {
			if (visited.has(name)) return
			const file = files.get(name)
			if (!file || visiting.has(name))
				throw new Error(`Missing or cyclic descriptor: ${name}`)
			visiting.add(name)
			for (const dependency of file.dependency) visit(dependency)
			visiting.delete(name)
			visited.add(name)
			ordered.push(file)
		}
		for (const name of [...files.keys()].sort()) visit(name)
		const descriptors = protobuf.create(wkt.FileDescriptorSetSchema, {
			file: ordered
		})
		const descriptorSha256 = digest(
			protobuf.toBinary(wkt.FileDescriptorSetSchema, descriptors)
		)
		const result = {
			outputPath: output,
			packageName: name,
			files: files.size,
			descriptorSha256
		}
		const inputSha256 = digest(
			JSON.stringify({
				tool: await toolDigest(),
				sources,
				descriptorSha256,
				name,
				version,
				react,
				ignorePaths
			})
		)
		// Verified, unchanged output for identical inputs and toolchain: nothing to do.
		if (previousInput === inputSha256) return result
		const registry = protobuf.createFileRegistry(descriptors)
		const cosmos =
			registry.getMessage("cosmos.tx.v1beta1.SignDoc") !== undefined
		const packageFiles = generateSchemas(ordered, registry)
		await Promise.all(
			[
				...[
					"rest.ts",
					"rpc.ts",
					"message.ts",
					...(cosmos ? ["transaction.ts", "comet.ts"] : [])
				].map((file) => [`runtime/${file}`, file]),
				...(react
					? [
							["react/context.ts", "react-context.ts"],
							["react/options.ts", "react-options.ts"]
						]
					: [])
			].map(async ([target, source]) =>
				packageFiles.set(
					target,
					await fs.readFile(join(toolRoot, "src/runtime", source), "utf8")
				)
			)
		)
		const operations = generateClients(packageFiles, registry, cosmos)
		if (react)
			for (const [path, text] of generateReact(operations))
				packageFiles.set(path, text)
		packageFiles.set(
			"package.json",
			`${JSON.stringify(
				{
					name,
					version,
					type: "module",
					license: "UNLICENSED",
					sideEffects: false,
					files: [
						"dist",
						"operations.json",
						"provenance.json",
						"README.md",
						...(react ? ["react/hooks.json"] : [])
					],
					exports: {
						".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
						"./package.json": "./package.json",
						"./operations.json": "./operations.json",
						...(react
							? {
									"./react": {
										types: "./dist/react/index.d.ts",
										import: "./dist/react/index.js"
									},
									"./react/hooks.json": "./react/hooks.json"
								}
							: {}),
						"./*": { types: "./dist/*.d.ts", import: "./dist/*.js" }
					},
					dependencies: runtimeDependencies,
					...(react
						? {
								peerDependencies: {
									react: "^19.3.0",
									"@tanstack/react-query": "^5.102.8"
								},
								peerDependenciesMeta: {
									react: { optional: true },
									"@tanstack/react-query": { optional: true }
								}
							}
						: {})
				},
				null,
				2
			)}\n`
		)
		packageFiles.set(
			"README.md",
			`# ${name}

Generated by Pioneer from Buf descriptors. ESM JavaScript and declarations are in dist.
Import *_pb modules for codecs, *_client modules for typed REST/ABCI clients.
Cosmos Msg constructors pack transactions; they never send unsigned writes.
Methods without HTTP annotations have no invented REST route.

Regenerate through Pioneer; do not edit generated files. See provenance.json for
descriptor and artifact hashes. Two pinned runtime dependencies, with no transitive
runtime dependencies at these versions. The generated package contains no CLI,
Node transport, wallet secret, database or installation hook.

Before publication the owner must approve source/generated-code licensing, choose
release metadata, review npm pack --dry-run, and explicitly authorize publishing.
UNLICENSED is deliberate, not an MIT license claim.
${cosmos ? "\nCosmos DIRECT helpers do not discover account identity, choose fees, or authorize signing. Chain-specific signature envelopes belong to the consuming application.\n" : ""}
${
	react
		? `## React hooks: required TanStack Query setup

The shipped React hooks require React and @tanstack/react-query (see this
package's optional peer dependency ranges). Every component using a generated
query or mutation hook must be inside a **QueryClientProvider**. The SDK does
not create a global QueryClient or install a provider for you. Reuse your app's
existing provider rather than adding a separate SDK cache.

Read TanStack Query's official **latest React [Quick Start](https://tanstack.com/query/latest/docs/framework/react/quick-start)**
and [installation guide](https://tanstack.com/query/latest/docs/framework/react/installation).
For SSR, also follow the [advanced SSR guide](https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr):
isolate QueryClients per server request and use the framework's dehydration/hydration integration.
Never share one module-global server cache between users.

\`\`\`tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Suspense, useState, type ReactNode } from "react"

export function SdkQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<p>Loading chain data...</p>}>
        {children}
      </Suspense>
    </QueryClientProvider>
  )
}
\`\`\`

Mount this above components using the hooks listed in react/hooks.json. Keep the
client stable across renders. The Suspense boundary is below the provider because
generated query hooks use useSuspenseQuery; add your application's error boundary
for query failures. For advanced SSR, use your framework's provider/client lifecycle
rather than treating this minimal wrapper as a complete server setup.

Import hooks from this package's react/<module>/... subpaths. The plain
createChainHookContext network object is **not** the TanStack provider. Generated
Msg mutations additionally need an explicit signer/submission context; installing
a QueryClientProvider does not supply a wallet or authorize transactions.
`
		: ""
}`
		)
		const emitted = await emitPackage(packageFiles)
		await checkPackage({
			root: output,
			sources: packageFiles,
			emitted,
			resolveFrom: join(toolRoot, "package.json"),
			runtimes: [
				...Object.keys(runtimeDependencies),
				...(react ? ["react", "@tanstack/react-query"] : [])
			],
			toolchain: toolchainVersions()
		})
		const artifacts = new Map(
			[...packageFiles, ...emitted].sort(([a], [b]) =>
				a < b ? -1 : a > b ? 1 : 0
			)
		)
		const hashes = new Map(
			[...artifacts].map(([path, text]) => [path, digest(text)])
		)
		// Everything above ran in memory, so a failure has not touched the output.
		// Update it in place: remove stale files, write changed ones, then record
		// provenance. An interrupted update fails the next verification; restore
		// the output from version control.
		await fs.mkdir(output, { recursive: true })
		const stale = [...(previousArtifacts?.keys() ?? [])].filter(
			(path) => !artifacts.has(path)
		)
		await Promise.all(stale.map((path) => fs.unlink(join(output, path))))
		const emptied = new Set<string>()
		for (const path of stale)
			for (
				let parent = posix.dirname(path);
				parent !== ".";
				parent = posix.dirname(parent)
			)
				emptied.add(parent)
		// Deepest first; directories still holding files (or Finder metadata) stay.
		for (const directory of [...emptied].sort((a, b) => b.length - a.length)) {
			try {
				await fs.rmdir(join(output, directory))
			} catch (error) {
				if (!(error instanceof Error && "code" in error)) throw error
				if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error
			}
		}
		await writeTree(
			output,
			new Map(
				[...artifacts].filter(
					([path]) => previousArtifacts?.get(path) !== hashes.get(path)
				)
			)
		)
		await fs.writeFile(
			join(output, "provenance.json"),
			`${JSON.stringify({ pioneer: 1, sources, descriptorSha256, files: [...files.keys()].sort(), ignorePaths, react, generator: generatorVersion, inputSha256, artifacts: Object.fromEntries(hashes) }, null, 2)}\n`
		)
		return result
	} finally {
		await fs.rm(temporary, { recursive: true, force: true })
	}
}
