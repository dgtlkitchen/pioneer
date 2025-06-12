import { defineConfig } from "rolldown"
import { dts } from "rolldown-plugin-dts"
import { dependencies } from "./package.json"

const common = defineConfig({
	input: {
		cosmos: "src/cosmos/index.ts",
		juno: "src/juno/index.ts",
		cosmwasm: "src/cosmwasm/index.ts",
		gaia: "src/gaia/index.ts",
		ibc: "src/ibc/index.ts",
		osmosis: "src/osmosis/index.ts"
	},
	jsx: false,
	treeshake: {
		moduleSideEffects: "no-external"
	},
	keepNames: true,
	transform: {
		assumptions: {
			setPublicClassFields: true,
			noDocumentAll: true
		}
	},
	external: Object.keys(dependencies),
	platform: "browser"
})

const config = defineConfig([
	{
		...common,
		resolve: {
			conditionNames: ["node", "import"],
			tsconfigFilename: "./tsconfig.json",
			symlinks: true,
			exportsFields: [["exports"]]
		},
		output: {
			sourcemap: true,
			minify: {
				compress: true,
				mangle: true,
				removeWhitespace: true
			},
			dir: "dist/esm",
			format: "esm",
			entryFileNames: "[name]/index.mjs",
			chunkFileNames: "common/[name]-[hash].mjs"
		}
	},
	{
		...common,
		platform: "node",
		resolve: {
			tsconfigFilename: "./tsconfig.json",
			symlinks: true,
			exportsFields: [["exports"]],
			conditionNames: ["node", "require"]
		},
		output: {
			sourcemap: true,
			minify: {
				compress: true,
				mangle: true,
				removeWhitespace: true
			},
			dir: "dist/cjs",
			format: "cjs",
			entryFileNames: "[name]/index.cjs",
			chunkFileNames: "common/[name]-[hash].cjs"
		}
	},
	{
		...common,
		plugins: [dts({ emitDtsOnly: true })],
		output: {
			sourcemap: true,
			exports: "named",
			dir: "dist/types",
			format: "esm",
			entryFileNames: "[name].ts",
			chunkFileNames: "common/[name]-[hash].d.ts"
		}
	}
])

export default config
