import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const root = join(import.meta.dir, "../..")
const helper = join(root, "src/release.mjs")
const fixture = join(root, "tests/fixtures/installed-cli.mjs")
const execute = promisify(execFile)
const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex")
const identity = {
	repository: "dgtlkitchen/pioneer",
	repositoryId: "1420539345",
	source: "a".repeat(40),
	workflowCommit: "a".repeat(40),
	workflow: ".github/workflows/release.yml",
	ref: "refs/heads/main",
	run: "123",
	attempt: "1",
	inputSha256: "b".repeat(64)
}

async function temporary(run: (directory: string) => Promise<void>) {
	const directory = await fs.realpath(
		await fs.mkdtemp(join(tmpdir(), "pioneer-release-"))
	)
	try {
		await run(directory)
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
}

async function invoke(
	directory: string,
	mode: string,
	input: unknown,
	program = helper,
	environment = process.env
) {
	const inputPath = join(directory, "input.json")
	const outputPath = join(directory, "output.json")
	await fs.writeFile(inputPath, JSON.stringify(input))
	return execute(
		"node",
		[program, mode, "--input", inputPath, "--output", outputPath],
		{ cwd: directory, env: environment, timeout: 10000, maxBuffer: 1024 * 1024 }
	)
}

type FileEntry = { path: string; sha256: string; mode: number }
type TransferInput = {
	expected: {
		identity: typeof identity
		candidateSha256: string
		helperSha256: string
		artifacts: { id: string; archiveSha256: string; files: FileEntry[] }[]
		installed: null
	}
	observed: typeof identity
	artifacts: { id: string; archive: string; root: string }[]
	installedRoot: string | null
}

async function transfer(directory: string): Promise<TransferInput> {
	const artifactRoot = join(directory, "artifact")
	await fs.mkdir(artifactRoot)
	const candidate = JSON.stringify({ identity })
	const script = "verification fixture\n"
	await fs.writeFile(join(artifactRoot, "candidate.json"), candidate)
	await fs.writeFile(join(artifactRoot, "release.mjs"), script)
	await fs.chmod(join(artifactRoot, "candidate.json"), 0o644)
	await fs.chmod(join(artifactRoot, "release.mjs"), 0o644)
	const archive = join(directory, "artifact.zip")
	await fs.writeFile(archive, "synthetic opaque archive bytes")
	return {
		expected: {
			identity,
			candidateSha256: sha256(candidate),
			helperSha256: sha256(script),
			artifacts: [
				{
					id: "321",
					archiveSha256: sha256("synthetic opaque archive bytes"),
					files: [
						{ path: "candidate.json", sha256: sha256(candidate), mode: 0o644 },
						{ path: "release.mjs", sha256: sha256(script), mode: 0o644 }
					]
				}
			],
			installed: null
		},
		observed: structuredClone(identity),
		artifacts: [{ id: "321", archive, root: artifactRoot }],
		installedRoot: null
	}
}

test("transfer binds archive bytes, members, and independent identities", async () => {
	await temporary(async (directory) => {
		const input = await transfer(directory)
		await invoke(directory, "transfer", input)
		const result = JSON.parse(
			await fs.readFile(join(directory, "output.json"), "utf8")
		)
		expect(result.identity).toEqual(identity)
		expect(result.candidateSha256).toBe(input.expected.candidateSha256)
		await expect(invoke(directory, "transfer", input)).rejects.toThrow("EEXIST")
	})
})

test("transfer rejects identity, archive, member, and schema mismatches without output", async () => {
	const cases: ((input: Awaited<ReturnType<typeof transfer>>) => void)[] = [
		(input) => {
			input.observed.attempt = "2"
		},
		(input) => {
			input.observed.source = "c".repeat(40)
		},
		(input) => {
			input.expected.identity = { ...identity, repositoryId: "9" }
		},
		(input) => {
			input.artifacts[0].id = "999"
		},
		(input) => {
			input.expected.artifacts[0].archiveSha256 = "0".repeat(64)
		},
		(input) => {
			input.expected.candidateSha256 = "0".repeat(64)
		},
		(input) => {
			input.expected.helperSha256 = "0".repeat(64)
		},
		(input) => {
			input.expected.artifacts[0].files[0].sha256 = "0".repeat(64)
		},
		(input) => {
			input.expected.artifacts[0].files[0].path = "../escape"
		},
		(input) => {
			input.expected.artifacts[0].files[0].path = "C:\\escape"
		},
		(input) => {
			input.expected.artifacts[0].files[0].path = "/escape"
		},
		(input) => {
			input.expected.artifacts[0].files.push({
				...input.expected.artifacts[0].files[0],
				path: "CANDIDATE.JSON"
			})
		},
		(input) => {
			input.expected.artifacts.push(input.expected.artifacts[0])
		}
	]
	for (const change of cases)
		await temporary(async (directory) => {
			const input = await transfer(directory)
			change(input)
			await expect(invoke(directory, "transfer", input)).rejects.toThrow()
			await expect(
				fs.stat(join(directory, "output.json"))
			).rejects.toMatchObject({ code: "ENOENT" })
		})
})

test("transfer rejects missing, unexpected, and linked members", async () => {
	for (const variant of ["missing", "extra", "directory", "link"])
		await temporary(async (directory) => {
			const input = await transfer(directory)
			const tree = input.artifacts[0].root
			if (variant === "missing") await fs.unlink(join(tree, "candidate.json"))
			if (variant === "extra")
				await fs.writeFile(join(tree, "extra"), "unexpected")
			if (variant === "directory") await fs.mkdir(join(tree, "unexpected"))
			if (variant === "link")
				await fs.symlink("candidate.json", join(tree, "unexpected"))
			await expect(invoke(directory, "transfer", input)).rejects.toThrow()
		})
})

async function nativeTools() {
	const node = (await execute("node", ["--version"], { timeout: 10000 })).stdout
		.trim()
		.slice(1)
	const runner =
		process.platform === "darwin"
			? "macos-14"
			: process.platform === "win32"
				? "windows-2022"
				: "ubuntu-24.04"
	return {
		node,
		npm: node === "20.19.0" ? "10.8.2" : "11.19.1",
		bun: null,
		nodePath: "/tools/node",
		npmPath: "/tools/npm",
		bunPath: null,
		platform: process.platform,
		arch: process.arch,
		runner,
		image: "fixture-image"
	}
}

test("installed bin exceptions require exact paths, text, targets, modes, and digests", async () => {
	const tools = await nativeTools()
	for (const variant of [
		"accepted",
		"unexpected",
		"escape",
		"absolute",
		"retarget",
		"digest",
		"mode",
		"dangling",
		"cycle",
		"directory",
		"missing"
	])
		await temporary(async (directory) => {
			const input = await transfer(directory)
			const prefix = join(directory, "prefix")
			const target = "lib/node_modules/example/cli.js"
			await fs.mkdir(dirname(join(prefix, target)), { recursive: true })
			await fs.mkdir(join(prefix, "bin"))
			await fs.writeFile(join(prefix, target), "accepted CLI")
			await fs.chmod(join(prefix, target), 0o755)
			const link = {
				path: "bin/example",
				text: "../lib/node_modules/example/cli.js",
				package: "example@1.0.0",
				boundary: "lib/node_modules/example",
				target,
				sha256: sha256("accepted CLI"),
				mode: 0o755
			}
			const accepted = {
				files: [{ path: target, sha256: link.sha256, mode: 0o755 }],
				links: [link],
				shims: [],
				consumer: []
			}
			const contentsPath = join(input.artifacts[0].root, "contents.json")
			const contents = JSON.stringify({
				identity,
				candidateSha256: input.expected.candidateSha256,
				platforms: { [`${tools.platform}/${tools.arch}`]: accepted }
			})
			await fs.writeFile(contentsPath, contents, { mode: 0o644 })
			input.expected.artifacts[0].files.push({
				path: "contents.json",
				sha256: sha256(contents),
				mode: 0o644
			})
			const native = {
				...input,
				expected: {
					...input.expected,
					installed: {
						phase: "reference",
						contents: contentsPath,
						toolchain: tools,
						reference: null
					}
				},
				installedRoot: prefix
			}
			let text = link.text
			if (variant === "escape") text = "../../outside"
			if (variant === "absolute") text = join(directory, "outside")
			if (variant === "retarget") text = "../lib/node_modules/example/other.js"
			if (variant === "dangling") text = "missing"
			if (variant === "cycle") text = "example"
			if (variant === "directory") text = "../lib/node_modules/example"
			if (variant !== "missing") await fs.symlink(text, join(prefix, link.path))
			if (variant === "unexpected")
				await fs.symlink(link.text, join(prefix, "bin/other"))
			if (variant === "digest")
				await fs.writeFile(join(prefix, target), "changed CLI")
			if (variant === "mode") await fs.chmod(join(prefix, target), 0o644)
			if (variant === "accepted" && process.platform !== "win32")
				await invoke(directory, "transfer", native)
			else await expect(invoke(directory, "transfer", native)).rejects.toThrow()
		})
})

test("guard rejects malformed, oversized, unknown-mode, and surplus-argument input", async () => {
	for (const value of ["{", " ".repeat(8 * 1024 * 1024 + 1)])
		await temporary(async (directory) => {
			const input = join(directory, "input.json")
			await fs.writeFile(input, value)
			await expect(
				execute(
					"node",
					[
						helper,
						"transfer",
						"--input",
						input,
						"--output",
						join(directory, "output.json")
					],
					{ timeout: 10000 }
				)
			).rejects.toThrow()
		})
	await temporary(async (directory) => {
		await expect(invoke(directory, "unknown", {})).rejects.toThrow(
			"unsupported mode"
		)
		await expect(
			execute(
				"node",
				[helper, "transfer", "--input", "x", "--output", "y", "--extra"],
				{ timeout: 10000 }
			)
		).rejects.toThrow("expected MODE")
	})
})

test("matrix requires six unique cold cells and exact checks", async () => {
	for (const variant of [
		"accepted",
		"missing",
		"duplicate",
		"altered",
		"wrong-npm",
		"failed-check",
		"unbound-reference",
		"reference-bytes",
		"reference-tools"
	])
		await temporary(async (directory) => {
			const receipts: {
				path: string
				sha256: string
				referencePath: string
			}[] = []
			let index = 0
			for (const [platform, arch, runner] of [
				["darwin", "arm64", "macos-14"],
				["linux", "x64", "ubuntu-24.04"],
				["win32", "x64", "windows-2022"]
			])
				for (const node of ["20.19.0", "24.22.0"]) {
					const receipt = {
						identity,
						candidateSha256: "c".repeat(64),
						referenceSha256: "e".repeat(64),
						toolchain: {
							node,
							npm: node === "20.19.0" ? "10.8.2" : "11.19.1",
							bun: null,
							nodePath: "/tools/node",
							npmPath: "/tools/npm",
							bunPath: null,
							platform,
							arch,
							runner,
							image: "fixture-image"
						},
						bin: "/prefix/bin/pioneer",
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
					const referencePath = join(directory, `reference-${index}.json`)
					const reference = JSON.stringify({
						identity,
						candidateSha256: "c".repeat(64),
						artifacts: [],
						reference: {
							identity,
							candidateSha256: "c".repeat(64),
							toolchain: structuredClone(receipt.toolchain),
							prefix: "/reference-prefix",
							shims: []
						}
					})
					await fs.writeFile(referencePath, reference)
					receipt.referenceSha256 = sha256(reference)
					if (index === 0 && variant === "reference-bytes")
						await fs.writeFile(referencePath, "changed reference")
					if (index === 0 && variant === "reference-tools") {
						const changed = JSON.parse(reference)
						changed.reference.toolchain.image = "different-image"
						const bytes = JSON.stringify(changed)
						await fs.writeFile(referencePath, bytes)
						receipt.referenceSha256 = sha256(bytes)
					}
					if (index === 0 && variant === "wrong-npm")
						receipt.toolchain.npm = "11.0.0"
					if (index === 0 && variant === "failed-check") receipt.checks.pop()
					if (index === 0 && variant === "altered")
						receipt.candidateSha256 = "d".repeat(64)
					if (index === 0 && variant === "unbound-reference")
						receipt.referenceSha256 = ""
					const bytes = JSON.stringify(receipt)
					const path = join(directory, `receipt-${index++}.json`)
					await fs.writeFile(path, bytes)
					receipts.push({ path, sha256: sha256(bytes), referencePath })
				}
			if (variant === "missing") receipts.pop()
			if (variant === "duplicate") receipts[1] = receipts[0]
			const input = { identity, candidateSha256: "c".repeat(64), receipts }
			if (variant === "accepted") await invoke(directory, "matrix", input)
			else await expect(invoke(directory, "matrix", input)).rejects.toThrow()
		})
})

test("native reference binds accepted package content before a separate cold installation", async () => {
	const tools = await nativeTools()
	for (const variant of [
		"accepted",
		"extra-reference",
		"changed-reference",
		"reference-link",
		"missing-cold",
		"changed-cold",
		"extra-cold",
		"same-prefix",
		"wrong-reference-hash",
		"wrong-reference-toolchain",
		"wrong-content-identity",
		"wrong-shim"
	])
		await temporary(async (directory) => {
			const input = await transfer(directory)
			const referenceRoot = join(directory, "reference-prefix")
			const coldRoot = join(directory, "cold-prefix")
			const packagePath = "node_modules/example/cli.js"
			const packageBytes = "#!/usr/bin/env node\n"
			const files = [
				{ path: packagePath, sha256: sha256(packageBytes), mode: 0o644 }
			]
			const shims =
				process.platform === "win32"
					? [
							{
								path: "example.cmd",
								package: "example@1.0.0",
								boundary: "node_modules/example",
								target: packagePath,
								sha256: sha256(packageBytes),
								mode: 0o644
							}
						]
					: []
			for (const prefix of [referenceRoot, coldRoot]) {
				await fs.mkdir(join(prefix, "node_modules/example"), {
					recursive: true
				})
				await fs.writeFile(join(prefix, packagePath), packageBytes, {
					mode: 0o644
				})
				if (process.platform === "win32")
					await fs.writeFile(
						join(prefix, "example.cmd"),
						"synthetic native shim",
						{ mode: 0o644 }
					)
			}
			const contentsPath = join(input.artifacts[0].root, "contents.json")
			const contentIdentity =
				variant === "wrong-content-identity"
					? { ...identity, attempt: "2" }
					: identity
			const contents = JSON.stringify({
				identity: contentIdentity,
				candidateSha256: input.expected.candidateSha256,
				platforms: {
					[`${process.platform}/${process.arch}`]: {
						files,
						links: [],
						shims,
						consumer: []
					}
				}
			})
			await fs.writeFile(contentsPath, contents, { mode: 0o644 })
			input.expected.artifacts[0].files.push({
				path: "contents.json",
				sha256: sha256(contents),
				mode: 0o644
			})
			const installation: {
				phase: string
				contents: string
				toolchain: typeof tools
				reference: { path: string; sha256: string } | null
			} = {
				phase: "reference",
				contents: contentsPath,
				toolchain: tools,
				reference: null
			}
			const native = {
				...input,
				expected: { ...input.expected, installed: installation },
				installedRoot: referenceRoot
			}
			if (variant === "extra-reference")
				await fs.writeFile(join(referenceRoot, "unexpected"), "extra")
			if (variant === "changed-reference")
				await fs.writeFile(join(referenceRoot, packagePath), "changed")
			if (variant === "reference-link") {
				await fs.rename(
					join(referenceRoot, packagePath),
					join(directory, "outside")
				)
				await fs.symlink(
					join(directory, "outside"),
					join(referenceRoot, packagePath)
				)
			}
			if (
				[
					"extra-reference",
					"changed-reference",
					"reference-link",
					"wrong-content-identity"
				].includes(variant)
			) {
				await expect(invoke(directory, "transfer", native)).rejects.toThrow()
				await expect(
					fs.stat(join(directory, "output.json"))
				).rejects.toMatchObject({ code: "ENOENT" })
				return
			}
			await invoke(directory, "transfer", native)
			const referencePath = join(directory, "reference.json")
			await fs.rename(join(directory, "output.json"), referencePath)
			if (variant === "wrong-reference-toolchain") {
				const record = JSON.parse(await fs.readFile(referencePath, "utf8"))
				record.reference.toolchain.image = "different-image"
				await fs.writeFile(referencePath, JSON.stringify(record))
			}
			installation.reference = {
				path: referencePath,
				sha256: sha256(await fs.readFile(referencePath))
			}
			installation.phase = "cold"
			native.installedRoot =
				variant === "same-prefix" ? referenceRoot : coldRoot
			if (variant === "wrong-reference-hash")
				installation.reference.sha256 = "0".repeat(64)
			if (variant === "missing-cold")
				await fs.unlink(join(coldRoot, packagePath))
			if (variant === "changed-cold")
				await fs.writeFile(join(coldRoot, packagePath), "changed")
			if (variant === "extra-cold")
				await fs.writeFile(
					join(coldRoot, ".package-lock.json"),
					"unaccounted npm file"
				)
			if (variant === "wrong-shim")
				await fs.writeFile(join(coldRoot, "example.cmd"), "changed shim")
			if (variant === "accepted") {
				await invoke(directory, "transfer", native)
				expect(
					JSON.parse(await fs.readFile(join(directory, "output.json"), "utf8"))
						.reference
				).toEqual({ sha256: installation.reference.sha256 })
			} else
				await expect(invoke(directory, "transfer", native)).rejects.toThrow()
		})
})

test("cold preparation rejects an existing root without replacing prior output", async () => {
	await temporary(async (directory) => {
		const fixtureRoot = join(directory, "cold")
		await fs.mkdir(fixtureRoot)
		await fs.writeFile(join(fixtureRoot, "preserve"), "prior output")
		await expect(
			invoke(
				directory,
				"prepare",
				{ root: fixtureRoot, prefix: directory, consumer: [] },
				fixture
			)
		).rejects.toThrow()
		expect(await fs.readFile(join(fixtureRoot, "preserve"), "utf8")).toBe(
			"prior output"
		)
	})
})

test("cold preparation writes frozen schemas and copies only accepted runtime bytes", async () => {
	await temporary(async (directory) => {
		const prefix = join(directory, "prefix")
		await fs.mkdir(prefix)
		await fs.writeFile(
			join(prefix, "dependency.js"),
			"export const fixture = true\n"
		)
		const fixtureRoot = join(directory, "cold")
		const input = {
			root: fixtureRoot,
			prefix,
			consumer: [
				{
					source: "dependency.js",
					path: "node_modules/example/index.js",
					sha256: sha256("export const fixture = true\n")
				}
			]
		}
		await invoke(directory, "prepare", input, fixture)
		expect(
			await fs.readFile(
				join(fixtureRoot, "proto/cosmos/tx/v1beta1/tx.proto"),
				"utf8"
			)
		).toContain("uint64 account_number=4")
		expect(
			await fs.readFile(
				join(fixtureRoot, "node_modules/example/index.js"),
				"utf8"
			)
		).toBe("export const fixture = true\n")
	})
})

test("fixture preparation rejects unsafe inventories, changed bytes, and linked dependencies", async () => {
	for (const scenario of [
		"source-escape",
		"destination-escape",
		"absolute",
		"duplicate",
		"case-collision",
		"digest",
		"link",
		"overlap"
	])
		await temporary(async (directory) => {
			const prefix = join(directory, "prefix")
			await fs.mkdir(prefix)
			await fs.writeFile(join(prefix, "dependency.js"), "accepted dependency")
			const entry = {
				source: "dependency.js",
				path: "node_modules/example/index.js",
				sha256: sha256("accepted dependency")
			}
			const input = { root: join(directory, "cold"), prefix, consumer: [entry] }
			if (scenario === "source-escape") entry.source = "../dependency.js"
			if (scenario === "destination-escape")
				entry.path = "node_modules/../escape.js"
			if (scenario === "absolute") entry.path = join(directory, "outside.js")
			if (scenario === "duplicate") input.consumer.push({ ...entry })
			if (scenario === "case-collision")
				input.consumer.push({ ...entry, path: "node_modules/example/INDEX.js" })
			if (scenario === "digest") entry.sha256 = "0".repeat(64)
			if (scenario === "link") {
				await fs.rename(
					join(prefix, "dependency.js"),
					join(directory, "dependency.js")
				)
				await fs.symlink(
					join(directory, "dependency.js"),
					join(prefix, "dependency.js")
				)
			}
			if (scenario === "overlap") input.root = join(prefix, "cold")
			await expect(
				invoke(directory, "prepare", input, fixture)
			).rejects.toThrow()
			await expect(
				fs.stat(join(directory, "output.json"))
			).rejects.toMatchObject({ code: "ENOENT" })
			await expect(
				fs.stat(join(directory, "outside.js"))
			).rejects.toMatchObject({ code: "ENOENT" })
		})
})

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

test("fixture check rejects an invalid native interpreter before any CLI subprocess", async () => {
	for (const scenario of ["relative", "dot-segment", "substitute"])
		await temporary(async (directory) => {
			const substitute = join(directory, "cmd.exe")
			await fs.writeFile(substitute, "not an executable interpreter")
			const command =
				scenario === "relative"
					? "cmd.exe"
					: scenario === "dot-segment"
						? `${process.env.SystemRoot}\\System32\\..\\System32\\cmd.exe`
						: substitute
			const input = {
				root: join(directory, "missing-cold"),
				prefix: join(directory, "prefix"),
				consumer: []
			}
			const result = invoke(directory, "check", input, fixture, {
				...process.env,
				NODE_PATH: undefined,
				NODE_OPTIONS: undefined,
				ComSpec: command
			})
			const expected =
				process.platform !== "win32"
					? "ENOENT"
					: scenario === "relative"
						? "absolute local system path"
						: scenario === "dot-segment"
							? "unsafe path segment"
							: "ComSpec does not identify native cmd.exe"
			await expect(result).rejects.toThrow(expected)
			await expect(
				fs.stat(join(directory, "output.json"))
			).rejects.toMatchObject({ code: "ENOENT" })
		})
})

async function workflowScript(name: string) {
	const parsed: unknown = Bun.YAML.parse(
		await fs.readFile(join(root, ".github/workflows/release.yml"), "utf8")
	)
	if (
		!record(parsed) ||
		!record(parsed.env) ||
		typeof parsed.env[name] !== "string"
	)
		throw new Error(`Read workflow ${name}: missing native script`)
	return parsed.env[name]
}

async function workflowBlock(marker: string) {
	const parsed: unknown = Bun.YAML.parse(
		await fs.readFile(join(root, ".github/workflows/release.yml"), "utf8")
	)
	if (!record(parsed) || !record(parsed.jobs))
		throw new Error("Read workflow: missing jobs")
	const matches: { script: string; run: string }[] = []
	const opening = `<<'${marker}'\n`
	for (const job of Object.values(parsed.jobs)) {
		if (!record(job) || !Array.isArray(job.steps)) continue
		for (const step of job.steps) {
			if (!record(step) || typeof step.run !== "string") continue
			const start = step.run.indexOf(opening)
			if (start < 0) continue
			const end = step.run.indexOf(`\n${marker}\n`, start + opening.length)
			if (end < 0)
				throw new Error(`Read workflow ${marker}: missing block terminator`)
			matches.push({
				script: step.run.slice(start + opening.length, end),
				run: step.run
			})
		}
	}
	if (matches.length !== 1)
		throw new Error(`Read workflow ${marker}: expected one source block`)
	return matches[0]
}

test("actual workflow resolves native runner paths before tool verification", async () => {
	const script = await workflowScript("PIONEER_PATHS")
	const parsed: unknown = Bun.YAML.parse(
		await fs.readFile(join(root, ".github/workflows/release.yml"), "utf8")
	)
	if (!record(parsed) || !record(parsed.jobs))
		throw new Error("Read workflow: missing jobs")
	for (const job of Object.values(parsed.jobs)) {
		if (!record(job) || !Array.isArray(job.steps))
			throw new Error("Read workflow: missing steps")
		expect(JSON.stringify(job.env)).not.toContain("runner.temp")
		const paths = job.steps.findIndex(
			(step) =>
				record(step) &&
				typeof step.run === "string" &&
				step.run.includes("$PIONEER_PATHS")
		)
		const tools = job.steps.findIndex(
			(step) =>
				record(step) &&
				typeof step.run === "string" &&
				step.run.includes("$PIONEER_TOOLS")
		)
		expect(paths).toBeGreaterThanOrEqual(0)
		expect(paths).toBeLessThan(tools)
	}
	for (const scenario of ["accepted", "relative", "newline"])
		await temporary(async (directory) => {
			const environment = join(directory, "environment")
			const runner =
				scenario === "relative"
					? "relative"
					: scenario === "newline"
						? `${directory}\ninjected=value`
						: join(directory, "runner with spaces")
			const command = execute("node", ["--input-type=module", "-e", script], {
				env: { ...process.env, RUNNER_TEMP: runner, GITHUB_ENV: environment },
				timeout: 10000
			})
			if (scenario === "accepted") {
				await command
				expect(await fs.readFile(environment, "utf8")).toBe(
					`PIONEER_TOOL_RECORD=${join(runner, "tools.json")}\nPIONEER_ARCHIVES=${join(runner, "archives")}\nPIONEER_EXTRACTED=${join(runner, "extracted")}\n`
				)
			} else {
				await expect(command).rejects.toThrow("Resolve runner paths")
				await expect(fs.stat(environment)).rejects.toMatchObject({
					code: "ENOENT"
				})
			}
		})
})

test("actual workflow stages runtime resolutions from the Bun lock without dependency drift", async () => {
	const block = await workflowBlock("STAGE")
	for (const scenario of ["accepted", "missing", "malformed", "invalid-json"])
		await temporary(async (directory) => {
			const runner = join(directory, "runner")
			await fs.mkdir(runner)
			await fs.symlink(
				join(root, "node_modules"),
				join(directory, "node_modules"),
				"dir"
			)
			const manifest = {
				name: "@example/tool",
				version: "1.2.3",
				dependencies: { "@example/direct": "1.2.3" }
			}
			const packages: Record<string, unknown> = {
				"@example/direct": [
					"@example/direct@1.2.3",
					"",
					{
						dependencies: { transitive: "^2.0.0" },
						optionalDependencies: { platform: "^3.0.0" }
					},
					"integrity"
				],
				transitive: [
					"transitive@2.0.1",
					"",
					{ dependencies: { "@example/direct": "1.2.3" } },
					"integrity"
				],
				platform: ["platform@3.0.1", "", {}, "integrity"]
			}
			if (scenario === "missing") delete packages.transitive
			if (scenario === "malformed") packages.transitive = ["transitive@2.0.1"]
			const lock =
				scenario === "invalid-json" ? "{" : JSON.stringify({ packages })
			await fs.writeFile(
				join(directory, "package.json"),
				JSON.stringify(manifest)
			)
			await fs.writeFile(join(directory, "bun.lock"), lock)
			await fs.writeFile(
				join(runner, "identity.json"),
				JSON.stringify({ source: [] })
			)
			await fs.writeFile(join(runner, "build.json"), "[]")
			const command = execute(
				"node",
				["--input-type=module", "-e", block.script],
				{
					cwd: directory,
					env: {
						...process.env,
						RUNNER_TEMP: runner,
						GITHUB_WORKSPACE: directory
					},
					timeout: 10000
				}
			)
			if (scenario === "accepted") {
				await command
				expect(
					JSON.parse(
						await fs.readFile(join(runner, "closure/package.json"), "utf8")
					)
				).toEqual({
					...manifest,
					overrides: { transitive: "2.0.1", platform: "3.0.1" }
				})
			} else await expect(command).rejects.toThrow("Stage runtime closure")
			expect(await fs.readFile(join(directory, "bun.lock"), "utf8")).toBe(lock)
		})
})

test("actual workflow normalizes only the declared CLI mode before unit qualification", async () => {
	const block = await workflowBlock("BINMODE")
	expect(
		block.run.indexOf("bun --no-env-file --no-install run build")
	).toBeLessThan(block.run.indexOf("<<'BINMODE'"))
	expect(block.run.indexOf("<<'BINMODE'")).toBeLessThan(
		block.run.indexOf("bun --no-env-file --no-install run test:unit")
	)
	for (const scenario of ["accepted", "wrong-bin", "linked-bin"])
		await temporary(async (directory) => {
			await fs.mkdir(join(directory, "dist"))
			await fs.writeFile(
				join(directory, "package.json"),
				JSON.stringify({
					bin: {
						pioneer:
							scenario === "wrong-bin" ? "./dist/other.js" : "./dist/cli.js"
					}
				})
			)
			const bytes = "#!/usr/bin/env node\n// synthetic bin\n"
			await fs.writeFile(join(directory, "dist/cli.js"), bytes, { mode: 0o644 })
			await fs.writeFile(
				join(directory, "dist/index.js"),
				"unchanged non-bin",
				{ mode: 0o644 }
			)
			if (scenario === "linked-bin") {
				await fs.rename(
					join(directory, "dist/cli.js"),
					join(directory, "outside.js")
				)
				await fs.symlink(
					join(directory, "outside.js"),
					join(directory, "dist/cli.js")
				)
			}
			const result = execute(
				"node",
				["--input-type=module", "-e", block.script],
				{ cwd: directory, timeout: 10000 }
			)
			if (scenario === "accepted") {
				await result
				expect(await fs.readFile(join(directory, "dist/cli.js"), "utf8")).toBe(
					bytes
				)
				expect(
					(await fs.stat(join(directory, "dist/cli.js"))).mode & 0o777
				).toBe(0o755)
			} else await expect(result).rejects.toThrow()
			expect(await fs.readFile(join(directory, "dist/index.js"), "utf8")).toBe(
				"unchanged non-bin"
			)
			expect(
				(await fs.stat(join(directory, "dist/index.js"))).mode & 0o777
			).toBe(0o644)
		})
})

test("actual publication source preserves only the approved hosted-runner environment", async () => {
	const { script } = await workflowBlock("PUBLISH")
	const capture = `
import assert from 'node:assert/strict';
import childProcessMock from 'node:child_process';
import { writeFileSync as captureFile } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
childProcessMock.execFileSync = (command, args, options) => {
  assert.equal(command, process.execPath);
  assert.equal(args[0], '/trusted/npm-cli.js');
  assert.equal(args[1], 'publish');
  assert.deepEqual(args.slice(3), ['--access', 'public', '--ignore-scripts', '--provenance']);
  assert.equal(options.timeout, 300000);
  captureFile(process.env.TEST_CAPTURE, JSON.stringify(options.env), { flag: 'wx' });
  return Buffer.alloc(0);
};
syncBuiltinESMExports();
`
	for (const runnerEnvironment of ["github-hosted", "self-hosted", ""])
		await temporary(async (directory) => {
			const matrixBytes = "synthetic accepted matrix"
			const tarballBytes = "synthetic accepted tarball"
			await fs.writeFile(join(directory, "matrix.json"), matrixBytes)
			await fs.writeFile(join(directory, "pioneer.tgz"), tarballBytes)
			const toolsPath = join(directory, "tools.json")
			await fs.writeFile(
				toolsPath,
				JSON.stringify({ npmPath: "/trusted/npm-cli.js" })
			)
			const approval = {
				matrixSha256: sha256(matrixBytes),
				transfer: {
					artifacts: [
						{ files: [{ path: "pioneer.tgz", sha256: sha256(tarballBytes) }] }
					]
				},
				publication: {
					repository: identity.repository,
					workflow: "release.yml",
					environment: "npm-pioneer",
					allowedAction: "npm publish",
					validated: true,
					expiresAt: new Date(Date.now() + 60000).toISOString(),
					licenseSha256: "a".repeat(64),
					archiveDraftSha256: "b".repeat(64),
					permissionSha256: "c".repeat(64)
				}
			}
			const captured = join(directory, "captured.json")
			const result = execute(
				"node",
				["--input-type=module", "-e", `${capture}\n${script}`],
				{
					cwd: directory,
					timeout: 10000,
					env: {
						...process.env,
						...githubEnvironment(),
						GITHUB_ACTIONS: "true",
						GITHUB_REPOSITORY_OWNER_ID: "456",
						GITHUB_SERVER_URL: "https://github.com",
						RUNNER_ENVIRONMENT: runnerEnvironment,
						ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.invalid/oidc",
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-token",
						NPM_TOKEN: "synthetic-excluded-token",
						NODE_AUTH_TOKEN: "synthetic-excluded-token",
						RUNNER_TEMP: directory,
						PIONEER_EXTRACTED: directory,
						PIONEER_APPROVAL: JSON.stringify(approval),
						PIONEER_TOOL_RECORD: toolsPath,
						TEST_CAPTURE: captured
					}
				}
			)
			if (runnerEnvironment === "github-hosted") {
				await result
				const environment: unknown = JSON.parse(
					await fs.readFile(captured, "utf8")
				)
				if (!record(environment))
					throw new Error(
						"Read captured publication environment: expected an object"
					)
				expect(environment.RUNNER_ENVIRONMENT).toBe("github-hosted")
				expect(environment.GITHUB_SHA).toBe(identity.source)
				expect(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(
					"synthetic-oidc-token"
				)
				for (const name of [
					"NPM_TOKEN",
					"NODE_AUTH_TOKEN",
					"PIONEER_APPROVAL",
					"TEST_CAPTURE"
				])
					expect(Object.hasOwn(environment, name)).toBe(false)
			} else {
				await expect(result).rejects.toThrow(
					"expected the approved GitHub-hosted runner environment"
				)
				await expect(fs.stat(captured)).rejects.toMatchObject({
					code: "ENOENT"
				})
			}
		})
})

test("actual content collection reconciles only safe equivalent package bin maps", async () => {
	const { script } = await workflowBlock("CONTENTS")
	const install = `
import assert from 'node:assert/strict';
import childProcessMock from 'node:child_process';
import * as fixtureFs from 'node:fs';
import * as fixturePath from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
childProcessMock.execFileSync = (command, args, options) => {
  assert.equal(command, process.execPath);
  assert.equal(args[0], '/trusted/npm-cli.js');
  assert.equal(args[1], 'install');
  assert(args.includes('--ignore-scripts'));
  assert.equal(options.timeout, 600000);
  const platform = args[args.indexOf('--os') + 1];
  const prefix = args[args.indexOf('--prefix') + 1];
  assert.equal(prefix, fixturePath.join(process.env.RUNNER_TEMP, 'content-' + platform));
  assert(['linux', 'darwin', 'win32'].includes(platform));
  const files = JSON.parse(fixtureFs.readFileSync(process.env.TEST_PACKAGE_FILES, 'utf8'));
  for (const file of files) {
    const target = fixturePath.join(prefix, 'lib/node_modules/@vastward/pioneer', file.path);
    fixtureFs.mkdirSync(fixturePath.dirname(target), { recursive: true });
    fixtureFs.writeFileSync(target, file.bytes, { mode: file.mode });
  }
  return Buffer.alloc(0);
};
syncBuiltinESMExports();
`
	for (const scenario of [
		"leading-dot",
		"normalized",
		"unsafe-target",
		"unsafe-command",
		"retarget",
		"missing",
		"extra",
		"unsafe-approved",
		"double-dot-prefix"
	])
		await temporary(async (directory) => {
			const artifact = join(directory, "artifact")
			await fs.mkdir(artifact)
			const rootManifest = JSON.stringify({
				name: "@vastward/pioneer",
				version: "0.0.1",
				bin: { pioneer: "./dist/cli.js" }
			})
			const rootFiles = [
				{ path: "package.json", bytes: rootManifest, mode: 0o644 },
				{ path: "dist/cli.js", bytes: "#!/usr/bin/env node\n", mode: 0o755 }
			]
			const files = [...rootFiles]
			const closure = []
			for (const { name, version, commands } of [
				{
					name: "@bufbuild/buf",
					version: "1.74.0",
					commands: ["buf", "protoc-gen-buf-breaking", "protoc-gen-buf-lint"]
				},
				{ name: "typescript", version: "6.0.3", commands: ["tsc", "tsserver"] }
			]) {
				const bin: Record<string, string> = Object.fromEntries(
					commands.map((command) => [command, `bin/${command}`])
				)
				const raw: Record<string, string> = Object.fromEntries(
					commands.map((command) => [
						command,
						`${scenario === "normalized" ? "" : "./"}bin/${command}`
					])
				)
				if (name === "@bufbuild/buf") {
					if (scenario === "unsafe-target") raw.buf = "../outside"
					if (scenario === "unsafe-command") raw["../buf"] = "./bin/buf"
					if (scenario === "retarget") raw.buf = "./bin/other"
					if (scenario === "missing") delete raw.buf
					if (scenario === "extra") raw.extra = "./bin/buf"
					if (scenario === "unsafe-approved") bin.buf = "../outside"
					if (scenario === "double-dot-prefix") raw.buf = "././bin/buf"
				}
				const path = `node_modules/${name}`
				closure.push({ path, name, version, bin, os: [], cpu: [] })
				files.push({
					path: `${path}/package.json`,
					bytes: JSON.stringify({ name, version, bin: raw }),
					mode: 0o644
				})
				for (const command of commands)
					files.push({
						path: `${path}/bin/${command}`,
						bytes: `#!/usr/bin/env node\n// ${command}\n`,
						mode: 0o755
					})
			}
			await fs.writeFile(
				join(artifact, "candidate.json"),
				JSON.stringify({
					identity,
					members: rootFiles.map(({ path, bytes, mode }) => ({
						path,
						sha256: sha256(bytes),
						mode
					})),
					closure
				})
			)
			const toolsPath = join(directory, "tools.json")
			await fs.writeFile(
				toolsPath,
				JSON.stringify({ npmPath: "/trusted/npm-cli.js" })
			)
			const packageFiles = join(directory, "package-files.json")
			await fs.writeFile(packageFiles, JSON.stringify(files))
			const result = execute(
				"node",
				["--input-type=module", "-e", `${install}\n${script}`],
				{
					cwd: directory,
					timeout: 10000,
					env: {
						...process.env,
						RUNNER_TEMP: directory,
						PIONEER_TOOL_RECORD: toolsPath,
						TEST_PACKAGE_FILES: packageFiles
					}
				}
			)
			if (scenario === "leading-dot" || scenario === "normalized") {
				await result
				const output = JSON.parse(
					await fs.readFile(join(artifact, "contents.json"), "utf8")
				)
				expect(output.platforms["linux/x64"].links).toHaveLength(6)
				expect(output.platforms["win32/x64"].shims).toHaveLength(18)
				expect(
					output.platforms["linux/x64"].links.find((entry: { path: string }) =>
						entry.path.endsWith("/.bin/tsc")
					).target
				).toBe(
					"lib/node_modules/@vastward/pioneer/node_modules/typescript/bin/tsc"
				)
			} else {
				await expect(result).rejects.toThrow()
				await expect(
					fs.stat(join(artifact, "contents.json"))
				).rejects.toMatchObject({ code: "ENOENT" })
			}
		})
})

function githubEnvironment() {
	return {
		GITHUB_REPOSITORY: identity.repository,
		GITHUB_REPOSITORY_ID: identity.repositoryId,
		GITHUB_SHA: identity.source,
		GITHUB_WORKFLOW_SHA: identity.workflowCommit,
		GITHUB_REF: identity.ref,
		GITHUB_RUN_ID: identity.run,
		GITHUB_RUN_ATTEMPT: identity.attempt,
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_WORKFLOW_REF: `${identity.repository}/${identity.workflow}@${identity.ref}`
	}
}

test("identity binds the active interpreter, GitHub event, and complete accepted source", async () => {
	const nodePath = (
		await execute("node", ["-p", "process.execPath"], { timeout: 10000 })
	).stdout.trim()
	for (const scenario of [
		"accepted",
		"source-commit",
		"workflow-commit",
		"event",
		"package-name",
		"source-hash",
		"extra-source",
		"platform",
		"action"
	])
		await temporary(async (directory) => {
			const source = join(directory, "source")
			await fs.mkdir(source)
			const manifest = JSON.stringify({
				name:
					scenario === "package-name" ? "@other/pioneer" : "@vastward/pioneer",
				version: "0.0.1",
				license: "Apache-2.0",
				repository: {
					type: "git",
					url: "https://github.com/dgtlkitchen/pioneer.git"
				}
			})
			await fs.writeFile(join(source, "package.json"), manifest, {
				mode: 0o644
			})
			const inventory = JSON.stringify([
				{ path: "package.json", sha256: sha256(manifest), mode: 0o644 }
			])
			const sourceManifest = join(directory, "source.json")
			await fs.writeFile(sourceManifest, inventory)
			const id = {
				...identity,
				inputSha256:
					scenario === "source-hash" ? "0".repeat(64) : sha256(inventory)
			}
			const actions = {
				checkout: "11d5960a326750d5838078e36cf38b85af677262",
				node: "49933ea5288caeca8642d1e84afbd3f7d6820020",
				bun: "f4d14e03ff726c06358e5557344e1da148b56cf7",
				upload: "ea165f8d65b6e75b540449e92b4886f43607fa02",
				download: "d3f86a106a0bac45b974a628896c90dbdf5c8093"
			}
			if (scenario === "action") actions.download = "a".repeat(40)
			const platform =
				scenario === "platform"
					? process.platform === "win32"
						? "linux"
						: "win32"
					: process.platform
			const input = {
				expected: { identity: id, actions },
				observed: {
					identity: id,
					head: identity.source,
					toolchain: {
						node: "24.22.0",
						npm: "11.19.1",
						bun: "1.4.3",
						nodePath,
						npmPath: "/tools/npm",
						bunPath: "/tools/bun",
						platform,
						arch: process.arch,
						runner:
							process.platform === "darwin"
								? "macos-14"
								: process.platform === "win32"
									? "windows-2022"
									: "ubuntu-24.04",
						image: "fixture-image"
					}
				},
				package: join(source, "package.json"),
				sourceRoot: source,
				sourceManifest
			}
			if (scenario === "extra-source")
				await fs.writeFile(join(source, "unaccepted"), "extra")
			const environment = {
				...process.env,
				...githubEnvironment(),
				GITHUB_SHA:
					scenario === "source-commit" ? "c".repeat(40) : identity.source,
				GITHUB_WORKFLOW_SHA:
					scenario === "workflow-commit"
						? "c".repeat(40)
						: identity.workflowCommit,
				GITHUB_EVENT_NAME: scenario === "event" ? "push" : "workflow_dispatch"
			}
			if (scenario === "accepted")
				await invoke(directory, "identity", input, helper, environment)
			else
				await expect(
					invoke(directory, "identity", input, helper, environment)
				).rejects.toThrow()
		})
})

const fetchFixture = `
import assert from 'node:assert/strict';
const scenario = process.env.TEST_SCENARIO;
if (scenario === 'timeout' || scenario === 'body-timeout') {
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 20000 || delay === 100000 ? 1 : delay, ...args);
}
let calls = 0;
globalThis.fetch = async (input, options) => {
  calls++;
  const url = String(input);
  assert.equal(options.redirect, 'manual');
  if (url.startsWith('https://api.github.com/')) {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    assert(url === 'https://api.github.com/repos/dgtlkitchen/pioneer/actions/artifacts/321' || url === 'https://api.github.com/repos/dgtlkitchen/pioneer/actions/artifacts/321/zip');
    if (scenario === 'timeout') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('signed-secret'))));
    if (!url.endsWith('/zip')) return new Response(JSON.stringify({ id: 321, expired: false, workflow_run: { id: 123, repository_id: 1420539345, head_sha: 'a'.repeat(40) } }));
    if (scenario === 'api-status') return new Response('', { status: 403 });
    if (scenario === 'missing-location') return new Response('', { status: 302 });
    return new Response('', { status: 302, headers: { location: scenario === 'unsafe-location' ? 'https://user:password@storage.invalid/blob' : 'https://storage.invalid/blob?signed-secret=fixture' } });
  }
  assert.equal(url, 'https://storage.invalid/blob?signed-secret=fixture');
  assert.equal(options.headers, undefined);
  assert.equal(options.credentials, 'omit');
  assert.equal(calls, 3);
  if (scenario === 'second-redirect') return new Response('', { status: 302, headers: { location: 'https://unapproved.invalid' } });
  if (scenario === 'body-timeout') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('z')); options.signal.addEventListener('abort', () => controller.error(new Error('signed-secret'))); } }));
  if (scenario === 'partial-write') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('z')); controller.error(new Error('signed-secret')); } }));
  if (scenario === 'oversized-header') return new Response('zip', { headers: { 'content-length': '536870913' } });
  if (scenario === 'oversized-stream') return new Response('too-many-bytes', { headers: { 'content-length': '1' } });
  return new Response('zip');
};
`

test("actual workflow transport verifies raw bytes and never forwards API credentials", async () => {
	const script = await workflowScript("PIONEER_TRANSPORT")
	await temporary(async (directory) => {
		const control = {
			identity,
			artifacts: [{ id: "321", archiveSha256: sha256("zip"), maxBytes: 8 }]
		}
		const archives = join(directory, "archives")
		const result = await execute(
			"node",
			["--input-type=module", "-e", `${fetchFixture}\n${script}`],
			{
				timeout: 10000,
				maxBuffer: 1024 * 1024,
				env: {
					...process.env,
					...githubEnvironment(),
					GITHUB_TOKEN: "synthetic-token",
					PIONEER_TRANSFER: JSON.stringify(control),
					PIONEER_ARCHIVES: archives
				}
			}
		)
		expect(await fs.readFile(join(archives, "321.zip"), "utf8")).toBe("zip")
		expect(result.stdout).not.toContain("signed-secret")
		expect(result.stdout).not.toContain("synthetic-token")
		expect(result.stderr).toBe("")
	})
})

test("actual workflow transport fails closed on unsafe identities and failed streams", async () => {
	const script = await workflowScript("PIONEER_TRANSPORT")
	for (const scenario of [
		"api-status",
		"missing-location",
		"unsafe-location",
		"second-redirect",
		"oversized-header",
		"oversized-stream",
		"partial-write",
		"timeout",
		"body-timeout",
		"digest",
		"existing",
		"invalid-id",
		"unsafe-id",
		"identity",
		"missing-token",
		"oversized-control"
	])
		await temporary(async (directory) => {
			const archives = join(directory, "archives")
			if (scenario === "existing") await fs.mkdir(archives)
			const id =
				scenario === "invalid-id"
					? "0321"
					: scenario === "unsafe-id"
						? "9007199254740993"
						: "321"
			const control = {
				identity,
				artifacts: [
					{
						id,
						archiveSha256:
							scenario === "digest" ? "0".repeat(64) : sha256("zip"),
						maxBytes: 8
					}
				]
			}
			try {
				await execute(
					"node",
					["--input-type=module", "-e", `${fetchFixture}\n${script}`],
					{
						timeout: 10000,
						maxBuffer: 1024 * 1024,
						env: {
							...process.env,
							...githubEnvironment(),
							GITHUB_SHA:
								scenario === "identity" ? "c".repeat(40) : identity.source,
							TEST_SCENARIO: scenario,
							GITHUB_TOKEN:
								scenario === "missing-token" ? "" : "synthetic-token",
							PIONEER_TRANSFER:
								scenario === "oversized-control"
									? " ".repeat(8193)
									: JSON.stringify(control),
							PIONEER_ARCHIVES: archives
						}
					}
				)
				throw new Error("Transport unexpectedly accepted a rejected fixture")
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!("stderr" in error) ||
					typeof error.stderr !== "string"
				)
					throw error
				expect(error.stderr).not.toContain("https://storage.invalid")
				expect(error.stderr).not.toContain("Bearer synthetic-token")
			}
			await expect(fs.stat(join(archives, "321.zip"))).rejects.toMatchObject({
				code: "ENOENT"
			})
		})
})

test("actual workflow bootstrap imports only independently verified bytes", async () => {
	const script = await workflowScript("PIONEER_BOOTSTRAP")
	for (const scenario of [
		"accepted",
		"fixture",
		"fixture-digest",
		"helper-digest",
		"missing-digest",
		"archive-digest",
		"artifact-set",
		"source",
		"run",
		"attempt"
	])
		await temporary(async (directory) => {
			const extracted = join(directory, "extracted")
			const archives = join(directory, "archives")
			await fs.mkdir(extracted)
			await fs.mkdir(archives)
			const isFixture = scenario.startsWith("fixture")
			const verifier = isFixture ? "installed-cli.mjs" : "release.mjs"
			const bytes = isFixture
				? "import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs'; for (const key of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NODE_PATH', 'PIONEER_TRANSFER', 'TEST_MARKER']) assert.equal(process.env[key], undefined); assert.equal(process.env.CI, 'true'); writeFileSync(process.argv[6], 'executed', { flag: 'wx' });"
				: "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.TEST_MARKER, 'executed', { flag: 'wx' });"
			await fs.writeFile(join(extracted, verifier), bytes)
			await fs.writeFile(join(archives, "321.zip"), "zip")
			const control = {
				identity,
				helperSha256:
					scenario === "helper-digest"
						? "0".repeat(64)
						: scenario === "missing-digest"
							? undefined
							: sha256(bytes),
				artifacts: [
					{
						id: "321",
						archiveSha256:
							scenario === "archive-digest" ? "0".repeat(64) : sha256("zip"),
						files: [
							{
								path: verifier,
								sha256:
									scenario === "fixture-digest"
										? "0".repeat(64)
										: sha256(bytes),
								mode: 0o644
							}
						]
					}
				]
			}
			const marker = join(directory, "marker")
			const result = execute("node", ["--input-type=module", "-e", script], {
				timeout: 10000,
				maxBuffer: 1024 * 1024,
				env: {
					...process.env,
					...githubEnvironment(),
					GITHUB_SHA: scenario === "source" ? "c".repeat(40) : identity.source,
					GITHUB_RUN_ID: scenario === "run" ? "999" : identity.run,
					GITHUB_RUN_ATTEMPT: scenario === "attempt" ? "2" : identity.attempt,
					GITHUB_TOKEN: "synthetic-token",
					ACTIONS_RUNTIME_TOKEN: "synthetic-runtime-token",
					NODE_PATH: directory,
					RUNNER_TEMP: directory,
					PIONEER_TRANSFER: JSON.stringify(control),
					PIONEER_ARCHIVES: archives,
					PIONEER_EXTRACTED: extracted,
					PIONEER_EXTRACTED_IDS:
						scenario === "artifact-set" ? "321,999" : "321",
					PIONEER_VERIFIER: verifier,
					PIONEER_MODE: "transfer",
					PIONEER_INPUT: "input.json",
					PIONEER_OUTPUT: marker,
					TEST_MARKER: marker
				}
			})
			if (scenario === "accepted" || scenario === "fixture") {
				await result
				expect(await fs.readFile(marker, "utf8")).toBe("executed")
			} else {
				await expect(result).rejects.toThrow()
				await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
			}
		})
})

async function candidate(directory: string) {
	const source = join(directory, "source")
	const build = join(directory, "build")
	const staging = join(directory, "staging")
	await Promise.all([source, build, staging].map((path) => fs.mkdir(path)))
	const dependencies = {
		"@bufbuild/buf": "1.74.0",
		"@bufbuild/protoc-gen-es": "2.16.0"
	}
	const optionalDependencies = Object.fromEntries(
		["darwin-arm64", "linux-x64", "win32-x64"].map((platform) => [
			`@bufbuild/buf-${platform}`,
			"1.74.0"
		])
	)
	const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`
	const bunPackages: Record<string, unknown> = {}
	const npmPackages: Record<string, unknown> = { "": { dependencies } }
	for (const name of ["@bufbuild/buf", ...Object.keys(optionalDependencies)]) {
		const metadata = name === "@bufbuild/buf" ? { optionalDependencies } : {}
		bunPackages[name] = [`${name}@1.74.0`, "", metadata, integrity]
		const path = `node_modules/${name}`
		const resolved = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-1.74.0.tgz`
		npmPackages[path] = { version: "1.74.0", resolved, integrity, ...metadata }
	}
	for (const name of ["@bufbuild/protoc-gen-es", "@bufbuild/protobuf"]) {
		const metadata =
			name === "@bufbuild/protoc-gen-es"
				? { dependencies: { "@bufbuild/protobuf": "2.16.0" } }
				: {}
		bunPackages[name] = [`${name}@2.16.0`, "", metadata, integrity]
		const peers =
			name === "@bufbuild/protoc-gen-es"
				? {
						peerDependencies: { "@bufbuild/protobuf": "2.16.0" },
						peerDependenciesMeta: { "@bufbuild/protobuf": { optional: true } }
					}
				: {}
		npmPackages[`node_modules/${name}`] = {
			version: "2.16.0",
			resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-2.16.0.tgz`,
			integrity,
			...metadata,
			...peers
		}
	}
	const lock = JSON.stringify({
		workspaces: { "": { name: "@vastward/pioneer", dependencies } },
		packages: bunPackages
	})
	const shrinkwrap = JSON.stringify({
		name: "@vastward/pioneer",
		version: "0.0.1",
		lockfileVersion: 3,
		packages: npmPackages
	})
	const manifest = JSON.stringify({
		name: "@vastward/pioneer",
		version: "0.0.1",
		license: "Apache-2.0",
		bin: { pioneer: "./dist/cli.js" },
		dependencies
	})
	const buildFiles = [
		{ path: "cli.js", bytes: "#!/usr/bin/env node\n" },
		{ path: "index.js", bytes: "export const fixture = true\n" },
		{
			path: "types/index.d.ts",
			bytes: "export declare const fixture: boolean\n"
		}
	]
	const contents = [
		{ path: "package.json", bytes: manifest },
		{ path: "LICENSE", bytes: "synthetic license fixture" },
		{ path: "npm-shrinkwrap.json", bytes: shrinkwrap },
		...buildFiles.map((entry) => ({ ...entry, path: `dist/${entry.path}` })),
		...[
			"comet",
			"react-options",
			"transaction",
			"rest",
			"message",
			"rpc",
			"react-context"
		].map((name) => ({
			path: `src/runtime/${name}.ts`,
			bytes: `// frozen ${name} fixture\n`
		}))
	]
	for (const entry of contents) {
		await fs.mkdir(dirname(join(staging, entry.path)), { recursive: true })
		await fs.writeFile(join(staging, entry.path), entry.bytes, {
			mode: entry.path === "dist/cli.js" ? 0o755 : 0o644
		})
	}
	for (const entry of buildFiles) {
		await fs.mkdir(dirname(join(build, entry.path)), { recursive: true })
		await fs.writeFile(join(build, entry.path), entry.bytes, {
			mode: entry.path === "cli.js" ? 0o755 : 0o644
		})
	}
	await fs.writeFile(join(source, "bun.lock"), lock, { mode: 0o644 })
	await fs.writeFile(join(source, "package.json"), manifest, { mode: 0o644 })
	const inputManifest = join(directory, "inputs.json")
	const sourceEntries = [
		{ path: "bun.lock", sha256: sha256(lock), mode: 0o644 },
		{ path: "package.json", sha256: sha256(manifest), mode: 0o644 }
	]
	for (const entry of contents) {
		if (
			entry.path.startsWith("dist/") ||
			["package.json", "npm-shrinkwrap.json"].includes(entry.path)
		)
			continue
		await fs.mkdir(dirname(join(source, entry.path)), { recursive: true })
		await fs.writeFile(join(source, entry.path), entry.bytes, { mode: 0o644 })
		sourceEntries.push({
			path: entry.path,
			sha256: sha256(entry.bytes),
			mode: 0o644
		})
	}
	const sourceBytes = JSON.stringify(sourceEntries)
	await fs.writeFile(inputManifest, sourceBytes)
	const tarball = join(directory, "pioneer.tgz")
	await fs.writeFile(tarball, "synthetic opaque package")
	const packedIntegrity = `sha512-${createHash("sha512").update("synthetic opaque package").digest("base64")}`
	const members = contents.map(({ path, bytes }) => ({
		path,
		sha256: sha256(bytes),
		mode: path === "dist/cli.js" ? 0o755 : 0o644
	}))
	const pack = join(directory, "pack.json")
	await fs.writeFile(
		pack,
		JSON.stringify([
			{
				name: "@vastward/pioneer",
				version: "0.0.1",
				integrity: packedIntegrity,
				files: members.map(({ path, mode }) => ({ path, mode }))
			}
		])
	)
	return {
		approval: {
			identity: { ...identity, inputSha256: sha256(sourceBytes) },
			toolchain: {
				node: "24.22.0",
				npm: "11.19.1",
				bun: "1.4.3",
				nodePath: "/tools/node",
				npmPath: "/tools/npm",
				bunPath: "/tools/bun",
				platform: "linux",
				arch: "x64",
				runner: "ubuntu-24.04",
				image: "fixture-image"
			},
			actions: {
				checkout: "11d5960a326750d5838078e36cf38b85af677262",
				node: "49933ea5288caeca8642d1e84afbd3f7d6820020",
				bun: "f4d14e03ff726c06358e5557344e1da148b56cf7",
				upload: "ea165f8d65b6e75b540449e92b4886f43607fa02",
				download: "d3f86a106a0bac45b974a628896c90dbdf5c8093"
			},
			source: sourceEntries,
			build: buildFiles.map(({ path, bytes }) => ({
				path,
				sha256: sha256(bytes),
				mode: path === "cli.js" ? 0o755 : 0o644
			})),
			members,
			lockSha256: sha256(lock),
			inputManifest,
			inputManifestSha256: sha256(sourceBytes)
		},
		source,
		build,
		staging,
		manifest: join(staging, "package.json"),
		bunLock: join(source, "bun.lock"),
		shrinkwrap: join(staging, "npm-shrinkwrap.json"),
		pack,
		tarball
	}
}

test("candidate binds one tested build, package members, and exact runtime resolutions", async () => {
	await temporary(async (directory) => {
		const input = await candidate(directory)
		await invoke(directory, "candidate", input)
		const output = JSON.parse(
			await fs.readFile(join(directory, "output.json"), "utf8")
		)
		expect(
			output.closure.map((entry: { name: string }) => entry.name).sort()
		).toEqual([
			"@bufbuild/buf",
			"@bufbuild/buf-darwin-arm64",
			"@bufbuild/buf-linux-x64",
			"@bufbuild/buf-win32-x64",
			"@bufbuild/protobuf",
			"@bufbuild/protoc-gen-es"
		])
		expect(output.tarball.sha256).toBe(sha256("synthetic opaque package"))
		expect(output.members).toEqual(input.approval.members)
	})
})

test("candidate rejects lock drift, missing platform closure, altered build, and package contamination", async () => {
	for (const scenario of [
		"root-name",
		"closure-version",
		"closure-integrity",
		"platform-omission",
		"build",
		"packed-member",
		"pack-mode",
		"helper-member",
		"source-inventory",
		"source-member",
		"peer-required",
		"peer-version",
		"peer-range",
		"peer-ordinary-absent",
		"peer-resolution"
	])
		await temporary(async (directory) => {
			const input = await candidate(directory)
			if (scenario === "root-name") {
				const lock = JSON.parse(await fs.readFile(input.bunLock, "utf8"))
				lock.workspaces[""].name = "@buildonjuno/pioneer"
				const bytes = JSON.stringify(lock)
				await fs.writeFile(input.bunLock, bytes)
				input.approval.lockSha256 = sha256(bytes)
				input.approval.source[0].sha256 = sha256(bytes)
				const sourceBytes = JSON.stringify(input.approval.source)
				await fs.writeFile(input.approval.inputManifest, sourceBytes)
				input.approval.inputManifestSha256 = sha256(sourceBytes)
				input.approval.identity.inputSha256 = sha256(sourceBytes)
			}
			if (scenario.startsWith("closure-") || scenario === "platform-omission") {
				const lock = JSON.parse(await fs.readFile(input.shrinkwrap, "utf8"))
				if (scenario === "closure-version")
					lock.packages["node_modules/@bufbuild/buf"].version = "1.61.0"
				if (scenario === "closure-integrity")
					lock.packages["node_modules/@bufbuild/buf"].integrity =
						`sha512-${Buffer.alloc(64, 1).toString("base64")}`
				if (scenario === "platform-omission")
					delete lock.packages["node_modules/@bufbuild/buf-win32-x64"]
				const bytes = JSON.stringify(lock)
				await fs.writeFile(input.shrinkwrap, bytes)
				const member = input.approval.members.find(
					(entry) => entry.path === "npm-shrinkwrap.json"
				)
				if (!member)
					throw new Error("Read candidate fixture: missing shrinkwrap member")
				member.sha256 = sha256(bytes)
			}
			if (scenario === "build")
				await fs.writeFile(join(input.build, "index.js"), "altered build")
			if (scenario === "packed-member") {
				const packed = JSON.parse(await fs.readFile(input.pack, "utf8"))
				packed[0].files.pop()
				await fs.writeFile(input.pack, JSON.stringify(packed))
			}
			if (scenario === "pack-mode") {
				const packed = JSON.parse(await fs.readFile(input.pack, "utf8"))
				const cli = packed[0].files.find(
					(entry: { path: string }) => entry.path === "dist/cli.js"
				)
				if (!cli) throw new Error("Read candidate fixture: missing packed CLI")
				cli.mode = 0o644
				await fs.writeFile(input.pack, JSON.stringify(packed))
			}
			if (scenario.startsWith("peer-")) {
				const npm = JSON.parse(await fs.readFile(input.shrinkwrap, "utf8"))
				const bun = JSON.parse(await fs.readFile(input.bunLock, "utf8"))
				const plugin = npm.packages["node_modules/@bufbuild/protoc-gen-es"]
				if (scenario === "peer-required")
					plugin.peerDependenciesMeta["@bufbuild/protobuf"].optional = false
				if (scenario === "peer-version")
					plugin.peerDependencies["@bufbuild/protobuf"] = "2.10.2"
				if (scenario === "peer-range")
					plugin.peerDependencies["@bufbuild/protobuf"] = "^2.10.1"
				if (scenario === "peer-ordinary-absent") {
					delete plugin.dependencies["@bufbuild/protobuf"]
					delete bun.packages["@bufbuild/protoc-gen-es"][2].dependencies[
						"@bufbuild/protobuf"
					]
				}
				if (scenario === "peer-resolution") {
					npm.packages["node_modules/@bufbuild/protobuf"].version = "2.10.2"
					npm.packages["node_modules/@bufbuild/protobuf"].resolved =
						"https://registry.npmjs.org/@bufbuild/protobuf/-/protobuf-2.10.2.tgz"
					bun.packages["@bufbuild/protobuf"][0] = "@bufbuild/protobuf@2.10.2"
				}
				const npmBytes = JSON.stringify(npm)
				await fs.writeFile(input.shrinkwrap, npmBytes)
				const member = input.approval.members.find(
					(entry) => entry.path === "npm-shrinkwrap.json"
				)
				if (!member)
					throw new Error("Read candidate fixture: missing shrinkwrap member")
				member.sha256 = sha256(npmBytes)
				const bunBytes = JSON.stringify(bun)
				await fs.writeFile(input.bunLock, bunBytes)
				input.approval.lockSha256 = sha256(bunBytes)
				input.approval.source[0].sha256 = sha256(bunBytes)
				const sourceBytes = JSON.stringify(input.approval.source)
				await fs.writeFile(input.approval.inputManifest, sourceBytes)
				input.approval.inputManifestSha256 = sha256(sourceBytes)
				input.approval.identity.inputSha256 = sha256(sourceBytes)
			}
			if (scenario === "helper-member") {
				await fs.writeFile(
					join(input.staging, "src/release.mjs"),
					"unexpected helper"
				)
			}
			if (scenario === "source-inventory")
				input.approval.source[0].sha256 = "0".repeat(64)
			if (scenario === "source-member") {
				const entry = input.approval.members.find(
					(member) => member.path === "LICENSE"
				)
				if (!entry) throw new Error("Read candidate fixture: missing license")
				await fs.writeFile(join(input.staging, "LICENSE"), "changed license")
				entry.sha256 = sha256("changed license")
			}
			await expect(invoke(directory, "candidate", input)).rejects.toThrow()
			await expect(
				fs.stat(join(directory, "output.json"))
			).rejects.toMatchObject({ code: "ENOENT" })
		})
}, 60_000)

async function provenance(
	directory: string,
	certificate: string,
	ref = identity.ref
) {
	const fixtureIdentity = { ...identity, ref }
	const tarball = "synthetic registry package bytes"
	const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`
	const candidateBytes = JSON.stringify({
		identity: fixtureIdentity,
		tarball: { sha256: sha256(tarball), integrity }
	})
	const matrixBytes = JSON.stringify({
		identity: fixtureIdentity,
		candidateSha256: sha256(candidateBytes),
		receipts: []
	})
	const candidatePath = join(directory, "candidate.json")
	const matrixPath = join(directory, "matrix.json")
	const registryTarball = join(directory, "pioneer.tgz")
	await fs.writeFile(candidatePath, candidateBytes)
	await fs.writeFile(matrixPath, matrixBytes)
	await fs.writeFile(registryTarball, tarball)
	const expected = {
		identity: fixtureIdentity,
		candidateSha256: sha256(candidateBytes),
		matrixSha256: sha256(matrixBytes),
		tarballSha256: sha256(tarball),
		integrity,
		signer: `https://github.com/${identity.repository}/${identity.workflow}@${ref}`,
		artifacts: [
			{
				id: "321",
				archiveSha256: "d".repeat(64),
				files: [
					{
						path: "candidate.json",
						sha256: sha256(candidateBytes),
						mode: 0o644
					},
					{ path: "pioneer.tgz", sha256: sha256(tarball), mode: 0o644 }
				]
			},
			{
				id: "322",
				archiveSha256: "e".repeat(64),
				files: [
					{ path: "matrix.json", sha256: sha256(matrixBytes), mode: 0o644 }
				]
			}
		]
	}
	const statement = {
		_type: "https://in-toto.io/Statement/v1",
		predicateType: "https://slsa.dev/provenance/v1",
		subject: [
			{
				name: "pkg:npm/%40vastward/pioneer@0.0.1",
				digest: { sha512: createHash("sha512").update(tarball).digest("hex") }
			}
		],
		predicate: {
			buildDefinition: {
				buildType:
					"https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
				externalParameters: {
					workflow: {
						ref,
						repository: `https://github.com/${identity.repository}`,
						path: identity.workflow
					}
				},
				internalParameters: {
					github: {
						repository_id: identity.repositoryId,
						event_name: "workflow_dispatch"
					}
				},
				resolvedDependencies: [
					{
						uri: `git+https://github.com/${identity.repository}@${ref}`,
						digest: { gitCommit: identity.source }
					}
				]
			},
			runDetails: {
				builder: { id: "https://github.com/actions/runner/github-hosted" },
				metadata: {
					invocationId: `https://github.com/${identity.repository}/actions/runs/${identity.run}/attempts/${identity.attempt}`
				}
			}
		}
	}
	const bundle = {
		mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
		dsseEnvelope: {
			payloadType: "application/vnd.in-toto+json",
			payload: Buffer.from(JSON.stringify(statement)).toString("base64")
		},
		verificationMaterial: { certificate: { rawBytes: certificate } }
	}
	const audit: {
		invalid: string[]
		missing: string[]
		verified: {
			name: string
			version: string
			registry: string
			attestationBundles: { predicateType: string; bundle: typeof bundle }[]
		}[]
	} = {
		invalid: [],
		missing: [],
		verified: [
			{
				name: "@vastward/pioneer",
				version: "0.0.1",
				registry: "https://registry.npmjs.org/",
				attestationBundles: [
					{ predicateType: "https://slsa.dev/provenance/v1", bundle }
				]
			}
		]
	}
	return {
		input: {
			expected,
			audit: join(directory, "audit.json"),
			registryTarball,
			candidate: candidatePath,
			matrix: matrixPath
		},
		audit,
		statement,
		bundle
	}
}

// This fixed public certificate tests claims, not npm/Sigstore trust or current certificate validity.
const claimCertificate =
	"MIIDODCCAiCgAwIBAgIJAJTxfvx3QmrjMA0GCSqGSIb3DQEBCwUAMCkxJzAlBgNVBAMMHlBpb25lZXIgc3ludGhldGljIHVuaXQgZml4dHVyZTAeFw0yNjEwMTUxMjUyMDFaFw0yNjEwMTYxMjUyMDFaMCkxJzAlBgNVBAMMHlBpb25lZXIgc3ludGhldGljIHVuaXQgZml4dHVyZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJyttTDhKG/qYKCdVyhudwz+6c9lorOOsfTCo/quMm5AtXtxKLFzLUUo0Xy3mUx22mDIZSbxrdVb7DQ6lLw+79aA3M3gQ+HbKl/uwkwOor0lB+VuUEhyUDGwAFp4Qvl3GDdz54DcYQcssU9/b3NqLlxbK8Y60cnUaLUQMEg9GVW5TeGAVJA7JjD+bzBdshBOomQEI0Di7HwE/lXIqgy+l/Vy7JdeLa05LxvhQ2koHk+N6o++KEPssvJmRyaScKG7THI01NEivSoDKtVecy5C1GmLxn/08TIfZkSUeCdCJ+R6098BiqAHvLMq+IPLwLydLdN798eQaTL+9XV25NYasxUCAwEAAaNjMGEwXwYDVR0RBFgwVoZUaHR0cHM6Ly9naXRodWIuY29tL2RndGxraXRjaGVuL3Bpb25lZXIvLmdpdGh1Yi93b3JrZmxvd3MvcmVsZWFzZS55bWxAcmVmcy9oZWFkcy9tYWluMA0GCSqGSIb3DQEBCwUAA4IBAQCN1iAn4Lh2YNPrURak2vzPjH55rFUoZ6lEVpqTeiWxzbpX4VDZwdUOLmuChKkm257EmzgJECSa7qVHuMzZiji9EgwgT7jBbX0ht/kmYBu2bwCCucUJxorRICz2FIdp8AdQR7qheyNP7sVK8miU6lKgy7+u9Qqssyot0FmJQGeyowbUUEnTaAiJGi43PF7fm0Mb7OT3JX8kXSvS7VUzPiaUvG4SImmn3YLa+0EsjwSgXnmLQmJ3u1wuy/yhsEQjmDTHvnM1wyZ2b95K4bAGiQDODJRxlGapPsrfUc29EZ25zdQQmS6CjcUlT2E1TiFPQk+RbNVuB9B7r7dP5tzd2i+5"

type CertificateMaterial =
	| { certificate: { rawBytes: string } }
	| { x509CertificateChain: { certificates: { rawBytes: string }[] } }

test("provenance parses both certificate representations in synthetic trusted-audit claims", async () => {
	expect(sha256(Buffer.from(claimCertificate, "base64"))).toBe(
		"ceb9015b83543f356fd10b1b6ef71eabe9a6e4a5e0b0120d795ebe50bf739cae"
	)
	const representations: {
		mediaType: string
		material: CertificateMaterial
	}[] = [
		{
			mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
			material: { certificate: { rawBytes: claimCertificate } }
		},
		{
			mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
			material: {
				x509CertificateChain: { certificates: [{ rawBytes: claimCertificate }] }
			}
		}
	]
	for (const { mediaType, material } of representations)
		for (const ref of [identity.ref, "refs/heads/other"])
			await temporary(async (directory) => {
				const value = await provenance(directory, claimCertificate, ref)
				const audit = {
					...value.audit,
					verified: value.audit.verified.map((entry) => ({
						...entry,
						attestationBundles: entry.attestationBundles.map((attestation) => ({
							...attestation,
							bundle: {
								...attestation.bundle,
								mediaType,
								verificationMaterial: material
							}
						}))
					}))
				}
				await fs.writeFile(value.input.audit, JSON.stringify(audit))
				const result = invoke(directory, "provenance", value.input)
				if (ref === identity.ref) {
					await result
					expect(
						JSON.parse(
							await fs.readFile(join(directory, "output.json"), "utf8")
						)
					).toEqual(value.input.expected)
				} else {
					await expect(result).rejects.toThrow("verified signer SAN")
					await expect(
						fs.stat(join(directory, "output.json"))
					).rejects.toMatchObject({ code: "ENOENT" })
				}
			})
})

test("provenance rejects ambiguous and malformed certificate representations", async () => {
	const scenarios: { material: unknown; error: string }[] = [
		{ material: {}, error: "expected exactly one certificate representation" },
		{
			material: {
				certificate: { rawBytes: claimCertificate },
				x509CertificateChain: { certificates: [{ rawBytes: claimCertificate }] }
			},
			error: "expected exactly one certificate representation"
		},
		{ material: { certificate: null }, error: "X.509 chain" },
		{ material: { certificate: {} }, error: "certificate DER" },
		{ material: { certificate: { rawBytes: 1 } }, error: "certificate DER" },
		{
			material: { certificate: { rawBytes: "invalid-base64" } },
			error: "certificate base64"
		},
		{
			material: { x509CertificateChain: { certificates: [] } },
			error: "certificate"
		},
		{
			material: {
				x509CertificateChain: {
					certificates: Array.from({ length: 17 }, () => ({
						rawBytes: claimCertificate
					}))
				}
			},
			error: "certificate chain"
		},
		{
			material: {
				x509CertificateChain: {
					certificates: [
						{ rawBytes: "invalid-base64" },
						{ rawBytes: claimCertificate }
					]
				}
			},
			error: "certificate base64"
		}
	]
	for (const { material, error } of scenarios)
		await temporary(async (directory) => {
			const value = await provenance(directory, claimCertificate)
			const audit = {
				...value.audit,
				verified: value.audit.verified.map((entry) => ({
					...entry,
					attestationBundles: entry.attestationBundles.map((attestation) => ({
						...attestation,
						bundle: { ...attestation.bundle, verificationMaterial: material }
					}))
				}))
			}
			await fs.writeFile(value.input.audit, JSON.stringify(audit))
			await expect(
				invoke(directory, "provenance", value.input)
			).rejects.toThrow(error)
			await expect(
				fs.stat(join(directory, "output.json"))
			).rejects.toMatchObject({ code: "ENOENT" })
		})
})

test("provenance rejects mismatched audit claims and external artifact identities", async () => {
	const scenarios = [
		["invalid", "invalid signatures"],
		["missing", "missing signatures"],
		["missing-candidate", "verified candidate"],
		["registry", "verified registry"],
		["subject", "attested package subject"],
		["repository", "attested repository ID"],
		["source", "attested source"],
		["workflow", "attested workflow"],
		["attempt", "attested invocation"],
		["artifact", "external artifact digest"],
		["tarball", "registry bytes"],
		["certificate", "certificate base64"],
		["bundle", "unsupported media type"],
		["payload", "DSSE payload type"],
		["duplicate-artifact", "registry artifact uniqueness"]
	]
	for (const [scenario, error] of scenarios)
		await temporary(async (directory) => {
			const value = await provenance(directory, "invalid-base64")
			if (scenario === "invalid") value.audit.invalid.push("invalid signature")
			if (scenario === "missing") value.audit.missing.push("missing signature")
			if (scenario === "missing-candidate") value.audit.verified = []
			if (scenario === "registry")
				value.audit.verified[0].registry = "https://other.invalid/"
			if (scenario === "subject")
				value.statement.subject[0].digest.sha512 = "0".repeat(128)
			if (scenario === "repository")
				value.statement.predicate.buildDefinition.internalParameters.github.repository_id =
					"9"
			if (scenario === "source")
				value.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
					"c".repeat(40)
			if (scenario === "workflow")
				value.statement.predicate.buildDefinition.externalParameters.workflow.path =
					".github/workflows/other.yml"
			if (scenario === "attempt")
				value.statement.predicate.runDetails.metadata.invocationId = `https://github.com/${identity.repository}/actions/runs/123/attempts/2`
			if (scenario === "artifact")
				value.input.expected.artifacts[0].files[0].sha256 = "0".repeat(64)
			if (scenario === "duplicate-artifact")
				value.input.expected.artifacts[1].id =
					value.input.expected.artifacts[0].id
			if (scenario === "tarball")
				await fs.writeFile(value.input.registryTarball, "wrong registry bytes")
			if (scenario === "bundle")
				value.bundle.mediaType = "application/unsupported"
			if (scenario === "payload")
				value.bundle.dsseEnvelope.payloadType = "text/plain"
			value.bundle.dsseEnvelope.payload = Buffer.from(
				JSON.stringify(value.statement)
			).toString("base64")
			await fs.writeFile(value.input.audit, JSON.stringify(value.audit))
			await expect(
				invoke(directory, "provenance", value.input)
			).rejects.toThrow(error)
			await expect(
				fs.stat(join(directory, "output.json"))
			).rejects.toMatchObject({ code: "ENOENT" })
		})
})
