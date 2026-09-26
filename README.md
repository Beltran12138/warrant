# Mandate

**A prompt is not suitability.** When an AI agent trades for you, the only thing standing between
"what you meant" and "what it did" is usually a sentence in a system prompt. Mandate turns that
sentence into an on-chain object: a **versioned, revocable, expiring mandate** that a principal
grants to an agent, plus a **preflight** that scores every proposed trade against it and an
**on-chain attestation** that the agent saw that scorecard before it acted.

Mandate **reveals, it does not enforce.** It never custodies funds, never blocks a trade and never
tries to bypass a wallet's own guard rails. What it adds is *verifiability*: after the fact anyone
can check what the agent was allowed to do, and prove it was told the trade was out of bounds.

```
principal ──setMandate / revoke──▶ MandateRegistry (on-chain)
                                         │ getMandate
agent ── mm swap quote ──▶ mm mandate preflight ──▶ scorecard (pass / warn / fail)
                                         │
agent ──attestPreflight(quoteHash, version, verdict, scorecardHash)──▶ PreflightAttested event
```

## Deployments

`MandateRegistry` has the **same address on both chains** (same deployer, nonce 0):
`0xf0145a8b57fb97d352f7a650b4c4ae4488951f48`

| Chain | Deploy tx | Explorer |
|---|---|---|
| Monad testnet (10143) | `0x2ba4bf3340da214190e65b3570f0a180267612af9857d3703237a0a6236a8567` | [contract](https://testnet.monadvision.com/address/0xf0145a8b57fb97d352f7a650b4c4ae4488951f48) |
| Avalanche Fuji C-Chain (43113) | `0x08f47a1eb07909b48afe58e1974dc5c64d88d948ecb7eca2de6e1b3a80326521` | [contract](https://testnet.snowtrace.io/address/0xf0145a8b57fb97d352f7a650b4c4ae4488951f48) |

Deployment records: `contracts/broadcast/Deploy.s.sol/{10143,43113}/`.

### Live run (2026-09-26)

`scripts/demo-onchain.mjs` executed on both chains: grant → preflight against the on-chain mandate
→ agent attests a PASS and a FAIL scorecard → principal revokes. Every transaction below returned
`status = success` with one event log.

| Step | Monad testnet | Avalanche Fuji |
|---|---|---|
| `setMandate` (principal) | [0x3bdf…a431](https://testnet.monadvision.com/tx/0x3bdfda2a184a025145aa378a6ba99d86b12b905e22912118f19311a0ec5aa431) | [0xd681…1a10](https://testnet.snowtrace.io/tx/0xd6817e8df118d6fc50eaff0a4101daeed17e49c916fc1c1134c8b41248271a10) |
| `attestPreflight` PASS (agent) | [0x1eeb…2cf2](https://testnet.monadvision.com/tx/0x1eebf9dd70c43ef980b81583b569828104bb10934ce1b0cb75bc04f2e5fc2cf2) | [0x0dfe…064c](https://testnet.snowtrace.io/tx/0x0dfe6bae7c3d3ed8f677c0453acf74021df4a6c565efebf0a32eaabf0f97064c) |
| `attestPreflight` FAIL (agent) | [0xbb16…b5fa](https://testnet.monadvision.com/tx/0xbb16ed3226717ca1f2deef6ecb17c0c264e3830e9d9d68aea02ffc2679a0b5fa) | [0x21b8…b339](https://testnet.snowtrace.io/tx/0x21b835c923faab522462ed545d1442fc9450e6d1b9a37d0e111d21400c92b339) |
| `revoke` (principal) | [0x3a9d…3d85](https://testnet.monadvision.com/tx/0x3a9dcbef64046488daf773409915b5b94854b798bd95aee5941cc5c114883d85) | [0x543b…3bbe](https://testnet.snowtrace.io/tx/0x543b13379e7fd9a1ab0294268d7332e671cc9eeee2e8bcabf48d7e13afb93bbe) |

Principal `0xe4ebDEbd84f80bF592ca61C6eA56d10568D23aeA`, agent `0xeb114deDc3883A4300fa0bBC29F5590607c0789E`
(throwaway testnet wallets).

## How it integrates with each chain

The contract is plain Solidity 0.8.28 with no chain-specific precompiles; the same bytecode runs on
both networks. What differs is why each chain matters for this use case.

**Monad.** Mandate is built as a plugin for the MetaMask Agent Wallet (`mm`) CLI, and the on-chain
half lives on Monad testnet. An agent that trades at machine frequency needs a pre-trade
attestation per quote; that is only reasonable on a chain with high throughput and fast blocks.
Measured cost of one `attestPreflight` on Monad testnet: 35,176 gas at 102 gwei = 0.0036 MON.

**Avalanche.** Same contract on the Fuji C-Chain. Sub-second finality means the attestation is
final before the agent's trade would be, so "the agent was told first" is true in wall-clock
order, not just in intent. Measured cost of one `attestPreflight` on Fuji: 30,834 gas at a
160 wei gas price, i.e. effectively free. This build does not use Avalanche L1s, ICM or x402; a
per-principal L1 or x402-metered attestations are natural next steps but are not implemented here.

## What the preflight checks

Seven dimensions, each `pass` / `warn` / `fail` against the mandate:

| Dimension | Mandate field |
|---|---|
| Trade size (USD) | `maxUsdPerTrade` |
| Slippage tolerance | `maxSlippageBps` |
| Price impact | `maxPriceImpactBps` |
| Fee load | `maxFeeBps` |
| Recipient is the wallet itself | `recipientMustBeSelf` |
| Cross-chain route | `allowCrossChain` |
| New ERC-20 approval | `allowNewApproval` |

Plus a worst-case realised loss (slippage to `minDestAmount`) and a note when the trade would
likely trip the wallet's native Guard Mode 2FA. If the on-chain mandate is missing, revoked or
expired, the verdict is forced to `fail`: the agent is not authorised.

## Quick start

Requirements: Node 22.18+, `mm` (`npm i -g @metamask/agent-wallet`), [Foundry](https://getfoundry.sh).

```bash
npm install
npm run relink    # point the local @metamask/agent-wallet at the global mm copy (see below)
npm run build
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
mm plugins install "file:<absolute path to this repo>" --accept-permissions
```

`npm run relink` matters: `npm install` puts a second physical copy of `@metamask/agent-wallet`
in `node_modules`, so the host's `instanceof PluginCommand` check fails with
`PLUGIN_INVALID_BASE`. `relink.cjs` replaces it with a junction to the global copy. Re-run it after
every `npm install`.

Grant a mandate (principal), on either chain:

```bash
cast send 0xf0145a8b57fb97d352f7a650b4c4ae4488951f48 \
  "setMandate(address,(uint64,uint16,uint16,uint16,bool,bool,bool,uint64))" \
  <AGENT> "(100000,100,150,50,true,true,true,0)" \
  --rpc-url https://api.avax-test.network/ext/bc/C/rpc --private-key $PRINCIPAL_KEY
```

Preflight a pending quote against it (agent):

```bash
mm swap quote ...                     # creates a stored quote
mm mandate preflight \
  --registry 0xf0145a8b57fb97d352f7a650b4c4ae4488951f48 \
  --principal <PRINCIPAL> \
  --rpc-url https://testnet-rpc.monad.xyz
```

The output ends with the exact `cast send … attestPreflight(…)` command for the agent to record
the disclosure on-chain. Without `--registry`, preflight falls back to a local `mandate.json`
(see `mandate.example.json`).

Live walkthrough without `mm` (uses synthetic quotes, real chain):

```bash
node scripts/demo-onchain.mjs monad   # or: fuji
```

Needs `contracts/.env` with funded `DEPLOYER_PRIVATE_KEY` (principal) and `AGENT_PRIVATE_KEY`.

## Agent skill

`skills/mandate/SKILL.md` tells an agent to run preflight before every swap, stop on `fail`,
ask the human on `warn`, attest before executing, and never split or reshape a trade to get under
a threshold.

## Tests

```bash
npm test                              # scoring (9) + on-chain integration on a local anvil (8)
git clone --depth 1 https://github.com/foundry-rs/forge-std contracts/lib/forge-std   # once
cd contracts && forge test            # contract (13)
```

The integration test deploys to a local anvil, writes a mandate with `cast`, reads it back through
the plugin, attests with the hashes the plugin produces, and revokes. Its assertions are anchored
to the values written with `cast`, not to the plugin's own conversion code.

## Limitations

- **Reveal, not enforce.** A plugin cannot intercept `mm`'s native commands; an agent can skip
  preflight. The attestation makes skipping *detectable*, not impossible.
- **Attestation signer.** The `mm` server wallet's keys are managed by the host, so it cannot sign
  `attestPreflight`. The demo uses a separate agent EOA; the mandate is keyed to that address.
- **Prices are off-chain inputs.** USD values come from the quote. An attestation proves what the
  agent was shown, not that the price data was correct.
- **Synthetic quotes in the demo.** A live `mm swap quote` needs a funded mainnet wallet; the
  demo scores two fixed fixtures (`test/fixtures.mjs`). Every mandate read and write is real.
- Testnet only. Not audited.

## Pre-existing work and build window

Both hackathons allow a pre-existing foundation if it is disclosed. Timeline:

| Date | Work | Evidence |
|---|---|---|
| 2026-09-03 | Scaffolding cloned from MetaMask's `agent-wallet-plugin-template` (MIT): build config, plugin wiring, a `hello ping` sample and a security-scan workflow. The sample and workflow were removed on 2026-09-26. | `LICENSE` keeps MetaMask's notice |
| 2026-09-03 → 09-14 | `mm mandate preflight` command, 7-dimension scoring (`src/lib/score.ts`), mandate loader (`src/lib/spec.ts`), unit tests, offline demo. | File modification dates; snapshot commit `10d4f25` |
| 2026-09-25 → | `MandateRegistry` contract and tests, on-chain preflight (`src/lib/onchain.ts`), anvil integration test, deployments to Monad testnet and Fuji, live demo, agent skill, this README. | Commits from `b923d94` on |

**Version control started late.** The repository was only put under git on 2026-09-25, so work from
09-03 to 09-14 appears as one snapshot commit instead of its own history. No commit is backdated.

- **Monad Metropolis** (build window 2026-09-01 → 10-13): all of the above falls inside the window;
  the only pre-existing code is the MetaMask template scaffolding.
- **Avalanche Buildathon** (2026-09-14 → 09-30): the preflight plugin predates the window. The
  work done for this event is the on-chain layer: the contract, on-chain preflight, the Fuji
  deployment and the live demo.

## AI disclosure

This project was built with AI coding tools, as both hackathons require to be disclosed:

- **Claude Code** (Anthropic; Claude Opus models, Opus 5.5 for the work from 2026-09-25) wrote most of the code, tests, scripts and
  this README under the author's direction; commits it co-authored carry a `Co-Authored-By` trailer.
- On 2026-09-14 the design was critiqued by several other AI models (a "council" review). That
  review is why Mandate reveals instead of enforcing: an `mm` plugin cannot intercept native
  commands, so an enforcement layer would be bypassable by construction.
- Product thesis, scope, and every go/no-go decision are the author's. Each on-chain claim in this
  README was checked against transaction receipts.

## License

MIT. See `LICENSE`.
