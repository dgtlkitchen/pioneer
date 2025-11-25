import { promises as fs } from "node:fs"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import {
	create,
	createFileRegistry,
	type DescExtension,
	getExtension
} from "@bufbuild/protobuf"
import {
	type FileDescriptorProto,
	FileDescriptorSetSchema,
	file_google_protobuf_descriptor
} from "@bufbuild/protobuf/wkt"
import { compareImportBlocks, sanitizeAlias } from "./common.ts"
import { getModuleInfo } from "./utils.ts"

type ImportKind = "type" | "value"
type ImportEntry = { name: string; alias: string; kind: ImportKind }

type RestModuleEntry = {
	moduleName: string
	imports: Map<string, ImportEntry[]>
	aliases: Set<string>
	clients: Array<{
		funcName: string
		serviceName: string
		methods: Array<{
			name: string
			httpMethod: string
			processedPath: string
			hasBody: boolean
			paramNames: string[]
			requestType: string
			responseType: string
		}>
	}>
}

type HttpRule = {
	method: "get" | "post" | "put" | "delete" | "patch"
	path: string
	hasBody: boolean
}

const lowerFirst = (value: string) =>
	value.charAt(0).toLowerCase() + value.slice(1)

const toCamelCase = (value: string) =>
	value.replace(/[_-](\w)/g, (_, c: string) => c.toUpperCase())

export const generateRest = async (
	outPath: string,
	descriptors: FileDescriptorProto[],
	moduleIgnoreList: string[]
): Promise<void> => {
	const modules: Map<string, RestModuleEntry> = new Map()

	await fs.rm(join(outPath, "rest"), { recursive: true, force: true })
	const httpExt = await loadHttpExtension(descriptors, outPath)
	const typeImportMap = buildTypeImportMap(descriptors)

	for (const file of descriptors) {
		if (!file.package || !file.service || file.service.length === 0) continue

		const packagePath = file.package.split(".").join("/")
		const moduleInfo = getModuleInfo(packagePath)
		if (!moduleInfo) continue
		if (!packagePath.startsWith("cosmos/")) continue
		if (moduleIgnoreList.includes(moduleInfo.moduleKey)) continue

		const protoBaseName = file.name
			? (file.name.split("/").pop()?.replace(".proto", "") ?? "index")
			: "index"
		const pathSuffix = sanitizeAlias(
			`${moduleInfo.versionName || "v"}_${protoBaseName}`
		)
		const descriptorImportPath = buildDescriptorImport(
			moduleInfo.versionSegments,
			protoBaseName
		)

		let moduleEntry = modules.get(moduleInfo.moduleKey)

		for (const service of file.service) {
			if (service.name === "Msg") continue

			const methods: RestModuleEntry["clients"][number]["methods"] = []
			for (const method of service.method) {
				for (const rule of extractHttpRules(method, httpExt)) {
					const pathParams = rule.path.match(/\{([^}]+)\}/g) || []
					let processedPath = rule.path
					const paramNames: string[] = []
					for (const param of pathParams) {
						const paramName = param.slice(1, -1)
						const [fieldName] = paramName.split("=")
						const camelFieldName = toCamelCase(fieldName)
						paramNames.push(camelFieldName)
						const escapedFieldName = fieldName.replace(/"/g, '\\"')
						const safeIdentifier = /^[A-Za-z_$][\w$]*$/.test(camelFieldName)
						const fieldAccessor = safeIdentifier
							? `request.${camelFieldName}`
							: `request["${escapedFieldName}"]`
						const encodedAccessor = `encodeURIComponent(String(${fieldAccessor}))`
						processedPath = processedPath.replace(
							param,
							`\${${encodedAccessor}}`
						)
					}

					if (!moduleEntry) {
						moduleEntry = {
							moduleName: moduleInfo.moduleName,
							imports: new Map<string, ImportEntry[]>(),
							aliases: new Set<string>(),
							clients: []
						}
					}

					const inputFull = method.inputType?.replace(/^\./, "") ?? ""
					const outputFull = method.outputType?.replace(/^\./, "") ?? ""
					const requestType =
						inputFull.split(".").pop() ?? `${method.name}Request`
					const responseType =
						outputFull.split(".").pop() ?? `${method.name}Response`

					const requestImportPath =
						typeImportMap.get(inputFull) ?? descriptorImportPath
					const responseImportPath =
						typeImportMap.get(outputFull) ?? descriptorImportPath

					const requestAlias = addImport(
						moduleEntry,
						requestImportPath,
						requestType,
						pathSuffix,
						"type"
					)
					const responseAlias = addImport(
						moduleEntry,
						responseImportPath,
						responseType,
						pathSuffix,
						"type"
					)

					methods.push({
						name: lowerFirst(method.name),
						httpMethod: rule.method,
						processedPath,
						hasBody: rule.hasBody,
						paramNames,
						requestType: requestAlias,
						responseType: responseAlias
					})
				}
			}

			if (methods.length > 0 && moduleEntry) {
				const funcName = `create${moduleInfo.moduleName}${moduleInfo.versionName}${service.name}RestClient`
				moduleEntry.clients.push({
					funcName,
					serviceName: service.name,
					methods
				})
			}
		}

		if (moduleEntry?.clients.length) {
			modules.set(moduleInfo.moduleKey, moduleEntry)
		}
	}

	const modulesToWrite = Array.from(modules.entries()).filter(
		([, moduleData]) => moduleData.clients.length > 0
	)
	if (modulesToWrite.length === 0) {
		return
	}

	const restUtilsPath = await ensureRestUtils(outPath)

	for (const [moduleKey, moduleData] of modulesToWrite.sort((a, b) =>
		a[0].localeCompare(b[0])
	)) {
		const moduleDir = join(outPath, moduleKey)
		await fs.mkdir(moduleDir, { recursive: true })
		const header = "// This file was generated by proto-gen. DO NOT EDIT.\n\n"
		const restUtilsImportPath = relative(moduleDir, restUtilsPath)
			.replace(/\\/g, "/")
			.replace(/^(?!--|\\.\\.).*/, "./$&")
		const usesQueryParams = moduleData.clients.some((client) =>
			client.methods.some((method) => method.httpMethod === "get")
		)
		const usesRequestBody = moduleData.clients.some((client) =>
			client.methods.some((method) => method.hasBody)
		)

		const restUtilsSymbols: ImportEntry[] = [
			{ name: "fetchRest", alias: "fetchRest", kind: "value" },
			{ name: "RestClientConfig", alias: "RestClientConfig", kind: "type" }
		]
		if (usesQueryParams) {
			restUtilsSymbols.push({
				name: "appendSearchParams",
				alias: "appendSearchParams",
				kind: "value"
			})
		}
		if (usesRequestBody) {
			restUtilsSymbols.push({
				name: "stringifyJson",
				alias: "stringifyJson",
				kind: "value"
			})
		}

		const importBlocks: Array<{ path: string; symbols: ImportEntry[] }> = [
			{
				path: restUtilsImportPath,
				symbols: restUtilsSymbols
			},
			...Array.from(moduleData.imports.entries()).map(
				([importPath, entries]) => ({
					path: importPath,
					symbols: entries
				})
			)
		]

		const sortedImports = importBlocks
			.sort(compareImportBlocks)
			.map(({ path, symbols }) => renderImport(path, symbols))
			.join("")

		let source = `${header}${sortedImports}\n`

		for (const client of moduleData.clients.sort((a, b) =>
			a.funcName.localeCompare(b.funcName)
		)) {
			const clientMethods: string[] = []
			for (const method of client.methods) {
				const pathTemplate = `\${config.baseUrl}${method.processedPath}`
				if (method.httpMethod === "get") {
					clientMethods.push(`
  async ${method.name}(request: ${method.requestType}): Promise<${method.responseType}> {
    const path = \`${pathTemplate}\`
    const url = new URL(path)
    const pathParams = new Set<string>(${JSON.stringify(method.paramNames)})

    appendSearchParams(url, request, pathParams)

    return fetchRest<${method.responseType}>(url.toString(), {
      method: "GET",
      headers: config.headers,
    })
  }`)
				} else {
					clientMethods.push(`
  async ${method.name}(request: ${method.requestType}): Promise<${method.responseType}> {
    const url = \`${pathTemplate}\`

    return fetchRest<${method.responseType}>(url, {
      method: "${method.httpMethod.toUpperCase()}",
      headers: config.headers${method.hasBody ? `,\n      body: stringifyJson(request)` : ""}
    })
  }`)
				}
			}

			source += `export const ${client.funcName} = (config: RestClientConfig) => {
  return {${clientMethods.join(",\n")}
  }
}\n\n`
		}

		await fs.writeFile(join(moduleDir, "rest.ts"), source.trimEnd(), "utf-8")
	}
}

const ensureRestUtils = async (outPath: string) => {
	const commonDir = join(outPath, "common")
	await fs.mkdir(commonDir, { recursive: true })
	const header = "// This file was generated by proto-gen. DO NOT EDIT.\n\n"
	const restUtilsPath = join(commonDir, "restUtils.ts")
	const templatePath = new URL("./templates/restUtils.ts", import.meta.url)
	const body = await fs.readFile(templatePath, "utf-8")
	await fs.writeFile(restUtilsPath, `${header}${body}`, "utf-8")
	return restUtilsPath
}

const buildDescriptorImport = (
	versionSegments: string[],
	protoBaseName: string
) =>
	`./descriptor/${versionSegments.length ? `${versionSegments.join("/")}/` : ""}${protoBaseName}_pb`

const addImport = (
	moduleEntry: RestModuleEntry,
	importPath: string,
	name: string,
	suffix: string,
	kind: ImportKind
) => {
	const imports = moduleEntry.imports.get(importPath) ?? []
	const existing = imports.find((i) => i.name === name)
	if (existing) {
		return existing.alias
	}
	let alias = name
	if (moduleEntry.aliases.has(alias)) {
		alias = `${name}_${suffix}`
	}
	moduleEntry.aliases.add(alias)
	imports.push({ name, alias, kind })
	moduleEntry.imports.set(importPath, imports)
	return alias
}

const renderImport = (path: string, entries: ImportEntry[]) => {
	const parts = entries
		.slice()
		.sort((a, b) => {
			if (a.kind !== b.kind) {
				return a.kind === "type" ? -1 : 1
			}
			return a.alias.localeCompare(b.alias)
		})
		.map((entry) => {
			const base =
				entry.name === entry.alias
					? entry.name
					: `${entry.name} as ${entry.alias}`
			return entry.kind === "type" ? `type ${base}` : base
		})
	return `import { ${parts.join(", ")} } from "${path}"\n`
}

const buildTypeImportMap = (descriptors: FileDescriptorProto[]) => {
	const map = new Map<string, string>()
	for (const file of descriptors) {
		if (!file.package || !file.name) continue
		const packagePath = file.package.split(".").join("/")
		const moduleInfo = getModuleInfo(packagePath)
		if (!moduleInfo) continue
		const protoBaseName =
			file.name.split("/").pop()?.replace(".proto", "") ?? "index"
		const importPath = buildDescriptorImport(
			moduleInfo.versionSegments,
			protoBaseName
		)

		for (const msg of file.messageType ?? []) {
			const fullName = `${file.package}.${msg.name}`
			map.set(fullName, importPath)
		}
	}
	return map
}

const loadHttpExtension = async (
	descriptors: FileDescriptorProto[],
	outPath: string
) => {
	const annotationsPath = join(
		outPath,
		"common",
		"google",
		"api",
		"annotations_pb.ts"
	)
	try {
		// Prefer the generated annotations if available (Buf deps include google/api/http).
		const mod = await import(pathToFileURL(annotationsPath).href)
		if (mod?.http) return mod.http
	} catch (_) {
		// fall through to registry-based resolution
	}

	const httpRelated = descriptors.filter((file) =>
		file.name?.startsWith("google/api/")
	)

	const files = [
		file_google_protobuf_descriptor.proto,
		...httpRelated.filter((f) => f.name !== "google/protobuf/descriptor.proto")
	]

	const registry = createFileRegistry(
		create(FileDescriptorSetSchema, { file: files })
	)
	const http = registry.getExtension("google.api.http")
	if (!http) {
		throw new Error(
			"google.api.http extension unavailable in descriptor set; REST client generation cannot proceed"
		)
	}
	return http
}

type HttpOptionPatternCase = "get" | "post" | "put" | "delete" | "patch"
type HttpOption = {
	pattern: { case?: HttpOptionPatternCase; value?: string }
	body: string
	additionalBindings?: HttpOption[]
}

const isHttpOption = (value: unknown): value is HttpOption => {
	if (!value || typeof value !== "object") return false
	const pattern = (value as { pattern?: unknown }).pattern
	if (!pattern || typeof pattern !== "object") return false
	const patternCase = (pattern as { case?: unknown }).case
	if (
		patternCase !== undefined &&
		patternCase !== "get" &&
		patternCase !== "post" &&
		patternCase !== "put" &&
		patternCase !== "delete" &&
		patternCase !== "patch"
	) {
		return false
	}
	const patternValue = (pattern as { value?: unknown }).value
	if (patternValue !== undefined && typeof patternValue !== "string") {
		return false
	}
	const body = (value as { body?: unknown }).body
	if (typeof body !== "string") return false

	const extra = (value as { additionalBindings?: unknown }).additionalBindings
	if (!extra) return true
	if (!Array.isArray(extra)) return false
	return extra.every((binding) => isHttpOption(binding))
}

const extractHttpRules = (
	method: FileDescriptorProto["service"][number]["method"][number],
	http: DescExtension
): HttpRule[] => {
	if (!method.options || !http) return []
	const rule = getExtension(method.options, http)
	if (!isHttpOption(rule) || rule.pattern.case === undefined) return []

	const rules: HttpRule[] = []
	const addRule = (r: HttpOption) => {
		if (!r.pattern.value) return
		switch (r.pattern.case) {
			case "get":
				rules.push({ method: "get", path: r.pattern.value, hasBody: false })
				break
			case "post":
				rules.push({
					method: "post",
					path: r.pattern.value,
					hasBody: r.body.length > 0
				})
				break
			case "put":
				rules.push({
					method: "put",
					path: r.pattern.value,
					hasBody: r.body.length > 0
				})
				break
			case "delete":
				rules.push({ method: "delete", path: r.pattern.value, hasBody: false })
				break
			case "patch":
				rules.push({
					method: "patch",
					path: r.pattern.value,
					hasBody: r.body.length > 0
				})
				break
			default:
				break
		}
	}

	addRule(rule)
	for (const extra of rule.additionalBindings ?? []) {
		addRule(extra)
	}

	return rules
}
