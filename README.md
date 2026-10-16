# Pioneer

**A CLI that turns protobuf sources into a typed npm SDK package.** Pioneer is
the generator—not the generated chain SDK and not a wallet application.

```sh
pioneer --input-path ./proto --output-path ./codegen/ \
  --package-name @example/sdk --package-version 0.1.0
```

The input is a local directory/Buf source root. Buf discovers its owning
configuration and lockfile, including declared imports. No running node,
reflection service, mnemonic or environment file is required. The output is a
dedicated generated package directory, with compiled ESM JavaScript,
declarations, exports, pinned runtime dependencies and provenance.

## Installed CLI

The selected CLI identity is `@vastward/pioneer@0.0.1` from
`https://github.com/dgtlkitchen/pioneer`. The CLI and generated `@vastward/sdk`
are distinct packages. This source candidate does not establish publication or
installed-package acceptance.

After separate release and installation approval, the pinned global installation
command is:

```sh
npm install --global --ignore-scripts --registry=https://registry.npmjs.org @vastward/pioneer@0.0.1
pioneer --version
pioneer --help
```

These commands describe future authorized operations, not completed installation.
The selected release requires Node `>=20.19.0` and independent cold-install
qualification on macOS ARM64, Linux x64, and Windows x64.
`pioneer --version` reads the installed package's name and version.
Version output identifies metadata, not registry integrity or source authenticity.
Release acceptance must separately verify the exact tarball, dependencies,
checksums, and producer provenance.

Production generation invokes the installed `pioneer` executable, as in the first
example. The installed package supplies its compiled CLI, generator chunks,
declarations, and `src/runtime` templates. Production generation must not require
a sibling Pioneer checkout, sibling `dist/cli.js`, or cached producer output.
Schema roots remain explicit inputs. Generated `provenance.json` records input
and artifact hashes but does not establish trusted schema ownership or release
authorization. Package closure and cold installation remain unverified.

## This workspace

| Repository | Responsibility |
| --- | --- |
| `pioneer` | Generic generator CLI |
| `neorome-core` + local `cosmos-sdk` | Actual protobuf contracts |
| `neorome-ts` | Generated package **`@neorome/sdk`** |
| `passkeys-demo` | Existing React Router/TanStack application consuming the SDK |

The following example is for source development only, not production generation.
From `neorome-core`, the example invokes the built local CLI:

```sh
node ../pioneer/dist/cli.js \
  --input-path ./proto \
  --dependency-path ../cosmos-sdk/proto \
  --output-path ../neorome-ts \
  --package-name @neorome/sdk \
  --ignore-path cosmos/base/reflection --react \
  --package-version 0.1.0
```

`--dependency-path` is repeatable. Later explicit sources override same-named
descriptor files, so the local SDK can replace the BSR SDK descriptors imported
by core. Do not mix incompatible sources; descriptor linking and strict generated
TypeScript compilation must succeed before replacement. Current Neorome type
URLs still use **`coolcat.*`**: client-only renaming would break the protocol.

`passkeys-demo/packages/verdant-web/package.json` uses
`"@neorome/sdk": "file:../../../neorome-ts"`. Generated output does not install its
own dependencies. Refresh the consumer's local file dependency after regeneration
using a reviewed, frozen install; do not accept unrelated version changes.

## Generated API

Canonical proto paths become package subpaths. `_pb` modules export Protobuf-ES
messages, schemas, enums and service descriptors. `_client` modules are emitted
only where an implemented transport applies:

```ts
import { createQueryRpcClient as bankClient } from "@neorome/sdk/cosmos/bank/v1beta1/query_client"
import { createQueryRpcClient as accountClient } from "@neorome/sdk/coolcat/accounts/v1/query_client"
import { messages } from "@neorome/sdk/cosmos/bank/v1beta1/tx_client"

const bank = bankClient({ baseUrl: "https://rpc.vexx.sh" })
const accounts = accountClient({ baseUrl: "https://rpc.vexx.sh" })
const balance = await bank.balance({ address, denom: "urome" }, { signal })
const account = await accounts.accountNumber({ address }, { signal })
// account.number is bigint; Coin.amount remains an exact decimal string.
const send = messages.send({
  fromAddress: address, toAddress: recipient,
  amount: [{ denom: "urome", amount: "1000000" }]
})
```

- REST uses actual unary `google.api.http` bindings, schema-based protobuf JSON,
  dotted query parameters and encoded URI variables. One canonical HTTP binding
  is emitted per method; additional bindings are alternative URLs, not duplicate
  JavaScript methods. Streaming methods remain service descriptors.
- On Cosmos inputs, module `Query` services also receive typed ABCI-over-RPC
  clients. **Account queries currently have no REST annotations.** Tx service,
  reflection and node-info methods are not invented as ABCI routes.
- Cosmos `Msg` service helpers return typed protobuf `Any` values, not unsigned
  writes. The global registry supports application and well-known `Any` payloads.
- HTTP errors, malformed protobuf JSON and oversized responses reject. Requests
  default to 15 seconds/4 MiB, accept cancellation, omit cookies and reject
  redirects. Override limits explicitly when appropriate.
- Generated runtimes have **two exact dependencies**: Protobuf-ES 2.16.0
  (Apache-2.0 AND BSD-3-Clause) and scure/base 2.4.0 (MIT), with no runtime
  transitives at those versions. Node generator/transport dependencies do not
  enter the browser SDK.

## Transactions and TanStack Query

Each package exports `operations.json`: one entry per emitted service/method,
including request/response type names, actual factory/symbol and transport.
Metadata records actual HTTP bindings and the alternate `rpcFactory` for Cosmos
module queries. SDK React hooks prefer ABCI for those queries. Schema-only
messages are not invented endpoints.

`--react` emits an opt-in SDK React surface, with optional React/TanStack peers;
the core SDK entry never imports it. `--ignore-path` is a repeatable namespace
exclusion list. The Neorome command above excludes `cosmos/base/reflection`,
emitting **224 descriptors and 329 hooks: 189 queries / 140 mutations / 33 modules**.
Query-only modules are flat (`@neorome/sdk/react/epochs/use-current-epoch`);
mixed modules use `react/bank/query/use-balance` and `react/bank/tx/use-send`.
There are no empty generated query/tx directories. `react/hooks.json` maps every
operation/export/path. Version suffixes resolve actual collisions. The frontend
no longer generates or stores these modules; see its `src/hooks/README.md`.

The existing app is RPC-only at `https://rpc.vexx.sh`, expected chain `nero-1`.
REST-only hooks fail explicitly without REST configuration. Cosmos SDK output
also supplies `createCometClient` for native `status`, `broadcast_tx_sync` and `tx`
JSON-RPC. Exact transaction-not-found differs from disabled indexing or transport
failure; status is checked on the same RPC before preparation/submission. No
endpoint was contacted or configured remotely by generation.

When the input contains Cosmos transaction schemas, root exports include
`createDirectSignDoc` and `assembleTransaction`. Supply the real chain ID,
smart-account number/sequence, messages, signer public key where required,
integer fees/gas and timeout height. Helpers snapshot exact protobuf bytes; they
do not guess identity/fees, acquire credentials, verify signatures or grant
authorization. The old Ethermint mnemonic/Keccak signer is no longer the signing
path. Neorome's WebAuthn challenge and CCPK envelope belong to the consuming app.

The combined `useChain.ts` layer was replaced with individual hooks and colocated
options. Queries return full SDK types and cache JSON-safe protobuf bytes for SSR,
preserving Any URLs and unknown fields. Keys include network, endpoints, operation
and request; reads propagate cancellation. Mutations require explicit submission,
never automatically retry or resume offline, and return actual submission receipts
rather than fabricated per-message execution responses. Reviewed transfer
preparation and bounded confirmation also have individual module hook files.

`submitted` means CheckTx acceptance, not execution. Network loss during broadcast
is **uncertain**: query the locally computed transaction hash before retrying.
Confirmation requires an included response with execution code zero; included
failures still invalidate balances/sequence because fees may have been spent.
These hooks are not yet connected to the prototype's native-auth UI. They do not
make fake localStorage accounts or SQL faucet/transfers chain-backed.

## Tool development and verification

Use the existing pinned `bun.lock`, with reviewed installation and lifecycle
scripts disabled. **Bun1.4.0 package-manager commands loaded `.env` despite
`--no-env-file` during inspection. Install only from an environment-file-free
checkout; do not assume that flag protects package-manager operations.** The
automatic `mise install` prepare hook and unsafe build shortcut were removed.
The owner subsequently confirmed the local Pioneer environment file has no
secrets; inspection showed public endpoints and empty credentials. Its live-test
flag is not authorization to submit transactions. Approved React compilation
dependencies were installed with exact pins and lifecycle scripts disabled.
Existing advisory findings remain deployment gates. The app uses the TypeScript
7.0.2 native compiler. Pioneer uses the TypeScript 6.0.3 API because TypeScript 7
does not provide the programmatic compiler API required by its generator.

With dependencies installed:

```sh
npm run build
npm run typecheck
npm run test:unit
```

The build produces `dist/cli.js` (the `pioneer` bin), programmatic generator API
and its declarations. It replaces only the tool's generated `dist` output.
Generic offline fixtures test generation, compiled imports, regeneration and
failure preservation. Every output package is checked with strict TypeScript and
**without** `skipLibCheck` before anything is written: all emitted declarations,
plus Pioneer-authored client, hook and runtime source bodies. Sources link schemas
through the same `_pb` declarations consumers receive.
Neorome-specific SDK/transaction/TanStack tests live in the app's
`packages/verdant-web/tests`; they use mocked transports, not a live mnemonic.

Generation and checking run in memory, so a failure leaves the output untouched.
The output is then updated in place: stale files are removed, only changed files
are written, and `provenance.json` is written last. There is no backup copy; keep
the output under version control. Existing files are not read back: the hashes
in `provenance.json` are trusted, so hand edits to generated files survive until
their generated content changes; review them with Git. Deleted artifacts are
written again. Rerunning usually repairs an interrupted update; if it had already
added files, the next run refuses them as unmanaged, so restore the output from
Git. Run one generator per output, with consumers stopped. Unmanaged files and
directories, Git metadata and installed dependencies are rejected rather than
silently deleted or published. Finder's
`.DS_Store` metadata is preserved but excluded from package artifacts. Keep
handwritten code elsewhere. `provenance.json` records descriptor and artifact
SHA-256 hashes; this is reproducibility evidence, not a trusted-chain proof.

### Generation pipeline

1. `buf build` compiles each source root to a descriptor set (in parallel).
2. protoc-gen-es runs in-process, with the requests Buf's per-directory strategy
   would send: source-retention options stripped, well-known types imported
   from `@bufbuild/protobuf/wkt` outside their own directory. Its output is
   byte-identical to `buf generate`.
3. Clients, registry and hooks are generated in memory.
4. oxc (via the pinned `rolldown` dependency) emits ES2022 JavaScript and
   isolated declarations per file, so generated templates carry explicit types.
5. The strict check runs over an in-memory compiler host.
6. Only changed files are written into the output, then `provenance.json`.

`provenance.json` also records `inputSha256`: descriptors, sources, package
options, generator code, runtime templates and toolchain versions. When the
output already has that value and no recorded artifact is missing, regeneration
is a no-op and nothing is rewritten. A successful strict check is cached by the exact checked
content and toolchain in `$XDG_CACHE_HOME/pioneer` (macOS
`~/Library/Caches/pioneer`, Windows `%LOCALAPPDATA%\pioneer`). Set
`PIONEER_CACHE_DIR` to relocate it, or to an empty string to always re-check.

## Publication and remaining application work

The output has npm package layout, **not publication authorization**. Pioneer
declares the selected Apache-2.0 license with the complete text in `LICENSE`.
The existing author attribution remains in `package.json`. Source attribution
and distribution-rights review remain release gates, not conclusions from the
license selection. Generated packages default to `UNLICENSED`; pass
`--license <SPDX>` and repeatable `--license-file <path>` (for example the schema
repository's `LICENSE` and `NOTICE`) to publish a license and its text at the
package root.
The CLI license does not change input-schema licenses or generated-package rights.
The selected `@vastward/sdk` license requires its separate metadata approval.

`bun.lock` still records the inherited workspace name. The source-only identity
change does not authorize lockfile regeneration or dependency resolution.
Frozen-lock installation qualification remains open. Packaging, security review,
installation, and publication require their separate approval windows.

Generating current schemas does not implement planned registry/proof, native
origin/signature hardening, recovery, session or testnet-faucet contracts. Native
provider verification and real registration/transfer execution remain separate
acceptance work. No mainnet/testnet node or original Verdant database is needed
for code generation or these offline SDK tests.
