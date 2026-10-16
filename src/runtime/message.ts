import {
	create,
	type DescMessage,
	fromBinary,
	type MessageInitShape,
	toBinary
} from "@bufbuild/protobuf"
import { type Any, AnySchema } from "@bufbuild/protobuf/wkt"

export function message<D extends DescMessage>(schema: D) {
	return (input: MessageInitShape<D>): Any =>
		create(AnySchema, {
			typeUrl: `/${schema.typeName}`,
			value: toBinary(schema, create(schema, input))
		})
}

export function unpackMessage<D extends DescMessage>(
	schema: D,
	packed: Any | undefined
) {
	if (!packed || packed.typeUrl.split("/").at(-1) !== schema.typeName)
		throw new Error(`Expected ${schema.typeName} response`)
	return fromBinary(schema, packed.value)
}
