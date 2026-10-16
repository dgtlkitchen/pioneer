import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import {
	create,
	createFileRegistry,
	fromBinary,
	toBinary
} from "@bufbuild/protobuf"
import {
	type FileDescriptorProto,
	FileDescriptorSetSchema
} from "@bufbuild/protobuf/wkt"
import ts from "typescript"
import { toolRoot } from "../paths.js"
import { generateReact } from "./react.js"
import { generateClients } from "./rest.js"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const runtimeDependencies = {
	"@bufbuild/protobuf": "2.10.1",
	"@scure/base": "2.0.0"
}
const digest = (bytes: Uint8Array) =>
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

function compilePackage(stage: string, react = false) {
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		declaration: true,
		noEmitOnError: true,
		skipLibCheck: false,
		rootDir: stage,
		outDir: join(stage, "dist"),
		types: [],
		lib: ["lib.esnext.d.ts", "lib.dom.d.ts"]
	}
	const host = ts.createCompilerHost(options)
	// Check against the tool's pinned runtimes; generation does not install packages.
	host.resolveModuleNames = (names, containingFile) =>
		names.map((name) => {
			const runtime = [
				...Object.keys(runtimeDependencies),
				...(react ? ["react", "@tanstack/react-query"] : [])
			].some(
				(dependency) => name === dependency || name.startsWith(`${dependency}/`)
			)
			return ts.resolveModuleName(
				name,
				runtime ? join(toolRoot, "package.json") : containingFile,
				options,
				host
			).resolvedModule
		})
	const program = ts.createProgram(
		ts.sys.readDirectory(stage, [".ts"], ["dist", "node_modules"]),
		options,
		host
	)
	const diagnostics = ts.getPreEmitDiagnostics(program)
	if (diagnostics.length)
		throw new Error(
			ts.formatDiagnosticsWithColorAndContext(diagnostics, {
				getCanonicalFileName: (file) => file,
				getCurrentDirectory: () => stage,
				getNewLine: () => "\n"
			})
		)
	if (program.emit().emitSkipped)
		throw new Error("Generated package emission failed")
}

export async function generate(options: GenerateOptions) {
	const input = resolve(options.inputPath)
	const output = resolve(options.outputPath)
	const name = options.packageName ?? "generated-protobuf-sdk"
	const version = options.packageVersion ?? "0.1.0"
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
	try {
		const previous: unknown = JSON.parse(
			await fs.readFile(join(output, "provenance.json"), "utf8")
		)
		if (
			!record(previous) ||
			previous.pioneer !== 1 ||
			previous.generator !== "protoc-gen-es@2.10.1" ||
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
						throw new Error(
							`Output contains modified/unmanaged member: ${path}`
						)
					continue
				}
				if (!entry.isFile())
					throw new Error(`Output contains modified/unmanaged member: ${path}`)
				// Finder metadata is retained but never published as SDK content.
				if (entry.name === ".DS_Store") {
					finderMetadata.push(path)
					continue
				}
				if (path === "provenance.json") continue
				if (
					artifacts.get(path) !== digest(await fs.readFile(join(output, path)))
				)
					throw new Error(`Output contains modified/unmanaged file: ${path}`)
				seen.add(path)
			}
		}
		await inspect("")
		for (const path of artifacts.keys())
			if (!seen.has(path))
				throw new Error(`Output is missing recorded artifact: ${path}`)
		const metadata: unknown = JSON.parse(
			await fs.readFile(join(output, "package.json"), "utf8")
		)
		if (
			!record(metadata) ||
			metadata.name !== name ||
			typeof metadata.version !== "string" ||
			!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)
		)
			throw new Error(
				"Output package identity does not match the requested package"
			)
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
	const backup = `${output}.previous`
	try {
		const sources = []
		const files = new Map<string, FileDescriptorProto>()
		const buf = [
			...(process.versions.bun ? ["--no-env-file", "--no-install"] : []),
			require.resolve("@bufbuild/buf/bin/buf")
		]
		for (const [index, path] of [
			input,
			...(options.dependencyPaths ?? []).map((path) => resolve(path))
		].entries()) {
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
			sources.push({ name: basename(path), sha256: digest(bytes) })
			for (const file of fromBinary(FileDescriptorSetSchema, bytes).file)
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
		const descriptors = create(FileDescriptorSetSchema, { file: ordered })
		const registry = createFileRegistry(descriptors)
		const descriptorBytes = toBinary(FileDescriptorSetSchema, descriptors)
		const descriptorPath = join(temporary, "descriptor.bin")
		await fs.writeFile(descriptorPath, descriptorBytes)
		const stage = join(temporary, "gen")
		const template = {
			version: "v2",
			plugins: [
				{
					local: [
						process.execPath,
						require.resolve("@bufbuild/protoc-gen-es/bin/protoc-gen-es")
					],
					out: stage,
					include_imports: true,
					opt: ["target=ts", "import_extension=js"]
				}
			]
		}
		await exec(
			process.execPath,
			[
				...buf,
				"generate",
				descriptorPath,
				"--template",
				JSON.stringify(template)
			],
			{ timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }
		)
		await fs.mkdir(join(stage, "runtime"), { recursive: true })
		const cosmos =
			registry.getMessage("cosmos.tx.v1beta1.SignDoc") !== undefined
		for (const file of [
			"rest.ts",
			"rpc.ts",
			"message.ts",
			...(cosmos ? ["transaction.ts", "comet.ts"] : [])
		])
			await fs.copyFile(
				join(toolRoot, "src/runtime", file),
				join(stage, "runtime", file)
			)
		const operations = await generateClients(stage, registry, cosmos)
		if (options.react) {
			await fs.mkdir(join(stage, "react"), { recursive: true })
			await fs.copyFile(
				join(toolRoot, "src/runtime/react-context.ts"),
				join(stage, "react/context.ts")
			)
			await fs.copyFile(
				join(toolRoot, "src/runtime/react-options.ts"),
				join(stage, "react/options.ts")
			)
			await generateReact(stage, operations)
		}
		await fs.writeFile(
			join(stage, "package.json"),
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
						...(options.react ? ["react/hooks.json"] : [])
					],
					exports: {
						".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
						"./package.json": "./package.json",
						"./operations.json": "./operations.json",
						...(options.react
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
					...(options.react
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
		await fs.writeFile(
			join(stage, "README.md"),
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
	options.react
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
		compilePackage(stage, options.react)
		const artifacts: Record<string, string> = {}
		for (const path of ts.sys.readDirectory(stage).sort())
			artifacts[path.slice(stage.length + 1)] = digest(await fs.readFile(path))
		await fs.writeFile(
			join(stage, "provenance.json"),
			`${JSON.stringify({ pioneer: 1, sources, descriptorSha256: digest(descriptorBytes), files: [...files.keys()].sort(), ignorePaths, react: options.react ?? false, generator: "protoc-gen-es@2.10.1", artifacts }, null, 2)}\n`
		)
		// Stage the whole result; failed generation must not destroy the last SDK.
		// Refuse an interrupted prior replacement rather than deleting its backup.
		try {
			await fs.lstat(backup)
			throw new Error(`Resolve interrupted generation backup: ${backup}`)
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error
		}
		await fs.mkdir(dirname(output), { recursive: true })
		let hadOutput = false
		try {
			await fs.rename(output, backup)
			hadOutput = true
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error
		}
		try {
			// Temp and repository may be on different filesystems.
			await fs.cp(stage, output, {
				recursive: true,
				errorOnExist: true,
				force: false
			})
			for (const relative of finderMetadata) {
				await fs.mkdir(dirname(join(output, relative)), { recursive: true })
				await fs.copyFile(join(backup, relative), join(output, relative))
			}
		} catch (error) {
			await fs.rm(output, { recursive: true, force: true })
			if (hadOutput) await fs.rename(backup, output)
			throw error
		}
		if (hadOutput) await fs.rm(backup, { recursive: true })
		return {
			outputPath: output,
			packageName: name,
			files: files.size,
			descriptorSha256: digest(descriptorBytes)
		}
	} finally {
		await fs.rm(temporary, { recursive: true, force: true })
	}
}
