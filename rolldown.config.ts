import { defineConfig } from "rolldown"
import { dependencies, devDependencies } from "./package.json"

export default defineConfig({
	input: { cli: "scripts/gen.ts", index: "src/index.ts" },
	platform: "node",
	plugins: [
		{
			name: "package-scope",
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "package.json",
					source: '{"type":"module"}\n'
				})
			}
		}
	],
	external: id => Object.keys({ ...dependencies, ...devDependencies }).some(name => id === name || id.startsWith(`${name}/`)),
	output: { dir: "dist", cleanDir: true, format: "esm", entryFileNames: "[name].js" }
})
