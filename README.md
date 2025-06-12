# @velo-dao/velo-ts

```sh
npm install @velo-dao/velo-ts
yarn install @velo-dao/velo-ts
pnpm install @velo-dao/velo-ts
bun install @velo-dao/velo-ts
```

## Velo TypeScript Bundle

### Clients

All contracts are scoped under the `contracts` object:

```js
import { contracts } from "@velo-dao/velo-ts"
const { VeloPredictions } = contracts
```

Then each contract will have clients, for example for `VeloPredictions`:

```ts
const {
 VeloPredictionsClient,
 VeloPredictionsMessageComposer,
 VeloPredictionsQueryClient
} = VeloPredictions
```

## Credits

🛠 Built by [Digital Kitchen](https://digitalkitchen.io), based on [Cosmology ⚛️](https://cosmology.tech/validator) goodness!

Using CosmWasm TS Codegen:

- [@cosmwasm/ts-codegen](https://github.com/CosmWasm/ts-codegen) for generated CosmWasm contract Typescript classes
