import { createHash, X509Certificate } from "node:crypto"
import { createReadStream } from "node:fs"
import {
	lstat,
	open,
	opendir,
	readFile,
	readlink,
	realpath
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"

const limit = 8 * 1024 * 1024
const maximumMembers = 50000
const packageName = "@vastward/pioneer"
const version = "0.0.1"
const repository = "dgtlkitchen/pioneer"
const workflow = ".github/workflows/release.yml"
const actions = {
	checkout: "11d5960a326750d5838078e36cf38b85af677262",
	node: "49933ea5288caeca8642d1e84afbd3f7d6820020",
	bun: "f4d14e03ff726c06358e5557344e1da148b56cf7",
	upload: "ea165f8d65b6e75b540449e92b4886f43607fa02",
	download: "d3f86a106a0bac45b974a628896c90dbdf5c8093"
}
const cells = [
	["darwin", "arm64", "macos-14"],
	["linux", "x64", "ubuntu-24.04"],
	["win32", "x64", "windows-2022"]
].flatMap(([platform, arch, runner]) =>
	["20.19.0", "24.22.0"].map((node) => ({ platform, arch, runner, node }))
)

function requireValue(condition, input, cause) {
	if (!condition) throw new Error(`Validate release ${input}: ${cause}`)
}

function object(value, input) {
	requireValue(
		value !== null && typeof value === "object" && !Array.isArray(value),
		input,
		"expected an object"
	)
	return value
}

function fields(value, names, input) {
	object(value, input)
	requireValue(
		isDeepStrictEqual(Object.keys(value).sort(), [...names].sort()),
		input,
		"unexpected or missing fields"
	)
	return value
}

function text(value, input) {
	requireValue(
		typeof value === "string" &&
			value.length > 0 &&
			value.length <= 4096 &&
			Array.from(value).every(
				(character) =>
					character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127
			),
		input,
		"expected bounded text"
	)
	return value
}

function array(value, input, maximum = maximumMembers) {
	requireValue(
		Array.isArray(value) && value.length <= maximum,
		input,
		"expected a bounded array"
	)
	return value
}

function equal(actual, expected, input) {
	requireValue(
		isDeepStrictEqual(actual, expected),
		input,
		"value differs from independent approval"
	)
}

function digest(value, input) {
	requireValue(
		typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
		input,
		"expected SHA-256"
	)
	return value
}

function decimal(value, input) {
	requireValue(
		typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value),
		input,
		"expected a positive decimal identity"
	)
	return value
}

function member(value) {
	text(value, "member path")
	requireValue(
		!isAbsolute(value) &&
			!/[\\:]/.test(value) &&
			value
				.split("/")
				.every((part) => part !== "" && part !== "." && part !== ".."),
		"member path",
		"unsafe relative path"
	)
	return value
}

function inside(root, target) {
	const path = relative(root, target)
	requireValue(
		path !== "" &&
			!isAbsolute(path) &&
			path !== ".." &&
			!path.startsWith(`..${sep}`),
		"file boundary",
		"target escapes its accepted root"
	)
}

async function regular(path) {
	const info = await lstat(path)
	requireValue(
		info.isFile() && !info.isSymbolicLink(),
		"file",
		"expected a regular file"
	)
	return info
}

async function json(path) {
	const info = await regular(path)
	requireValue(info.size <= limit, "JSON input", "exceeds eight MiB")
	const handle = await open(path, "r")
	try {
		const current = await handle.stat()
		requireValue(
			current.dev === info.dev &&
				current.ino === info.ino &&
				current.size === info.size,
			"JSON input",
			"file changed before read"
		)
		const bytes = Buffer.alloc(limit + 1)
		let length = 0
		while (length < bytes.length) {
			const read = await handle.read(bytes, length, bytes.length - length, null)
			if (read.bytesRead === 0) break
			length += read.bytesRead
		}
		requireValue(length <= limit, "JSON input", "exceeds eight MiB")
		return JSON.parse(bytes.subarray(0, length).toString("utf8"))
	} finally {
		await handle.close()
	}
}

async function hash(path, algorithm = "sha256", encoding = "hex") {
	await regular(path)
	const result = createHash(algorithm)
	for await (const bytes of createReadStream(path)) result.update(bytes)
	return result.digest(encoding)
}

function identity(value) {
	fields(
		value,
		[
			"repository",
			"repositoryId",
			"source",
			"workflowCommit",
			"workflow",
			"ref",
			"run",
			"attempt",
			"inputSha256"
		],
		"identity"
	)
	equal(value.repository, repository, "repository")
	equal(value.repositoryId, "1420539345", "repository ID")
	requireValue(
		/^[a-f0-9]{40}$/.test(value.source),
		"source",
		"expected a full commit"
	)
	equal(value.workflowCommit, value.source, "workflow commit")
	equal(value.workflow, workflow, "workflow path")
	requireValue(
		typeof value.ref === "string" &&
			value.ref.length <= 256 &&
			/^refs\/(heads|tags)\/[A-Za-z0-9/_-]+$/.test(value.ref),
		"workflow ref",
		"expected a bounded exact GitHub ref"
	)
	decimal(value.run, "run")
	decimal(value.attempt, "attempt")
	digest(value.inputSha256, "input manifest")
	return value
}

function toolchain(value, node = "24.22.0", cold = false) {
	fields(
		value,
		[
			"node",
			"npm",
			"bun",
			"nodePath",
			"npmPath",
			"bunPath",
			"platform",
			"arch",
			"runner",
			"image"
		],
		"toolchain"
	)
	equal(value.node, node, "Node version")
	equal(
		value.npm,
		node === "24.22.0" ? "11.19.1" : "10.8.2",
		"bundled npm version"
	)
	equal(value.bun, cold ? null : "1.4.3", "Bun version")
	if (cold) equal(value.bunPath, null, "cold Bun path")
	else text(value.bunPath, "Bun path")
	for (const key of ["nodePath", "npmPath", "image"]) text(value[key], key)
	requireValue(
		cells.some(
			(cell) =>
				cell.platform === value.platform &&
				cell.arch === value.arch &&
				cell.runner === value.runner &&
				cell.node === node
		),
		"runner",
		"unsupported platform or architecture"
	)
	return value
}

function inventory(value) {
	const paths = new Set()
	for (const entry of array(value, "inventory")) {
		fields(entry, ["path", "sha256", "mode"], "inventory entry")
		member(entry.path)
		digest(entry.sha256, "inventory digest")
		requireValue(
			entry.mode === 0o644 || entry.mode === 0o755,
			"inventory mode",
			"expected 0644 or 0755"
		)
		const normalized = entry.path.normalize("NFC").toLowerCase()
		requireValue(
			!paths.has(normalized),
			"inventory path",
			"duplicate or case-colliding member"
		)
		paths.add(normalized)
	}
	return value
}

async function tree(
	root,
	entries,
	links = [],
	installed = false,
	checkout = false,
	deferred = []
) {
	inventory(entries)
	array(links, "bin links")
	requireValue(
		installed || links.length === 0,
		"bin links",
		"links only qualify in installed prefixes"
	)
	const rootInfo = await lstat(root)
	requireValue(
		rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
		"tree root",
		"expected a regular directory"
	)
	const canonical = await realpath(root)
	equal(resolve(root), canonical, "tree root")
	const files = new Map(entries.map((entry) => [entry.path, entry]))
	const bins = new Map()
	const shims = new Set(array(deferred, "native shim paths").map(member))
	requireValue(
		installed || shims.size === 0,
		"native shims",
		"only installed prefixes permit shims"
	)
	equal(shims.size, deferred.length, "native shim uniqueness")
	for (const path of shims)
		requireValue(
			!files.has(path),
			"native shim",
			"path overlaps package content"
		)
	for (const link of links) {
		fields(
			link,
			["path", "text", "package", "boundary", "target", "sha256", "mode"],
			"bin link"
		)
		member(link.path)
		member(link.target)
		member(link.boundary)
		text(link.package, "bin package")
		text(link.text, "bin link text")
		requireValue(
			!isAbsolute(link.text) && !link.text.includes("\\"),
			"bin link text",
			"expected a relative POSIX target"
		)
		requireValue(
			process.platform !== "win32",
			"bin link",
			"Windows permits only regular shims"
		)
		requireValue(
			!bins.has(link.path) && !files.has(link.path),
			"bin link",
			"duplicate inventory entry"
		)
		const target = files.get(link.target)
		requireValue(
			target !== undefined,
			"bin target",
			"target absent from accepted inventory"
		)
		equal(
			{ sha256: link.sha256, mode: link.mode },
			{ sha256: target.sha256, mode: target.mode },
			"bin target identity"
		)
		inside(join(canonical, link.boundary), join(canonical, link.target))
		bins.set(link.path, link)
	}
	for (const path of shims)
		requireValue(!bins.has(path), "native shim", "path overlaps bin link")
	const normalizedPaths = [...files.keys(), ...bins.keys(), ...shims].map(
		(path) => path.normalize("NFC").toLowerCase()
	)
	equal(
		new Set(normalizedPaths).size,
		normalizedPaths.length,
		"combined inventory uniqueness"
	)
	const directories = new Set()
	for (const path of [...files.keys(), ...bins.keys(), ...shims]) {
		let parent = dirname(path)
		while (parent !== ".") {
			directories.add(parent.split(sep).join("/"))
			parent = dirname(parent)
		}
	}
	const seen = new Set()
	let count = 0
	async function targetFile(path) {
		const parts = path.split("/")
		let target = canonical
		for (let index = 0; index < parts.length - 1; index += 1) {
			target = join(target, parts[index])
			const info = await lstat(target)
			requireValue(
				info.isDirectory() && !info.isSymbolicLink(),
				"bin ancestor",
				"target traverses a link or non-directory"
			)
		}
		return regular(join(canonical, path))
	}
	async function visit(directory, prefix) {
		for await (const entry of await opendir(directory)) {
			if (checkout && prefix === "" && entry.name === ".git") {
				const info = await lstat(join(directory, entry.name))
				requireValue(
					info.isDirectory() && !info.isSymbolicLink(),
					"checkout metadata",
					"expected a regular Git directory"
				)
				continue
			}
			count += 1
			requireValue(
				count <= files.size + bins.size + shims.size + directories.size,
				"tree inventory",
				"unexpected members exceed accepted inventory"
			)
			const path = prefix ? `${prefix}/${entry.name}` : entry.name
			member(path)
			const absolute = join(canonical, path)
			const info = await lstat(absolute)
			if (info.isSymbolicLink()) {
				const expected = bins.get(path)
				requireValue(expected !== undefined, "tree link", "unexpected link")
				equal(await readlink(absolute), expected.text, "bin link text")
				const normalized = resolve(dirname(absolute), expected.text)
				inside(canonical, normalized)
				inside(join(canonical, expected.boundary), normalized)
				equal(
					normalized,
					join(canonical, expected.target),
					"bin normalized target"
				)
				const target = await targetFile(expected.target)
				const actual = await realpath(normalized)
				inside(canonical, actual)
				inside(join(canonical, expected.boundary), actual)
				equal(actual, normalized, "bin real target")
				equal(target.mode & 0o777, expected.mode, "bin target mode")
				equal(await hash(normalized), expected.sha256, "bin target digest")
				seen.add(path)
			} else if (info.isDirectory()) {
				requireValue(
					directories.has(path),
					"tree directory",
					"unexpected directory"
				)
				await visit(absolute, path)
			} else {
				if (shims.has(path)) {
					requireValue(info.isFile(), "native shim", "expected a regular file")
					seen.add(path)
					continue
				}
				const expected = files.get(path)
				requireValue(
					info.isFile() && expected !== undefined,
					"tree member",
					"unexpected or nonregular member"
				)
				if (process.platform !== "win32")
					equal(info.mode & 0o777, expected.mode, "member mode")
				equal(await hash(absolute), expected.sha256, "member digest")
				seen.add(path)
			}
		}
	}
	await visit(canonical, "")
	equal(seen.size, files.size + bins.size + shims.size, "tree inventory count")
}

async function identityMode(input) {
	fields(
		input,
		["expected", "observed", "package", "sourceRoot", "sourceManifest"],
		"identity input"
	)
	fields(input.expected, ["identity", "actions"], "identity approval")
	fields(
		input.observed,
		["identity", "toolchain", "head"],
		"identity observations"
	)
	identity(input.expected.identity)
	toolchain(input.observed.toolchain)
	equal(input.expected.actions, actions, "Action pins")
	equal(input.observed.identity, input.expected.identity, "observed identity")
	equal(input.observed.head, input.expected.identity.source, "checked-out HEAD")
	const expected = input.expected.identity
	for (const [key, value] of Object.entries({
		GITHUB_REPOSITORY: repository,
		GITHUB_REPOSITORY_ID: expected.repositoryId,
		GITHUB_SHA: expected.source,
		GITHUB_WORKFLOW_SHA: expected.workflowCommit,
		GITHUB_REF: expected.ref,
		GITHUB_RUN_ID: expected.run,
		GITHUB_RUN_ATTEMPT: expected.attempt,
		GITHUB_WORKFLOW_REF: `${repository}/${workflow}@${expected.ref}`,
		GITHUB_EVENT_NAME: "workflow_dispatch"
	}))
		equal(process.env[key], value, key)
	equal(process.versions.node, input.observed.toolchain.node, "active Node")
	equal(process.platform, input.observed.toolchain.platform, "active platform")
	equal(process.arch, input.observed.toolchain.arch, "active architecture")
	equal(
		await realpath(process.execPath),
		await realpath(input.observed.toolchain.nodePath),
		"active interpreter"
	)
	equal(
		await hash(input.sourceManifest),
		expected.inputSha256,
		"accepted source manifest digest"
	)
	const source = inventory(await json(input.sourceManifest))
	await tree(input.sourceRoot, source, [], false, true)
	const manifest = object(await json(input.package), "package manifest")
	equal(manifest.name, packageName, "package name")
	equal(manifest.version, version, "package version")
	equal(manifest.license, "Apache-2.0", "package license")
	equal(
		manifest.repository,
		{ type: "git", url: `https://github.com/${repository}.git` },
		"package repository"
	)
	return { ...input.expected, source, toolchain: input.observed.toolchain }
}

async function closure(bunPath, shrinkwrapPath, manifest) {
	const info = await regular(bunPath)
	requireValue(info.size <= limit, "Bun lock", "exceeds eight MiB")
	const { default: ts } = await import("typescript")
	equal(ts.version, "5.9.3", "lock parser")
	const parsed = ts.parseConfigFileTextToJson(
		bunPath,
		await readFile(bunPath, "utf8")
	)
	requireValue(parsed.error === undefined, "Bun lock", "invalid JSONC")
	const lock = object(parsed.config, "Bun lock")
	const root = object(object(lock.workspaces, "Bun workspaces")[""], "Bun root")
	equal(root.name, packageName, "Bun root name")
	equal(root.dependencies, manifest.dependencies, "Bun runtime dependencies")
	const npm = object(await json(shrinkwrapPath), "npm shrinkwrap")
	equal(npm.name, packageName, "shrinkwrap name")
	equal(npm.version, version, "shrinkwrap version")
	equal(npm.lockfileVersion, 3, "shrinkwrap format")
	const packages = object(npm.packages, "shrinkwrap packages")
	equal(
		object(packages[""], "shrinkwrap root").dependencies,
		manifest.dependencies,
		"shrinkwrap runtime dependencies"
	)
	const resolutions = object(lock.packages, "Bun resolutions")
	const records = []
	const redundantPeers = []
	for (const [path, value] of Object.entries(packages)) {
		if (path === "") continue
		member(path)
		requireValue(
			path.startsWith("node_modules/"),
			"closure path",
			"expected a package installation path"
		)
		const entry = object(value, "closure package")
		requireValue(
			entry.link !== true && entry.dev !== true && entry.inBundle !== true,
			"closure package",
			"links, development packages, and bundles are forbidden"
		)
		const key = path.replaceAll("node_modules/", "")
		const resolved = array(resolutions[key], "Bun resolution", 4)
		equal(resolved.length, 4, "Bun resolution fields")
		const name = path.slice(path.lastIndexOf("node_modules/") + 13)
		equal(resolved[0], `${name}@${entry.version}`, "closure version")
		equal(resolved[1], "", "Bun registry origin")
		equal(
			entry.resolved,
			`https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${entry.version}.tgz`,
			"npm registry origin"
		)
		equal(entry.integrity, resolved[3], "closure integrity")
		requireValue(
			/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity),
			"closure integrity",
			"expected SHA-512 integrity"
		)
		const metadata = object(resolved[2], "Bun package metadata")
		for (const field of ["dependencies", "optionalDependencies", "bin"])
			equal(entry[field] ?? {}, metadata[field] ?? {}, `closure ${field}`)
		const peers = { ...object(entry.peerDependencies ?? {}, "npm peers") }
		const acceptedPeers = object(metadata.peerDependencies ?? {}, "Bun peers")
		for (const [peer, peerVersion] of Object.entries(peers)) {
			if (Object.hasOwn(acceptedPeers, peer)) continue
			requireValue(
				typeof peerVersion === "string" &&
					/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
						peerVersion
					),
				"redundant optional peer",
				"expected an exact literal version"
			)
			requireValue(
				entry.peerDependenciesMeta?.[peer]?.optional === true &&
					entry.dependencies?.[peer] === peerVersion &&
					metadata.dependencies?.[peer] === peerVersion,
				"redundant optional peer",
				"peer is not an accepted duplicate ordinary dependency"
			)
			redundantPeers.push({ path, name: peer, version: peerVersion })
			delete peers[peer]
		}
		equal(peers, acceptedPeers, "closure peerDependencies")
		for (const field of ["os", "cpu"])
			equal(
				entry[field] ?? [],
				metadata[field] === undefined ? [] : [metadata[field]].flat(),
				`closure ${field}`
			)
		records.push({
			path,
			name,
			version: entry.version,
			resolved: entry.resolved,
			integrity: entry.integrity,
			bin: entry.bin ?? {},
			os: entry.os ?? [],
			cpu: entry.cpu ?? []
		})
		requireValue(
			records.length <= maximumMembers,
			"closure",
			"too many packages"
		)
	}
	function resolveDependency(path, name) {
		let current = path
		while (true) {
			const candidate = `${current ? `${current}/` : ""}node_modules/${name}`
			if (packages[candidate]) return candidate
			if (!current) return undefined
			const index = current.lastIndexOf("node_modules/")
			current = index > 0 ? current.slice(0, index - 1) : ""
		}
	}
	const byPath = new Map(records.map((entry) => [entry.path, entry]))
	for (const peer of redundantPeers) {
		const target = byPath.get(resolveDependency(peer.path, peer.name))
		requireValue(
			target !== undefined &&
				target.name === peer.name &&
				target.version === peer.version,
			"redundant optional peer resolution",
			"peer does not resolve to the exact accepted ordinary package"
		)
	}
	const reached = new Set([""])
	const pending = [""]
	for (let index = 0; index < pending.length; index += 1) {
		const path = pending[index]
		const entry = packages[path]
		for (const name of Object.keys({
			...entry.dependencies,
			...entry.optionalDependencies,
			...entry.peerDependencies
		})) {
			const target = resolveDependency(path, name)
			requireValue(
				target !== undefined,
				"closure dependency",
				"missing runtime or optional platform package"
			)
			if (!reached.has(target)) {
				reached.add(target)
				pending.push(target)
			}
		}
	}
	equal(reached.size, Object.keys(packages).length, "closure reachability")
	for (const platform of ["darwin-arm64", "linux-x64", "win32-x64"])
		requireValue(
			records.some(
				(entry) =>
					entry.name === `@bufbuild/buf-${platform}` &&
					entry.version === "1.60.0"
			),
			"Buf platform closure",
			"missing selected native executable package"
		)
	return records.sort((left, right) => left.path.localeCompare(right.path))
}

async function candidateMode(input) {
	fields(
		input,
		[
			"approval",
			"source",
			"build",
			"staging",
			"manifest",
			"bunLock",
			"shrinkwrap",
			"pack",
			"tarball"
		],
		"candidate input"
	)
	const approval = fields(
		input.approval,
		[
			"identity",
			"toolchain",
			"actions",
			"source",
			"build",
			"members",
			"lockSha256",
			"inputManifest",
			"inputManifestSha256"
		],
		"candidate approval"
	)
	identity(approval.identity)
	toolchain(approval.toolchain)
	equal(approval.actions, actions, "Action pins")
	equal(
		await hash(approval.inputManifest),
		digest(approval.inputManifestSha256, "input manifest"),
		"input manifest digest"
	)
	equal(
		approval.identity.inputSha256,
		approval.inputManifestSha256,
		"input identity"
	)
	equal(
		await json(approval.inputManifest),
		approval.source,
		"accepted source inventory"
	)
	equal(
		await hash(input.bunLock),
		digest(approval.lockSha256, "Bun lock"),
		"Bun lock digest"
	)
	await tree(input.source, approval.source)
	await tree(input.build, approval.build)
	await tree(input.staging, approval.members)
	equal(
		await realpath(input.manifest),
		join(await realpath(input.staging), "package.json"),
		"staged manifest location"
	)
	equal(
		await realpath(input.shrinkwrap),
		join(await realpath(input.staging), "npm-shrinkwrap.json"),
		"staged closure location"
	)
	equal(
		await realpath(input.bunLock),
		join(await realpath(input.source), "bun.lock"),
		"accepted lock location"
	)
	const buildMembers = approval.members.filter((entry) =>
		entry.path.startsWith("dist/")
	)
	equal(
		buildMembers,
		approval.build.map((entry) => ({ ...entry, path: `dist/${entry.path}` })),
		"same tested build"
	)
	for (const entry of approval.members) {
		if (entry.path.startsWith("dist/") || entry.path === "npm-shrinkwrap.json")
			continue
		equal(
			entry,
			approval.source.find((source) => source.path === entry.path),
			"unchanged source package member"
		)
	}
	for (const path of [
		"package.json",
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
		requireValue(
			approval.members.some((entry) => entry.path === path),
			"required package asset",
			"missing mandatory member"
		)
	const cli = await readFile(join(input.staging, "dist/cli.js"), "utf8")
	requireValue(
		cli.startsWith("#!/usr/bin/env node\n"),
		"CLI shebang",
		"expected Node interpreter"
	)
	const manifest = object(await json(input.manifest), "staged package")
	equal(
		manifest,
		await json(join(input.source, "package.json")),
		"unchanged accepted package metadata"
	)
	equal(manifest.name, packageName, "staged name")
	equal(manifest.version, version, "staged version")
	equal(manifest.license, "Apache-2.0", "staged license")
	equal(manifest.bin, { pioneer: "./dist/cli.js" }, "staged bin")
	const runtime = await closure(input.bunLock, input.shrinkwrap, manifest)
	const packed = array(await json(input.pack), "npm pack result", 1)
	equal(packed.length, 1, "npm pack count")
	const pack = object(packed[0], "npm pack record")
	equal(pack.name, packageName, "packed name")
	equal(pack.version, version, "packed version")
	const members = array(pack.files, "packed members")
		.map((entry) => {
			member(entry.path)
			return { path: entry.path, mode: entry.mode }
		})
		.sort((left, right) => left.path.localeCompare(right.path))
	equal(
		members,
		approval.members
			.map(({ path, mode }) => ({ path, mode }))
			.sort((left, right) => left.path.localeCompare(right.path)),
		"packed inventory"
	)
	for (const path of ["src/release.mjs", "tests/fixtures/installed-cli.mjs"])
		requireValue(
			!members.some((entry) => entry.path === path),
			"packed helpers",
			"verification helper entered product tarball"
		)
	const sha256 = await hash(input.tarball)
	const integrity = `sha512-${await hash(input.tarball, "sha512", "base64")}`
	equal(pack.integrity, integrity, "packed integrity")
	return {
		identity: approval.identity,
		toolchain: approval.toolchain,
		actions,
		lockSha256: approval.lockSha256,
		source: approval.source,
		build: approval.build,
		members: approval.members,
		closure: runtime,
		tarball: { sha256, integrity }
	}
}

function artifact(value) {
	object(value, "artifact approval")
	fields(
		value,
		[
			"id",
			"archiveSha256",
			"files",
			...(Object.hasOwn(value, "maxBytes") ? ["maxBytes"] : [])
		],
		"artifact approval"
	)
	decimal(value.id, "artifact ID")
	requireValue(
		Number.isSafeInteger(Number(value.id)),
		"artifact ID",
		"unsafe integer"
	)
	if (Object.hasOwn(value, "maxBytes"))
		requireValue(
			Number.isSafeInteger(value.maxBytes) &&
				value.maxBytes > 0 &&
				value.maxBytes <= 512 * 1024 * 1024,
			"artifact limit",
			"invalid byte ceiling"
		)
	digest(value.archiveSha256, "artifact archive")
	inventory(value.files)
	return value
}

async function transferMode(input) {
	fields(
		input,
		["expected", "observed", "artifacts", "installedRoot"],
		"transfer input"
	)
	fields(
		input.expected,
		["identity", "candidateSha256", "helperSha256", "artifacts", "installed"],
		"transfer approval"
	)
	identity(input.expected.identity)
	digest(input.expected.candidateSha256, "candidate")
	digest(input.expected.helperSha256, "helper")
	equal(input.observed, input.expected.identity, "artifact run identity")
	const approved = array(
		input.expected.artifacts,
		"approved artifacts",
		16
	).map(artifact)
	const actual = array(input.artifacts, "artifact observations", 16)
	equal(actual.length, approved.length, "artifact count")
	const ids = new Set()
	const extracted = new Map()
	for (const expected of approved) {
		requireValue(!ids.has(expected.id), "artifact ID", "duplicate artifact")
		ids.add(expected.id)
		const found = actual.filter((entry) => entry.id === expected.id)
		equal(found.length, 1, "artifact observation")
		const observed = fields(
			found[0],
			["id", "archive", "root"],
			"artifact observation"
		)
		equal(
			await hash(observed.archive),
			expected.archiveSha256,
			"artifact archive digest"
		)
		const entries = extracted.get(observed.root) ?? []
		entries.push(...expected.files)
		extracted.set(observed.root, entries)
	}
	for (const [root, entries] of extracted) await tree(root, entries)
	const candidates = approved
		.flatMap((entry) => entry.files)
		.filter((entry) => entry.path === "candidate.json")
	equal(candidates.length, 1, "candidate inventory")
	equal(
		candidates[0].sha256,
		input.expected.candidateSha256,
		"candidate approval"
	)
	const helpers = approved
		.flatMap((entry) => entry.files)
		.filter((entry) => entry.path === "release.mjs")
	equal(helpers.length, 1, "helper inventory")
	equal(helpers[0].sha256, input.expected.helperSha256, "helper approval")
	let reference = null
	if (input.expected.installed !== null) {
		const installation = fields(
			input.expected.installed,
			["phase", "contents", "toolchain", "reference"],
			"native installation"
		)
		text(input.installedRoot, "installed root")
		requireValue(
			installation.phase === "reference" || installation.phase === "cold",
			"native phase",
			"expected reference or cold"
		)
		const tools = toolchain(
			installation.toolchain,
			installation.toolchain.node,
			true
		)
		equal(tools.platform, process.platform, "native platform")
		equal(tools.arch, process.arch, "native architecture")
		equal(tools.node, process.versions.node, "native Node")
		const contentArtifacts = approved.filter((entry) =>
			entry.files.some((file) => file.path === "contents.json")
		)
		equal(contentArtifacts.length, 1, "content artifact")
		const contentObservation = actual.find(
			(entry) => entry.id === contentArtifacts[0].id
		)
		equal(
			resolve(installation.contents),
			join(await realpath(contentObservation.root), "contents.json"),
			"content manifest location"
		)
		const content = fields(
			await json(installation.contents),
			["identity", "candidateSha256", "platforms"],
			"content manifest"
		)
		equal(content.identity, input.expected.identity, "content identity")
		equal(
			content.candidateSha256,
			input.expected.candidateSha256,
			"content candidate"
		)
		const accepted = fields(
			object(content.platforms, "content platforms")[
				`${tools.platform}/${tools.arch}`
			],
			["files", "links", "shims", "consumer"],
			"platform inventory"
		)
		inventory(accepted.files)
		const shims = array(accepted.shims, "accepted native shims")
		requireValue(
			tools.platform === "win32" || shims.length === 0,
			"native shims",
			"POSIX requires links"
		)
		for (const shim of shims) {
			fields(
				shim,
				["path", "package", "boundary", "target", "sha256", "mode"],
				"accepted shim"
			)
			member(shim.path)
			member(shim.boundary)
			member(shim.target)
			text(shim.package, "shim package")
			inside(
				join(input.installedRoot, shim.boundary),
				join(input.installedRoot, shim.target)
			)
			const target = accepted.files.find((entry) => entry.path === shim.target)
			requireValue(
				target !== undefined,
				"shim target",
				"absent from authenticated package content"
			)
			equal(
				{ sha256: shim.sha256, mode: shim.mode },
				{ sha256: target.sha256, mode: target.mode },
				"shim target binding"
			)
		}
		await tree(
			input.installedRoot,
			accepted.files,
			accepted.links,
			true,
			false,
			shims.map((entry) => entry.path)
		)
		const observedShims = []
		for (const shim of shims) {
			const path = join(input.installedRoot, shim.path)
			const info = await regular(path)
			observedShims.push({
				path: shim.path,
				sha256: await hash(path),
				mode: info.mode & 0o777
			})
		}
		reference = {
			identity: input.expected.identity,
			candidateSha256: input.expected.candidateSha256,
			toolchain: tools,
			prefix: await realpath(input.installedRoot),
			shims: observedShims
		}
		if (installation.phase === "reference")
			equal(installation.reference, null, "reference input absence")
		else {
			const binding = fields(
				installation.reference,
				["path", "sha256"],
				"reference approval"
			)
			equal(
				await hash(binding.path),
				digest(binding.sha256, "native reference"),
				"native reference digest"
			)
			const record = fields(
				await json(binding.path),
				["identity", "candidateSha256", "artifacts", "reference"],
				"native reference result"
			)
			equal(
				record.identity,
				input.expected.identity,
				"reference result identity"
			)
			equal(
				record.candidateSha256,
				input.expected.candidateSha256,
				"reference result candidate"
			)
			equal(record.artifacts, approved, "reference artifact binding")
			const prior = fields(
				record.reference,
				["identity", "candidateSha256", "toolchain", "prefix", "shims"],
				"native reference record"
			)
			text(prior.prefix, "reference prefix")
			const distance = relative(prior.prefix, reference.prefix)
			requireValue(
				distance === ".." ||
					distance.startsWith(`..${sep}`) ||
					isAbsolute(distance),
				"cold prefix",
				"cold prefix overlaps reference prefix"
			)
			const inverse = relative(reference.prefix, prior.prefix)
			requireValue(
				inverse === ".." ||
					inverse.startsWith(`..${sep}`) ||
					isAbsolute(inverse),
				"reference prefix",
				"reference prefix overlaps cold prefix"
			)
			equal(
				{ ...reference, prefix: prior.prefix },
				prior,
				"native reference observations"
			)
			reference = { sha256: binding.sha256 }
		}
	} else equal(input.installedRoot, null, "absent installed root")
	return {
		identity: input.expected.identity,
		candidateSha256: input.expected.candidateSha256,
		artifacts: approved,
		...(reference === null ? {} : { reference })
	}
}

async function matrixMode(input) {
	fields(input, ["identity", "candidateSha256", "receipts"], "matrix input")
	identity(input.identity)
	digest(input.candidateSha256, "matrix candidate")
	const receipts = array(input.receipts, "matrix receipts", 6)
	equal(receipts.length, 6, "matrix count")
	const seen = new Set()
	for (const item of receipts) {
		fields(item, ["path", "sha256", "referencePath"], "matrix receipt approval")
		equal(
			await hash(item.path),
			digest(item.sha256, "receipt"),
			"receipt digest"
		)
		const receipt = fields(
			await json(item.path),
			[
				"identity",
				"candidateSha256",
				"referenceSha256",
				"toolchain",
				"bin",
				"checks"
			],
			"matrix receipt"
		)
		digest(receipt.referenceSha256, "receipt native reference")
		equal(receipt.identity, input.identity, "receipt identity")
		equal(receipt.candidateSha256, input.candidateSha256, "receipt candidate")
		const observedTools = object(receipt.toolchain, "receipt toolchain")
		const tools = toolchain(observedTools, observedTools.node, true)
		equal(
			await hash(item.referencePath),
			receipt.referenceSha256,
			"matrix native reference digest"
		)
		const reference = fields(
			await json(item.referencePath),
			["identity", "candidateSha256", "artifacts", "reference"],
			"matrix reference result"
		)
		equal(reference.identity, input.identity, "matrix reference identity")
		equal(
			reference.candidateSha256,
			input.candidateSha256,
			"matrix reference candidate"
		)
		const native = fields(
			reference.reference,
			["identity", "candidateSha256", "toolchain", "prefix", "shims"],
			"matrix native reference"
		)
		equal(native.identity, input.identity, "native reference identity")
		equal(
			native.candidateSha256,
			input.candidateSha256,
			"native reference candidate"
		)
		equal(native.toolchain, tools, "native reference tools")
		text(native.prefix, "native reference prefix")
		for (const shim of array(native.shims, "native reference shims")) {
			fields(shim, ["path", "sha256", "mode"], "native reference shim")
			member(shim.path)
			digest(shim.sha256, "native reference shim digest")
			requireValue(
				Number.isInteger(shim.mode) && shim.mode >= 0 && shim.mode <= 0o777,
				"native reference shim mode",
				"invalid permissions"
			)
		}
		const key = `${tools.platform}/${tools.arch}/${tools.node}`
		requireValue(!seen.has(key), "matrix cell", "duplicate cell")
		seen.add(key)
		text(receipt.bin, "installed PATH bin")
		equal(
			receipt.checks,
			[
				"assets",
				"provenance",
				"runtime",
				"receipt",
				"cancellation",
				"abci",
				"fees",
				"corruption",
				"missing-member"
			],
			"cold checks"
		)
	}
	return {
		identity: input.identity,
		candidateSha256: input.candidateSha256,
		receipts: receipts.map(({ sha256 }) => ({ sha256 }))
	}
}

async function provenanceMode(input) {
	fields(
		input,
		["expected", "audit", "registryTarball", "candidate", "matrix"],
		"provenance input"
	)
	const expected = fields(
		input.expected,
		[
			"identity",
			"candidateSha256",
			"matrixSha256",
			"tarballSha256",
			"integrity",
			"signer",
			"artifacts"
		],
		"registry approval"
	)
	const id = identity(expected.identity)
	digest(expected.candidateSha256, "registry candidate")
	digest(expected.matrixSha256, "registry matrix")
	digest(expected.tarballSha256, "registry tarball")
	requireValue(
		typeof expected.integrity === "string" &&
			/^sha512-[A-Za-z0-9+/]{86}==$/.test(expected.integrity),
		"registry integrity",
		"expected SHA-512"
	)
	array(expected.artifacts, "registry artifact binding", 16).map(artifact)
	requireValue(
		expected.artifacts.length >= 2,
		"registry artifacts",
		"missing external artifact binding"
	)
	equal(
		new Set(expected.artifacts.map((entry) => entry.id)).size,
		expected.artifacts.length,
		"registry artifact uniqueness"
	)
	const binding = expected.artifacts.flatMap((entry) => entry.files)
	for (const [path, sha256] of [
		["candidate.json", expected.candidateSha256],
		["pioneer.tgz", expected.tarballSha256],
		["matrix.json", expected.matrixSha256]
	]) {
		const matches = binding.filter((entry) => entry.path === path)
		equal(matches.length, 1, "external artifact member")
		equal(matches[0].sha256, sha256, "external artifact digest")
	}
	equal(
		await hash(input.candidate),
		expected.candidateSha256,
		"registry candidate digest"
	)
	equal(
		await hash(input.matrix),
		expected.matrixSha256,
		"registry matrix digest"
	)
	equal(
		await hash(input.registryTarball),
		expected.tarballSha256,
		"registry bytes"
	)
	equal(
		`sha512-${await hash(input.registryTarball, "sha512", "base64")}`,
		expected.integrity,
		"registry integrity"
	)
	const candidate = object(await json(input.candidate), "registry candidate")
	equal(candidate.identity, id, "candidate provenance identity")
	equal(
		candidate.tarball,
		{ sha256: expected.tarballSha256, integrity: expected.integrity },
		"candidate package binding"
	)
	const matrix = object(await json(input.matrix), "registry matrix")
	equal(matrix.identity, id, "matrix provenance identity")
	equal(
		matrix.candidateSha256,
		expected.candidateSha256,
		"matrix candidate binding"
	)
	const audit = object(await json(input.audit), "verified npm audit")
	equal(audit.invalid, [], "invalid signatures")
	equal(audit.missing, [], "missing signatures")
	const matches = array(audit.verified, "verified packages").filter(
		(entry) => entry.name === packageName && entry.version === version
	)
	equal(matches.length, 1, "verified candidate")
	equal(matches[0].registry, "https://registry.npmjs.org/", "verified registry")
	const attestations = array(
		matches[0].attestationBundles,
		"verified attestations",
		16
	).filter((entry) => entry.predicateType === "https://slsa.dev/provenance/v1")
	equal(attestations.length, 1, "candidate provenance bundle")
	const bundle = object(attestations[0].bundle, "Sigstore bundle")
	requireValue(
		[
			"application/vnd.dev.sigstore.bundle+json;version=0.1",
			"application/vnd.dev.sigstore.bundle+json;version=0.2",
			"application/vnd.dev.sigstore.bundle+json;version=0.3",
			"application/vnd.dev.sigstore.bundle.v0.3+json"
		].includes(bundle.mediaType),
		"Sigstore bundle",
		"unsupported media type"
	)
	const envelope = object(bundle.dsseEnvelope, "verified DSSE envelope")
	equal(
		envelope.payloadType,
		"application/vnd.in-toto+json",
		"DSSE payload type"
	)
	requireValue(
		typeof envelope.payload === "string" && envelope.payload.length <= limit,
		"DSSE payload",
		"missing or oversized payload"
	)
	const payload = Buffer.from(envelope.payload, "base64")
	equal(payload.toString("base64"), envelope.payload, "DSSE base64")
	const statement = object(
		JSON.parse(payload.toString("utf8")),
		"verified statement"
	)
	equal(statement._type, "https://in-toto.io/Statement/v1", "statement type")
	equal(
		statement.predicateType,
		"https://slsa.dev/provenance/v1",
		"predicate type"
	)
	equal(
		statement.subject,
		[
			{
				name: "pkg:npm/%40vastward/pioneer@0.0.1",
				digest: {
					sha512: Buffer.from(expected.integrity.slice(7), "base64").toString(
						"hex"
					)
				}
			}
		],
		"attested package subject"
	)
	const predicate = object(statement.predicate, "predicate")
	const definition = object(predicate.buildDefinition, "build definition")
	equal(
		definition.buildType,
		"https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
		"build type"
	)
	equal(
		object(definition.externalParameters, "external parameters").workflow,
		{
			ref: id.ref,
			repository: `https://github.com/${repository}`,
			path: workflow
		},
		"attested workflow"
	)
	const github = object(
		object(definition.internalParameters, "internal parameters").github,
		"attested GitHub identity"
	)
	equal(github.repository_id, id.repositoryId, "attested repository ID")
	equal(github.event_name, "workflow_dispatch", "attested event")
	equal(
		definition.resolvedDependencies,
		[
			{
				uri: `git+https://github.com/${repository}@${id.ref}`,
				digest: { gitCommit: id.source }
			}
		],
		"attested source"
	)
	const run = object(predicate.runDetails, "run details")
	equal(
		object(run.builder, "builder").id,
		"https://github.com/actions/runner/github-hosted",
		"attested builder"
	)
	equal(
		object(run.metadata, "run metadata").invocationId,
		`https://github.com/${repository}/actions/runs/${id.run}/attempts/${id.attempt}`,
		"attested invocation"
	)
	const material = object(bundle.verificationMaterial, "verification material")
	requireValue(
		(material.certificate !== undefined) !==
			(material.x509CertificateChain !== undefined),
		"verified certificate",
		"expected exactly one certificate representation"
	)
	const certificate =
		material.certificate ??
		array(
			object(material.x509CertificateChain, "X.509 chain").certificates,
			"certificate chain",
			16
		)[0]
	const encoded = text(
		object(certificate, "certificate").rawBytes,
		"certificate DER"
	)
	const bytes = Buffer.from(encoded, "base64")
	equal(bytes.toString("base64"), encoded, "certificate base64")
	equal(
		expected.signer,
		`https://github.com/${repository}/${workflow}@${id.ref}`,
		"approved signer"
	)
	equal(
		new X509Certificate(bytes).subjectAltName,
		`URI:${expected.signer}`,
		"verified signer SAN"
	)
	return {
		identity: id,
		candidateSha256: expected.candidateSha256,
		matrixSha256: expected.matrixSha256,
		tarballSha256: expected.tarballSha256,
		integrity: expected.integrity,
		artifacts: expected.artifacts,
		signer: expected.signer
	}
}

async function main() {
	const [mode, inputOption, inputPath, outputOption, outputPath, ...extra] =
		process.argv.slice(2)
	requireValue(
		extra.length === 0 &&
			inputOption === "--input" &&
			outputOption === "--output",
		"arguments",
		"expected MODE --input PATH --output PATH"
	)
	text(inputPath, "input path")
	text(outputPath, "output path")
	requireValue(
		resolve(inputPath) !== resolve(outputPath),
		"output path",
		"cannot replace input"
	)
	const modes = {
		identity: identityMode,
		candidate: candidateMode,
		transfer: transferMode,
		matrix: matrixMode,
		provenance: provenanceMode
	}
	requireValue(Object.hasOwn(modes, mode), "mode", "unsupported mode")
	const result = await modes[mode](await json(inputPath))
	const bytes = `${JSON.stringify(result)}\n`
	requireValue(Buffer.byteLength(bytes) <= limit, "output", "exceeds eight MiB")
	const output = await open(outputPath, "wx", 0o644)
	try {
		await output.writeFile(bytes)
	} finally {
		await output.close()
	}
}

await main()
