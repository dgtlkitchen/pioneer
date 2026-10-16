import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { checkFiles } from "./typecheck.js"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")

/** Per-file ES2022 JavaScript and isolated declarations; no type information is used. */
export async function emitPackage(
	sources: ReadonlyMap<string, string>
): Promise<Map<string, string>> {
	const [{ transform }, { isolatedDeclaration }] = await Promise.all([
		import("rolldown/utils"),
		import("rolldown/experimental")
	])
	const output = new Map<string, string>()
	const errors: string[] = []
	await Promise.all(
		[...sources]
			.filter(([path]) => path.endsWith(".ts"))
			.map(async ([path, text]) => {
				const [js, dts] = await Promise.all([
					transform(path, text, {
						lang: "ts",
						sourceType: "module",
						target: "es2022"
					}),
					isolatedDeclaration(path, text, { sourcemap: false })
				])
				for (const error of [...js.errors, ...dts.errors])
					errors.push(`${path}: ${error.message}`)
				const base = `dist/${path.slice(0, -3)}`
				output.set(`${base}.js`, js.code)
				output.set(`${base}.d.ts`, dts.code)
			})
	)
	if (errors.length)
		throw new Error(
			`Generated package emission failed\n${errors.sort().join("\n")}`
		)
	return new Map([...output].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function cacheDirectory() {
	const configured = process.env.PIONEER_CACHE_DIR
	if (configured !== undefined) return configured || undefined
	const base =
		process.env.XDG_CACHE_HOME ||
		(process.platform === "win32" ? process.env.LOCALAPPDATA : undefined) ||
		join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache")
	return join(base, "pioneer")
}

/**
 * Strict check of the published surface without skipLibCheck: every emitted
 * declaration plus Pioneer-authored source bodies. Sources see protoc-gen-es
 * schemas through those same emitted declarations. Success is cached by content.
 */
export async function checkPackage(input: {
	root: string
	sources: ReadonlyMap<string, string>
	emitted: ReadonlyMap<string, string>
	resolveFrom: string
	runtimes: readonly string[]
	toolchain: Readonly<Record<string, string>>
}): Promise<void> {
	const root = input.root.replaceAll("\\", "/")
	const files = new Map<string, string>()
	for (const [path, text] of input.sources)
		if (path.endsWith(".ts") && !path.endsWith("_pb.ts"))
			files.set(`${root}/${path}`, text)
	for (const [path, text] of input.emitted)
		if (path.endsWith(".d.ts")) files.set(`${root}/${path}`, text)
	const key = digest(
		JSON.stringify({
			check: 1,
			toolchain: input.toolchain,
			runtimes: input.runtimes,
			files: [...files]
				.map(([path, text]) => [path.slice(root.length), digest(text)])
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		})
	)
	const cache = cacheDirectory()
	const marker = cache && join(cache, "typecheck-v1", key)
	if (marker) {
		try {
			if ((await fs.readFile(marker, "utf8")) === key) return
		} catch {}
	}
	const { default: typescript } = await import("typescript")
	const report = checkFiles(typescript, {
		root,
		files,
		resolveFrom: input.resolveFrom,
		runtimes: input.runtimes
	})
	if (report) throw new Error(report)
	if (marker) {
		try {
			await fs.mkdir(dirname(marker), { recursive: true })
			await fs.writeFile(marker, key)
		} catch {}
	}
}
