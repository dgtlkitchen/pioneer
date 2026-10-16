#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { generate } from "../src/generator/index.js"
import { toolRoot } from "../src/paths.js"

const { values } = parseArgs({ options: {
	"input-path": { type: "string" }, "output-path": { type: "string" },
	"dependency-path": { type: "string", multiple: true },
	"package-name": { type: "string" }, "package-version": { type: "string" },
	"ignore-path": { type: "string", multiple: true }, react: { type: "boolean" },
	license: { type: "string" }, "license-file": { type: "string", multiple: true },
	help: { type: "boolean" }, version: { type: "boolean" }
}, strict: true })

if (values.help) {
	console.log("pioneer --input-path ./proto --output-path ./codegen [--package-name @scope/sdk] [--package-version 0.1.0] [--dependency-path ../sdk/proto] [--ignore-path cosmos/base/reflection] [--react] [--license Apache-2.0] [--license-file ./LICENSE] [--help] [--version]")
} else if (values.version) {
	const path = join(toolRoot, "package.json")
	const metadata: unknown = JSON.parse(await readFile(path, "utf8"))
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		!("name" in metadata) ||
		typeof metadata.name !== "string" ||
		!metadata.name.trim() ||
		!("version" in metadata) ||
		typeof metadata.version !== "string" ||
		!metadata.version.trim()
	)
		throw new Error(`Invalid CLI package name or version in ${path}`)
	console.log(`${metadata.name} ${metadata.version}`)
} else {
	if (!values["input-path"] || !values["output-path"]) throw new Error("--input-path and --output-path are required; use --help")
	console.log(await generate({ inputPath: values["input-path"], outputPath: values["output-path"], dependencyPaths: values["dependency-path"], packageName: values["package-name"], packageVersion: values["package-version"], ignorePaths: values["ignore-path"], react: values.react, license: values.license, licenseFiles: values["license-file"] }))
}
