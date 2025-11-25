import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { defineConfig } from "rolldown"
import { dependencies } from "./package.json"

const collectInputs = (root: string): string[] => {
	const entries: string[] = []

	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue

			const fullPath = join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(fullPath)
			} else if (entry.name.endsWith(".ts")) {
				entries.push(relative(".", fullPath))
			}
		}
	}

	walk(root)
	return entries
}

const inputs = [...collectInputs("gen")]

const common = defineConfig({
	input: inputs,
	tsconfig: "./tsconfig.json",
	optimization: {
		inlineConst: true,
		pifeForModuleWrappers: true,
	},
	treeshake: {
		annotations: false,
		moduleSideEffects: false,
		propertyReadSideEffects: false,
		unknownGlobalSideEffects: false
	},
	transform: {
		assumptions: {
			setPublicClassFields: true,
			noDocumentAll: true
		}
	},
	external: Object.keys(dependencies),
	preserveEntrySignatures: "strict"
})

const config = defineConfig([
	{
		...common,
		platform: "neutral",
		resolve: {
			conditionNames: ["node", "import"],
			symlinks: true,
			exportsFields: [["exports"]]
		},
		output: {
			sourcemap: false,
			minify: {
				compress: {
					unused: true,
					dropDebugger: true,
				},
				mangle: {
					toplevel: true,
					keepNames: true
				},
				codegen: {
					removeWhitespace: true
				}
			},
			dir: "dist/esm",
			format: "esm",
			preserveModules: true,
			preserveModulesRoot: "gen",
			entryFileNames: "[name].js",
			chunkFileNames: "chunks/[name]-[hash].js",
			generatedCode: {
				preset: "es2015",
				profilerNames: false,
				symbols: false
			}
		}
	},
	{
		...common,
		platform: "node",
		resolve: {
			symlinks: true,
			exportsFields: [["exports"]],
			conditionNames: ["node", "require"]
		},
		output: {
			sourcemap: false,
			minify: {
				compress: {
					unused: true,
					dropDebugger: true
				},
				mangle: {
					toplevel: true,
					keepNames: true
				},
				codegen: {
					removeWhitespace: true
				}
			},
			dir: "dist/cjs",
			format: "cjs",
			preserveModules: true,
			preserveModulesRoot: "gen",
			entryFileNames: "[name].cjs",
			chunkFileNames: "chunks/[name]-[hash].cjs",
			generatedCode: {
				preset: "es2015",
				profilerNames: false,
				symbols: false
			}
		}
	}
])

export default config
