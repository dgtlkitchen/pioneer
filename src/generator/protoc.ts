import { createRequire } from "node:module"
import { posix } from "node:path"
import type { Registry } from "@bufbuild/protobuf"
import type { ReflectMessage } from "@bufbuild/protobuf/reflect"
import type {
	CodeGeneratorRequest,
	CodeGeneratorResponse,
	FileDescriptorProto
} from "@bufbuild/protobuf/wkt"
import { protobuf, reflection, wkt } from "./protobuf.js"

const require = createRequire(import.meta.url)
const pluginPath =
	"@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js"
const { version } = require("@bufbuild/protoc-gen-es/package.json") as {
	version: string
}
export const generatorVersion = `protoc-gen-es@${version}`

let plugin:
	| { run(request: CodeGeneratorRequest): CodeGeneratorResponse }
	| undefined

/** Like protoc and Buf, plugins see source-retention options only for generated files. */
function stripSourceRetention(
	message: ReflectMessage,
	registry: Registry
): boolean {
	const source = wkt.FieldOptions_OptionRetention.RETENTION_SOURCE
	const options =
		message.desc.typeName.startsWith("google.protobuf.") &&
		message.desc.typeName.endsWith("Options")
	let changed = false
	for (const field of message.fields) {
		if (!message.isSet(field)) continue
		if (options && field.proto.options?.retention === source) {
			message.clear(field)
			changed = true
		} else if (field.fieldKind === "message") {
			const child = message.get(field)
			if (!stripSourceRetention(child, registry)) continue
			changed = true
			// An options message emptied by stripping is absent, not empty.
			if (
				!child.fields.some((member) => child.isSet(member)) &&
				!child.getUnknown()?.length
			)
				message.clear(field)
		} else if (field.fieldKind === "list" && field.listKind === "message") {
			for (const item of message.get(field))
				changed =
					stripSourceRetention(item as ReflectMessage, registry) || changed
		}
	}
	const unknown = options ? message.getUnknown() : undefined
	if (unknown) {
		const kept = unknown.filter(
			(entry) =>
				registry.getExtensionFor(message.desc, entry.no)?.proto.options
					?.retention !== source
		)
		if (kept.length !== unknown.length) {
			message.setUnknown(kept)
			changed = true
		}
	}
	return changed
}

/**
 * Run protoc-gen-es in-process over every linked descriptor, with the requests
 * Buf's default per-directory strategy sends: a well-known type is generated
 * (and imported locally) only beside its own directory; elsewhere it maps to
 * @bufbuild/protobuf/wkt. Other files never depend on the grouping.
 */
export function generateSchemas(
	files: FileDescriptorProto[],
	registry: Registry
): Map<string, string> {
	plugin ??= (
		require(pluginPath) as { protocGenEs: NonNullable<typeof plugin> }
	).protocGenEs
	const protoFile = files.map((file) => {
		const copy = protobuf.clone(wkt.FileDescriptorProtoSchema, file)
		stripSourceRetention(
			reflection.reflect(wkt.FileDescriptorProtoSchema, copy),
			registry
		)
		return copy
	})
	const groups = new Map<string, FileDescriptorProto[]>()
	for (const file of files) {
		const directory = posix.dirname(file.name)
		const group = directory.startsWith("google/protobuf") ? directory : ""
		const members = groups.get(group)
		if (members) members.push(file)
		else groups.set(group, [file])
	}
	const output = new Map<string, string>()
	for (const generated of groups.values()) {
		const response = plugin.run(
			protobuf.create(wkt.CodeGeneratorRequestSchema, {
				protoFile,
				sourceFileDescriptors: generated,
				fileToGenerate: generated.map((file) => file.name),
				parameter: "target=ts,import_extension=js"
			})
		)
		if (response.error) throw new Error(`protoc-gen-es: ${response.error}`)
		for (const file of response.file) output.set(file.name, file.content)
	}
	return output
}
