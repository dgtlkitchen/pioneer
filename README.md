# Pioneer - TypeScript SDK for Cosmos SDK Blockchains

[![CI](https://github.com/buildonjuno/pioneer/actions/workflows/ci.yml/badge.svg)](https://github.com/buildonjuno/pioneer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@buildonjuno/pioneer.svg)](https://www.npmjs.com/package/@buildonjuno/pioneer)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Pioneer is a TypeScript library for interacting with Cosmos SDK-based blockchains, with a primary focus on Juno Network. It provides auto-generated TypeScript/JavaScript clients from Protocol Buffer definitions, enabling seamless blockchain interaction through multiple transport protocols.

## Features

- **Auto-generated TypeScript Clients**: Automatically generates TypeScript code from Cosmos SDK protobuf definitions
- **Multiple Transport Protocols**: Support for gRPC, gRPC-Web, REST, and Tendermint RPC
- **Type Safety**: Full TypeScript support with strict typing
- **Modern Tooling**: Built with Bun and Rolldown for fast builds and optimal performance
- **Comprehensive Module Support**: Covers all standard Cosmos SDK modules plus Juno-specific modules
- **Developer Friendly**: Simple API with clear examples and comprehensive documentation

## Installation

```bash
npm install @buildonjuno/pioneer
# or
yarn add @buildonjuno/pioneer
# or
pnpm add @buildonjuno/pioneer
# or
bun add @buildonjuno/pioneer
```

## Quick Start

### Basic Query Example

```typescript
import { createBankQueryClient } from "@buildonjuno/pioneer/grpc/cosmos/bank/v1beta1/Query";

// Create a bank query client
const bankClient = createBankQueryClient({
  baseUrl: "https://grpc.junotest.basementnodes.ca/"
});

// Query balance
const balance = await bankClient.balance({
  address: "juno1...",
  denom: "ujuno"
});

console.log("Balance:", balance.balance?.amount);
```

### Transaction Example

```typescript
import { create } from "@bufbuild/protobuf";
import { MsgSendSchema } from "@buildonjuno/pioneer/common/cosmos/bank/v1beta1/tx_pb";
import { createEthermintSigner } from "@buildonjuno/pioneer";

const signer = createEthermintSigner({
  mnemonic: "your twelve word mnemonic...",
  rpcEndpoint: "https://rpc.junotest.basementnodes.ca/",
  restEndpoint: "https://api.junotest.basementnodes.ca/",
  prefix: "juno",
  chainId: "juno-testnet-1"
});

// Create send message
const msgSend = create(MsgSendSchema, {
  fromAddress: await signer.getAddress(),
  toAddress: "juno1...",
  amount: [{
    denom: "ujuno",
    amount: "1000000" // 1 JUNO
  }]
});

// Sign and broadcast
const result = await signer.signAndBroadcast(
  [{
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    schema: MsgSendSchema,
    value: msgSend
  }],
  {
    feeDenom: "ujuno",
    feeAmount: "5000",
    gasLimit: "200000",
    mode: "BROADCAST_MODE_SYNC"
  }
);

console.log("TX Hash:", result?.tx_response?.txhash);
```

## Usage Examples

### 1. gRPC Client Usage

Pioneer generates strongly-typed gRPC clients for all Cosmos SDK modules:

```typescript
import { 
  createBankQueryClient,
  createStakingQueryClient,
  createDistributionQueryClient 
} from "@buildonjuno/pioneer/grpc";

// Bank queries
const bankClient = createBankQueryClient({ baseUrl: "https://grpc.juno.network" });
const balances = await bankClient.allBalances({ address: "juno1..." });

// Staking queries
const stakingClient = createStakingQueryClient({ baseUrl: "https://grpc.juno.network" });
const validators = await stakingClient.validators({ status: "BOND_STATUS_BONDED" });

// Distribution queries
const distClient = createDistributionQueryClient({ baseUrl: "https://grpc.juno.network" });
const rewards = await distClient.delegationTotalRewards({ delegatorAddress: "juno1..." });
```

### 2. Transaction Service Client

```typescript
import { createTxServiceClient } from "@buildonjuno/pioneer/grpc/cosmos/tx/v1beta1/Service";
import { SimulateRequestSchema } from "@buildonjuno/pioneer/common/cosmos/tx/v1beta1/service_pb";

const txClient = createTxServiceClient({
  baseUrl: "https://grpc.juno.network"
});

// Simulate transaction before broadcasting
const simulateResponse = await txClient.simulate({
  txBytes: signedTxBytes
});

console.log("Gas used:", simulateResponse.gasInfo?.gasUsed);

// Broadcast transaction
const broadcastResponse = await txClient.broadcastTx({
  txBytes: signedTxBytes,
  mode: "BROADCAST_MODE_SYNC"
});
```

### 3. Working with Juno-specific Modules

```typescript
import { createJunoFeepayQueryClient } from "@buildonjuno/pioneer/grpc/juno/feepay/v1/Query";
import { createJunoMintQueryClient } from "@buildonjuno/pioneer/grpc/juno/mint/v1/Query";

// Feepay module
const feepayClient = createJunoFeepayQueryClient({ baseUrl: "https://grpc.juno.network" });
const feePayContracts = await feepayClient.feePayContracts({});

// Mint module
const mintClient = createJunoMintQueryClient({ baseUrl: "https://grpc.juno.network" });
const inflationParams = await mintClient.inflationParams({});
```

### 4. Error Handling

```typescript
try {
  const result = await bankClient.balance({
    address: "juno1...",
    denom: "ujuno"
  });
} catch (error) {
  if (error.code === "NOT_FOUND") {
    console.error("Account not found");
  } else if (error.code === "UNAVAILABLE") {
    console.error("gRPC endpoint unavailable");
  } else {
    console.error("Unknown error:", error);
  }
}
```

## API Overview

### Client Types

1. **gRPC Clients** (`/grpc`): Direct gRPC communication with blockchain nodes
2. **gRPC-Web Clients** (`/grpc-web`): Browser-compatible gRPC clients (coming soon)
3. **REST Clients** (`/rest`): RESTful API clients (coming soon)
4. **Tendermint RPC** (`/rpc`): Tendermint consensus layer interaction (coming soon)

### Supported Modules

#### Cosmos SDK Standard Modules
- `auth` - Account authentication and authorization
- `authz` - Authorization grants
- `bank` - Token transfers and balance queries
- `circuit` - Circuit breaker for halting modules
- `consensus` - Consensus parameter updates
- `crisis` - Invariant checking
- `distribution` - Staking rewards distribution
- `evidence` - Evidence handling for misbehavior
- `feegrant` - Fee allowance grants
- `gov` - On-chain governance
- `group` - Group accounts and policies
- `mint` - Token minting and inflation
- `nft` - Non-fungible tokens
- `params` - Parameter management (deprecated)
- `slashing` - Validator slashing
- `staking` - Proof-of-stake staking
- `tx` - Transaction service
- `upgrade` - Software upgrade handling
- `vesting` - Token vesting accounts

#### Juno-specific Modules
- `clock` - On-chain cron jobs
- `cwhooks` - CosmWasm contract hooks
- `drip` - Token distribution/dripping
- `feepay` - Fee payment abstractions
- `feeshare` - Fee sharing mechanism
- `mint` - Custom Juno minting logic

#### Additional Modules
- `gaia/globalfee` - Global minimum fee for Cosmos Hub
- `osmosis/tokenfactory` - Token factory for creating new tokens

## Development

### Prerequisites

- Bun >= 1.0.0
- Node.js >= 18 (for some tooling compatibility)

### Setup

```bash
# Clone the repository
git clone https://github.com/CosmosContracts/pioneer.git
cd pioneer

# Install dependencies
bun install

# Generate TypeScript code from protos
bun run generate

# Build the project
bun run build

# Run tests
bun test
```

### Project Structure

```
pioneer/
├── proto/           # Source protobuf definitions
├── generated/       # Auto-generated TypeScript code
│   ├── common/      # Protobuf message types
│   ├── grpc/        # gRPC client factories
│   ├── grpc-web/    # gRPC-Web clients (placeholder)
│   ├── rest/        # REST clients (placeholder)
│   └── rpc/         # Tendermint RPC (placeholder)
├── src/             # Source code
│   ├── generator.ts # Code generation logic
│   └── types/       # TypeScript type definitions
├── scripts/         # Development scripts
├── examples/        # Usage examples
└── tests/           # Test suites
```

### Code Generation

Pioneer uses Buf to manage protobuf dependencies and generate TypeScript code:

```bash
# Regenerate all TypeScript code
bun run generate

# Test the generator
bun run test-gen

# Test gRPC functionality
bun run test-grpc
```

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `test:` Test additions or updates
- `refactor:` Code refactoring
- `chore:` Maintenance tasks

## Troubleshooting

### Common Issues

1. **"Cannot find module" errors**
   - Ensure you've run `bun run generate` before building
   - Check that all dependencies are installed with `bun install`

2. **gRPC connection errors**
   - Verify the gRPC endpoint URL is correct and accessible
   - Check if the endpoint requires TLS/SSL
   - Ensure your network allows gRPC connections (port 443 for HTTPS)

3. **Transaction broadcasting failures**
   - Verify account has sufficient balance for fees
   - Check sequence number is correct (use auth module to query)
   - Ensure chain ID matches the network

4. **Build errors**
   - Make sure you're using Bun >= 1.0.0
   - Try clearing the build cache: `bun run clean && bun run build`

### Debug Mode

Enable detailed logging:

```typescript
// Set debug mode for Connect-RPC
import { createPromiseClient } from "@connectrpc/connect";

const client = createPromiseClient(service, transport, {
  // Enable debug logging
  interceptors: [(next) => async (req) => {
    console.log("Request:", req);
    const res = await next(req);
    console.log("Response:", res);
    return res;
  }]
});
```

## Resources

- [Juno Network Documentation](https://docs.junonetwork.io)
- [Cosmos SDK Documentation](https://docs.cosmos.network)
- [Buf Documentation](https://buf.build/docs)
- [Connect-RPC Documentation](https://connectrpc.com/docs)
- [Example Applications](./examples)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

Built with ❤️ by the Juno Network community.

Special thanks to:
- The Cosmos SDK team for the amazing blockchain framework
- The Buf team for excellent protobuf tooling
- The Connect-RPC team for modern gRPC support
- All contributors who help make Pioneer better

---

For more examples and detailed documentation, visit our [documentation site](https://docs.junonetwork.io) or check out the [examples](./examples) directory.
