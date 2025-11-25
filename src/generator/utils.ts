export const toPascalCase = (value: string): string =>
	value
		.split(/[_\-/.]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("")

export const getModuleInfo = (packagePath: string) => {
	const segments = packagePath.split("/").filter(Boolean)
	if (segments.length < 2) {
		return null
	}

	const [root, module, ...rest] = segments
	return {
		moduleKey: `${root}/${module}`,
		moduleName: toPascalCase(module),
		versionSegments: rest,
		versionName: rest.length ? rest.map(toPascalCase).join("") : ""
	}
}
