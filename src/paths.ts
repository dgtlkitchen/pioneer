import { fileURLToPath } from "node:url"

// Source and bundled entrypoints live one directory below the package root.
export const toolRoot = fileURLToPath(new URL("../", import.meta.url))
