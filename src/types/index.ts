export type ProtoGenOptions = {
	modules?: {
		grpc?: boolean
		grpcWeb?: boolean
		rest?: boolean
		rpc?: boolean
	}
}

export type ProtoGenInput = {
	protoDirs: string[]
	outPath: string
	options: ProtoGenOptions
	moduleIgnoreList?: string[]
}
