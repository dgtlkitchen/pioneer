import { posix } from "node:path"
import type ts from "typescript"

export type CheckInput = {
	root: string
	files: ReadonlyMap<string, string>
	resolveFrom: string
	runtimes: readonly string[]
}

// External declarations (lib, node_modules) are immutable for a process's pinned toolchain.
const externalSources = new Map<string, ts.SourceFile>()

/** Strict, skipLibCheck-free diagnostics over an in-memory package; empty when clean. */
export function checkFiles(typescript: typeof ts, input: CheckInput): string {
	const { root, files, resolveFrom, runtimes } = input
	const options: ts.CompilerOptions = {
		target: typescript.ScriptTarget.ES2022,
		module: typescript.ModuleKind.ESNext,
		moduleResolution: typescript.ModuleResolutionKind.Bundler,
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		types: [],
		lib: ["lib.esnext.d.ts", "lib.dom.d.ts"]
	}
	const directories = new Set<string>()
	for (const path of files.keys())
		for (
			let parent = path.slice(0, path.lastIndexOf("/"));
			parent.length >= root.length;
			parent = parent.slice(0, parent.lastIndexOf("/"))
		)
			directories.add(parent)
	const inside = (path: string) => path === root || path.startsWith(`${root}/`)
	const host = typescript.createCompilerHost(options)
	const external = { ...host }
	host.getCurrentDirectory = () => root
	host.fileExists = (path) =>
		inside(path) ? files.has(path) : external.fileExists(path)
	host.readFile = (path) =>
		inside(path) ? files.get(path) : external.readFile(path)
	host.directoryExists = (path) =>
		inside(path)
			? directories.has(path)
			: (external.directoryExists?.(path) ?? true)
	host.getDirectories = (path) =>
		inside(path) ? [] : (external.getDirectories?.(path) ?? [])
	host.realpath = (path) =>
		inside(path) ? path : (external.realpath?.(path) ?? path)
	host.writeFile = () => {}
	host.getSourceFile = (path, version, onError) => {
		if (inside(path)) {
			const text = files.get(path)
			return text === undefined
				? undefined
				: typescript.createSourceFile(path, text, version)
		}
		const format =
			typeof version === "object" ? version.impliedNodeFormat : undefined
		const id = `${typeof version === "object" ? version.languageVersion : version}:${format}:${path}`
		let source = externalSources.get(id)
		if (!source) {
			source = external.getSourceFile(path, version, onError)
			if (source) externalSources.set(id, source)
		}
		return source
	}
	// Check against the tool's pinned runtimes; generation does not install packages.
	host.resolveModuleNames = (names, containingFile) =>
		names.map((name) => {
			// Sources link schemas through the exact declarations consumers receive.
			if (
				name.startsWith(".") &&
				name.endsWith("_pb.js") &&
				inside(containingFile) &&
				!containingFile.startsWith(`${root}/dist/`)
			) {
				const target = posix.join(posix.dirname(containingFile), name)
				const resolvedFileName = `${root}/dist/${target.slice(root.length + 1, -3)}.d.ts`
				if (files.has(resolvedFileName))
					return { resolvedFileName, extension: typescript.Extension.Dts }
			}
			return typescript.resolveModuleName(
				name,
				runtimes.some(
					(runtime) => name === runtime || name.startsWith(`${runtime}/`)
				)
					? resolveFrom
					: containingFile,
				options,
				host
			).resolvedModule
		})
	const program = typescript.createProgram([...files.keys()], options, host)
	const diagnostics = typescript.getPreEmitDiagnostics(program)
	return diagnostics.length
		? typescript.formatDiagnosticsWithColorAndContext(diagnostics, {
				getCanonicalFileName: (file) => file,
				getCurrentDirectory: () => root,
				getNewLine: () => "\n"
			})
		: ""
}
