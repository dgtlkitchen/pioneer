import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { create, createFileRegistry, toBinary } from "@bufbuild/protobuf"
import {
	type FileDescriptorProto,
	FileDescriptorProtoSchema,
	FileDescriptorSetSchema,
	file_google_protobuf_descriptor
} from "@bufbuild/protobuf/wkt"
import { createClient } from "@connectrpc/connect"
import { createGrpcTransport } from "@connectrpc/connect-node"
import { generateCommon } from "./common.ts"
import { generateGrpc } from "./grpc.ts"
import { generateRest } from "./rest.ts"
import { generateRpc } from "./rpc.ts"

export type ProtoGenOptions = {
	grpcEndpoint?: string
	modules?: {
		common?: boolean
		grpc?: boolean
		rest?: boolean
		rpc?: boolean
	}
}

export type ProtoGenInput = {
	outPath: string
	options: ProtoGenOptions
	moduleIgnoreList?: string[]
}

export const generate = async ({
	outPath,
	options,
	moduleIgnoreList
}: ProtoGenInput): Promise<void> => {
	console.log(
		"Starting Pioneer code generator with options:",
		JSON.stringify(options, null, 2)
	)

	const mods = options.modules || {
		common: true,
		grpc: true,
		rest: true,
		rpc: true
	}

	const grpcEndpoint =
		options.grpcEndpoint ??
		process.env.PIONEER_GRPC_ENDPOINT ??
		process.env.GRPC_ENDPOINT
	if (!grpcEndpoint) {
		throw new Error(
			"grpcEndpoint is required to pull descriptors via reflection"
		)
	}

	await cleanGenerated(outPath)

	console.log(
		`Fetching descriptors from ${grpcEndpoint} via cosmos.reflection.v1.ReflectionService...`
	)
	const descriptors = await fetchDescriptors(grpcEndpoint)
	const { descriptorPath, cleanup } = await writeDescriptorSet(descriptors)

	try {
		if (mods.common) await generateCommon(outPath, descriptorPath)
		if (mods.grpc)
			await generateGrpc(outPath, descriptors, moduleIgnoreList ?? [])
		if (mods.rest)
			await generateRest(outPath, descriptors, moduleIgnoreList ?? [])
		if (mods.rpc)
			await generateRpc(outPath, descriptors, moduleIgnoreList ?? [])
	} finally {
		await cleanup()
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const outPath = join(process.cwd(), "generated")
	const moduleIgnoreList = ["cosmos/reflection", "cosmos/autocli"]

	generate({
		outPath,
		options: {
			modules: {
				common: true,
				grpc: true,
				rest: true,
				rpc: true
			},
			grpcEndpoint: process.env.PIONEER_GRPC_ENDPOINT ?? "http://localhost:9090"
		},
		moduleIgnoreList
	}).catch((err) => {
		console.error(err)
		process.exit(1)
	})
}

const cleanGenerated = async (outPath: string) => {
	try {
		const entries = await fs.readdir(outPath, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			if (
				entry.name === "common" ||
				entry.name === "cosmos" ||
				entry.name === "rpc"
			)
				continue
			await fs.rm(join(outPath, entry.name), { recursive: true, force: true })
		}
	} catch {
		// ignore if directory doesn't exist yet
	}
}

const reflectionFileDescriptor: FileDescriptorProto = create(
	FileDescriptorProtoSchema,
	{
		name: "cosmos/reflection/v1/reflection.proto",
		package: "cosmos.reflection.v1",
		dependency: ["google/protobuf/descriptor.proto"],
		syntax: "proto3",
		messageType: [
			{
				name: "FileDescriptorsRequest"
			},
			{
				name: "FileDescriptorsResponse",
				field: [
					{
						name: "files",
						number: 1,
						type: 11,
						label: 3,
						typeName: ".google.protobuf.FileDescriptorProto"
					}
				]
			}
		],
		service: [
			{
				name: "ReflectionService",
				method: [
					{
						name: "FileDescriptors",
						inputType: ".cosmos.reflection.v1.FileDescriptorsRequest",
						outputType: ".cosmos.reflection.v1.FileDescriptorsResponse"
					}
				]
			}
		]
	}
)

const getReflectionService = () => {
	const registry = createFileRegistry(
		reflectionFileDescriptor,
		(protoFileName) => {
			if (protoFileName === "google/protobuf/descriptor.proto") {
				return file_google_protobuf_descriptor
			}
			return undefined
		}
	)

	const service = registry.getService("cosmos.reflection.v1.ReflectionService")
	const request = registry.getMessage(
		"cosmos.reflection.v1.FileDescriptorsRequest"
	)
	const response = registry.getMessage(
		"cosmos.reflection.v1.FileDescriptorsResponse"
	)

	if (!service || !request || !response) {
		throw new Error("Failed to construct reflection service descriptors")
	}

	return { service, request, response }
}

const fetchDescriptors = async (
	grpcEndpoint: string
): Promise<FileDescriptorProto[]> => {
	const { service } = getReflectionService()
	const transport = createGrpcTransport({ baseUrl: grpcEndpoint })
	type ReflectionClient = {
		fileDescriptors: (req: object) => Promise<{ files?: FileDescriptorProto[] }>
	}
	const client = createClient(service, transport) as unknown as ReflectionClient

	try {
		const response = await client.fileDescriptors({})
		return response.files ?? []
	} catch (error) {
		throw new Error(
			`Failed to fetch descriptors from reflection service: ${String(error)}`
		)
	}
}

const writeDescriptorSet = async (descriptors: FileDescriptorProto[]) => {
	const tmpDir = await fs.mkdtemp(join(tmpdir(), "pioneer-descriptors-"))
	const descriptorPath = join(tmpDir, "descriptor.bin")
	const descriptorSet = create(FileDescriptorSetSchema, { file: descriptors })
	const bytes = toBinary(FileDescriptorSetSchema, descriptorSet)
	await fs.writeFile(descriptorPath, bytes)

	return {
		descriptorPath,
		async cleanup() {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	}
}
