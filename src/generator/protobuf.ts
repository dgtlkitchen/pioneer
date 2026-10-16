import { createRequire } from "node:module"

// protoc-gen-es is CommonJS. One protobuf instance builds, links and plugs every
// descriptor, so registries and extensions never cross module instances.
const require = createRequire(import.meta.url)
export const protobuf: typeof import("@bufbuild/protobuf") =
	require("@bufbuild/protobuf")
export const reflection: typeof import("@bufbuild/protobuf/reflect") =
	require("@bufbuild/protobuf/reflect")
export const wkt: typeof import("@bufbuild/protobuf/wkt") = require("@bufbuild/protobuf/wkt")
