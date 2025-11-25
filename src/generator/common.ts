import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const ALLOWED_COMMON_ROOTS = new Set([
	"amino",
	"cosmos_proto",
	"gogoproto",
	"google",
	"tendermint"
])

const COMMON_PATH_FILTERS = [
	"amino",
	"cosmos_proto",
	"gogoproto",
	"tendermint",
	"google/api",
	"cosmos"
]

const runBufGenerate = async (
	descriptorPath: string,
	paths: string[] = []
): Promise<void> => {
	return new Promise<void>((resolve, reject) => {
		const args = [
			"generate",
			descriptorPath,
			...paths.flatMap((p) => ["--path", p])
		]
		const proc = spawn("buf", args, { stdio: "inherit" })
		proc.on("exit", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`buf generate exited with code ${code}`))
			}
		})
	})
}

const relocateDescriptors = async (commonDir: string, outPath: string) => {
	const files: string[] = []
	const walk = async (dir: string) => {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		for (const entry of entries) {
			const nextPath = join(dir, entry.name)
			if (entry.isDirectory()) {
				await walk(nextPath)
			} else if (entry.isFile() && entry.name.endsWith("_pb.ts")) {
				files.push(nextPath)
			}
		}
	}

	await walk(commonDir)

	const relocation = new Map<string, string>()
	for (const filePath of files) {
		const relPath = relative(commonDir, filePath)
		const segments = relPath.split(/[/\\]/).filter(Boolean)
		if (segments.length < 2) continue
		const [root, module, ...rest] = segments
		if (ALLOWED_COMMON_ROOTS.has(root)) continue
		if (root !== "cosmos") continue
		const targetPath = join(outPath, root, module, "descriptor", ...rest)
		relocation.set(resolve(filePath), targetPath)
	}

	const rewriteSpecifier = (
		specifier: string,
		oldFile: string,
		newFile: string
	) => {
		if (!specifier.startsWith(".")) return specifier
		const withExt = specifier.endsWith(".ts") ? specifier : `${specifier}.ts`
		const oldTarget = resolve(dirname(oldFile), withExt)
		const mappedTarget = relocation.get(oldTarget) ?? oldTarget
		const newRel = relative(dirname(newFile), mappedTarget)
			.replace(/\\/g, "/")
			.replace(/\.ts$/, "")
		return newRel.startsWith(".") ? newRel : `./${newRel}`
	}

	const rewriteFileImports = async (filePath: string, targetPath: string) => {
		const code = await fs.readFile(filePath, "utf-8")
		const updated = code
			.replace(
				/(import\s+[^"']+from\s+["'])([^"']+)(["'])/g,
				(_, start, spec, end) =>
					`${start}${rewriteSpecifier(spec, filePath, targetPath)}${end}`
			)
			.replace(
				/(export\s+(?:\*|\{[^}]+\})\s+from\s+["'])([^"']+)(["'])/g,
				(_, start, spec, end) =>
					`${start}${rewriteSpecifier(spec, filePath, targetPath)}${end}`
			)
		await fs.mkdir(dirname(targetPath), { recursive: true })
		await fs.writeFile(targetPath, updated, "utf-8")
	}

	for (const [oldAbs, newPath] of relocation.entries()) {
		await rewriteFileImports(oldAbs, newPath)
		await fs.rm(oldAbs)
	}

	// Rewrite remaining files in-place to point at relocated targets.
	const remainingFiles = await fs.readdir(commonDir, { withFileTypes: true })
	for (const entry of remainingFiles) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
		const filePath = join(commonDir, entry.name)
		await rewriteFileImports(filePath, filePath)
	}

	const roots = await fs.readdir(commonDir, { withFileTypes: true })
	for (const entry of roots) {
		if (!entry.isDirectory()) continue
		if (ALLOWED_COMMON_ROOTS.has(entry.name)) continue
		await fs.rm(join(commonDir, entry.name), { recursive: true, force: true })
	}

	// Remove stray root-level files that are not part of allowed common roots.
	for (const file of ["changeset_pb.ts", "custom_error_pb.ts"]) {
		await fs.rm(join(commonDir, file), { force: true })
	}
}

export const generateCommon = async (
	outPath: string,
	descriptorPath: string
) => {
	const commonDir = join(outPath, "common")
	await fs.mkdir(commonDir, { recursive: true })
	// Only generate shared dependencies (no chain modules) from Buf-managed modules.
	await runBufGenerate(descriptorPath, COMMON_PATH_FILTERS)
	await relocateDescriptors(commonDir, outPath)
}

export const compareImportBlocks = (
	a: { path: string },
	b: { path: string }
) => {
	const aRelative = a.path.startsWith(".")
	const bRelative = b.path.startsWith(".")
	if (aRelative !== bRelative) return aRelative ? 1 : -1
	return a.path.localeCompare(b.path)
}

export const sanitizeAlias = (value: string) => value.replace(/\W+/g, "_")
