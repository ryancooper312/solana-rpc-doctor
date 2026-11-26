# solana-rpc-doctor

[![CI](https://github.com/ryancooper312/solana-rpc-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/ryancooper312/solana-rpc-doctor/actions/workflows/ci.yml)

Zero-dependency TypeScript diagnostic toolkit and CLI for Solana JSON-RPC endpoints.

## Capabilities

- **Health & Version Probe**: Verifies `getHealth` and extracts `solana-core` version metadata.
- **Latency Distribution & Jitter**: Samples `getSlot` across configurable rounds to report `min`, `p50`, `p95`, `max`, and `p95 - p50` tail jitter.
- **Slot Lag Detection**: Compares confirmed slot height against an optional reference slot.
- **Prioritization Fee Summary**: Filters zero-fee slots from `getRecentPrioritizationFees` to compute recommended (`p50`) and `p75` micro-lamport fees.

## CLI Usage

```bash
node --experimental-strip-types ./bin/cli.mjs --url https://api.mainnet-beta.solana.com --samples 5
node --experimental-strip-types ./bin/cli.mjs --url https://api.mainnet-beta.solana.com --json
```

Sample output:

```text
Solana RPC Doctor — https://api.mainnet-beta.solana.com
Status: HEALTHY (ok)
Core Version: 2.1.14
Confirmed Slot: 318000100
Latency (ms): min=42.1 p50=48.3 p95=79.5 max=79.5 jitter=31.2
Priority Fees (microLamports): recommended=10000 p75=20000 max=40000 (2/3 non-zero)
```

## Testing

```bash
npm test
```

## License

MIT
