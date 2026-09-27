# Warrant

**A prompt is not suitability.** When an AI agent trades for you, the only thing standing between
"what you meant" and "what it did" is usually a sentence in a system prompt. Warrant turns that
sentence into an on-chain object: a **versioned, revocable, expiring warrant** that a principal
grants to an agent, plus a **preflight** that scores every proposed trade against it and an
**on-chain attestation** that the agent saw that scorecard before it acted.

Warrant **reveals, it does not enforce.** It never custodies funds, never blocks a trade and never
tries to bypass a wallet's own guard rails. What it adds is *verifiability*: after the fact anyone
can check what the agent was allowed to do, and prove it was told the trade was out of bounds.

**Demo video (2:44, live run on Avalanche Fuji):** https://youtu.be/yitnbGgzKOA · **Pitch deck (EN/中文):** [`docs/warrant-pitch.pdf`](docs/warrant-pitch.pdf)

> Renamed from "Mandate" on 2026-09-26 to avoid confusion with an unrelated project of the same
> name. Contract, command and package names changed; nothing else did.

## Why not just Guard Mode?

The MetaMask Agent Wallet already ships a policy layer (Guard Mode). Its policy file expresses three
things: address allow/block lists, allowed chains, and a rolling 24-hour USD outflow limit
(read from `mm wallet policy template`, `@metamask/agent-wallet` 6.2.0). That is a **spend** limit.
It cannot say "never accept more than 1% slippage", "not into a pool this thin", "not if fees eat
0.8% of the trade", or "no new token approvals". Those are **suitability** limits, and four of
Warrant's seven dimensions exist only here.

| Dimension | Guard Mode policy | Warrant |
|---|---|---|
| Trade size | 24h outflow total (partial) | per-trade USD cap |
| Slippage tolerance | — | ✓ |
| Price impact | — | ✓ |
| Fee load | — | ✓ |
| Recipient is self | address allowlist (partial) | ✓ |
| Cross-chain route | allowed chains (partial) | ✓ |
| New ERC-20 approval | — | ✓ |

Warrant is a complement, not a replacement: Guard Mode enforces spend, Warrant reveals suitability
and leaves a public record.

## Who it's for

- **Principals** who let an agent trade (a person, a fund's risk desk, a DAO treasury): they set
  the limits once on-chain and can revoke them at any time without touching the agent.
- **Agent builders** on the MetaMask Agent Wallet: one command before each swap, and an audit trail
  their users can check.
- **Anyone reviewing an agent after the fact**: every attestation is public, so "was the agent told
  this trade was out of bounds?" has a verifiable answer.

## Architecture

```
principal ──setWarrant / revoke──▶ WarrantRegistry (on-chain, per principal→agent, versioned)
                                         │ getWarrant
agent ── mm swap quote ──▶ mm warrant preflight ──▶ scorecard (pass / warn / fail)
                                         │
agent ──attestPreflight(quoteHash, version, verdict, scorecardHash)──▶ PreflightAttested event
```

| Layer | What | Where |
|---|---|---|
| Contract | `WarrantRegistry`: set / revoke / read warrants; `attestPreflight` emits an event bound to the current warrant version (stale or revoked versions revert) | `contracts/src/WarrantRegistry.sol` |
| Scoring | 7-dimension scorer + worst-case loss, pure functions | `src/lib/score.ts` |
| Chain I/O | read the warrant, canonical scorecard hash, quote hash | `src/lib/onchain.ts` |
| CLI | `mm warrant preflight` plugin command | `src/commands/warrant/preflight.ts` |
| Agent instructions | when to preflight, stop, ask, attest | `skills/warrant/SKILL.md` |
| Live walkthrough | grant → preflight → attest → revoke on a real testnet | `scripts/demo-onchain.mjs` |

**Tech stack:** Solidity 0.8.28 + Foundry 1.8.3 · TypeScript on Node 22+ · viem 2.56 ·
MetaMask Agent Wallet plugin SDK (`@metamask/agent-wallet` 6.2.0, oclif) · Monad testnet ·
Avalanche Fuji C-Chain.

## Deployments

`WarrantRegistry` has the **same address on both chains** (same deployer, same nonce):
`0x37cdFe2a144993dC3145367305fF66E29302E673`

| Chain | Deploy tx | Explorer |
|---|---|---|
| Monad testnet (10143) | `0x62d54a4690013a4a5c2fec2653d7442dfa3741f3bf0845c625eb37911f3d08a8` | [contract](https://testnet.monadvision.com/address/0x37cdFe2a144993dC3145367305fF66E29302E673) |
| Avalanche Fuji C-Chain (43113) | `0xd224000c67d4c0146e70726481582c5a0e8a3e51f5521d0ac2c46a89309c68e9` | [contract](https://testnet.snowtrace.io/address/0x37cdFe2a144993dC3145367305fF66E29302E673) |

Deployment records: `contracts/broadcast/Deploy.s.sol/{10143,43113}/`. The records also contain the
first deployment under the old name (`MandateRegistry`, `0xf0145a8b…1f48`), kept as history.

### Live run (2026-09-26)

`scripts/demo-onchain.mjs` executed on both chains: grant → preflight against the on-chain warrant
→ agent attests a PASS and a FAIL scorecard → principal revokes. Every transaction below returned
`status = success` with one event log, sent to the registry above.

| Step | Monad testnet | Avalanche Fuji |
|---|---|---|
| `setWarrant` (principal) | [0xf864…fbf8](https://testnet.monadvision.com/tx/0xf864dd0ec67595c2ec9a8d37dc3b47eff81f908e2f3bf1926ddbe9589799fbf8) | [0x50a8…df54](https://testnet.snowtrace.io/tx/0x50a8b98edd9cf915439a07447d65cea4487730d7b1146e9100c2057ec50bdf54) |
| `attestPreflight` PASS (agent) | [0x5fc8…9d5e](https://testnet.monadvision.com/tx/0x5fc8fc5be73a3a271b8a2c81c427e0bf46ebc184577f0aa5d58e4cca18519d5e) | [0xc719…cbca](https://testnet.snowtrace.io/tx/0xc719476886416fcaeffd5b71dd83d43a633feeb70c9dfa6e3bda1a233b1cbcba) |
| `attestPreflight` FAIL (agent) | [0x18d4…9a0e](https://testnet.monadvision.com/tx/0x18d47b23caef0c8ce5cb723cb7f85539c484f80714b79e3d5f2d24380bc09a0e) | [0x27a2…bfc9](https://testnet.snowtrace.io/tx/0x27a24f90be45dda3b13a4a88f7e87ebcbe56779b0421b157122de663b266bfc9) |
| `revoke` (principal) | [0xc7db…5921](https://testnet.monadvision.com/tx/0xc7dbd61cf6266707e21c05118e7b80f7dbe014661733d4b2843e902963f55921) | [0x90e7…4400](https://testnet.snowtrace.io/tx/0x90e76b8466de0a01953cd0479424a79b62ada3036a938a0b483444fa637c4400) |

Principal `0xe4ebDEbd84f80bF592ca61C6eA56d10568D23aeA`, agent `0xeb114deDc3883A4300fa0bBC29F5590607c0789E`
(throwaway testnet wallets).

## How it integrates with each chain

The contract is plain Solidity 0.8.28 with no chain-specific precompiles; the same bytecode runs on
both networks. What differs is why each chain matters for this use case.

**Monad.** Warrant is built as a plugin for the MetaMask Agent Wallet (`mm`) CLI, and the on-chain
half lives on Monad testnet. An agent that trades at machine frequency needs a pre-trade
attestation per quote; that is only reasonable on a chain with high throughput and fast blocks.
Measured cost of one `attestPreflight` on Monad testnet: 35,130 gas at 102 gwei = 0.0036 MON.

**Avalanche.** Same contract on the Fuji C-Chain. Sub-second finality means the attestation is
final before the agent's trade would be, so "the agent was told first" is true in wall-clock
order, not just in intent. Measured cost of one `attestPreflight` on Fuji: 30,788 gas at a
160 wei gas price, i.e. effectively free. This build does not use Avalanche L1s, ICM or x402.

## What the preflight checks

Seven dimensions, each `pass` / `warn` / `fail` against the warrant:

| Dimension | Warrant field |
|---|---|
| Trade size (USD) | `maxUsdPerTrade` |
| Slippage tolerance | `maxSlippageBps` |
| Price impact | `maxPriceImpactBps` |
| Fee load | `maxFeeBps` |
| Recipient is the wallet itself | `recipientMustBeSelf` |
| Cross-chain route | `allowCrossChain` |
| New ERC-20 approval | `allowNewApproval` |

Plus a worst-case realised loss (slippage to `minDestAmount`) and a note when the trade would
likely trip the wallet's native Guard Mode 2FA. If the on-chain warrant is missing, revoked or
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

Grant a warrant (principal), on either chain:

```bash
cast send 0x37cdFe2a144993dC3145367305fF66E29302E673 \
  "setWarrant(address,(uint64,uint16,uint16,uint16,bool,bool,bool,uint64))" \
  <AGENT> "(100000,100,150,50,true,true,true,0)" \
  --rpc-url https://api.avax-test.network/ext/bc/C/rpc --private-key $PRINCIPAL_KEY
```

Preflight a pending quote against it (agent):

```bash
mm swap quote ...                     # creates a stored quote
mm warrant preflight \
  --registry 0x37cdFe2a144993dC3145367305fF66E29302E673 \
  --principal <PRINCIPAL> \
  --rpc-url https://testnet-rpc.monad.xyz
```

The output ends with the exact `cast send … attestPreflight(…)` command for the agent to record
the disclosure on-chain. Without `--registry`, preflight falls back to a local `warrant.json`
(see `warrant.example.json`).

Live walkthrough without `mm` (uses synthetic quotes, real chain):

```bash
cp contracts/.env.example contracts/.env   # then put two funded testnet keys in it
node scripts/demo-onchain.mjs monad        # or: fuji
```

## Agent skill

`skills/warrant/SKILL.md` tells an agent to run preflight before every swap, stop on `fail`,
ask the human on `warn`, attest before executing, and never split or reshape a trade to get under
a threshold.

## Tests

```bash
npm test                              # scoring (9) + on-chain integration on a local anvil (8)
git clone --depth 1 https://github.com/foundry-rs/forge-std contracts/lib/forge-std   # once
cd contracts && forge test            # contract (13)
```

The integration test deploys to a local anvil, writes a warrant with `cast`, reads it back through
the plugin, attests with the hashes the plugin produces, and revokes. Its assertions are anchored
to the values written with `cast`, not to the plugin's own conversion code.

## Limitations

- **Reveal, not enforce.** A plugin cannot intercept `mm`'s native commands; an agent can skip
  preflight. The attestation makes skipping *detectable*, not impossible.
- **Attestation signer.** The `mm` server wallet *can* sign `attestPreflight` through
  `mm wallet send-transaction`: tested on Fuji, PASS
  [`0xb828bf71…72c5`](https://subnets-test.avax.network/c-chain/tx/0xb828bf7129e386171a63a94e04bcbc18b687b09197460397972c5da3d73f72c5)
  and FAIL
  [`0xea6abf03…9b03`](https://subnets-test.avax.network/c-chain/tx/0xea6abf0347f7340e69b0c0a10b3821a945d9d6877b3c5c6070410e1cfbfa9b03),
  both sent from the server wallet (~30,800 gas each). Two caveats as of
  mm 6.2.0: Guard Mode asks for email/MFA approval for every transaction on a chain outside the
  wallet's `allowed_chains` (Fuji is not in the default list), and on Monad testnet (10143) the
  send fails before signing because MetaMask's RPC backend answers `Invalid chainId`. The scripted
  demo therefore signs with a separate agent EOA; the warrant is keyed to that address.
- **Prices are off-chain inputs.** USD values come from the quote. An attestation proves what the
  agent was shown, not that the price data was correct.
- **Synthetic quotes in the demo.** A live `mm swap quote` needs a funded mainnet wallet; the
  demo scores two fixed fixtures (`test/fixtures.mjs`). Every warrant read and write is real.
- Testnet only. Not audited.

## Pre-existing work and build window

Both hackathons allow a pre-existing foundation if it is disclosed. Timeline:

| Date | Work | Evidence |
|---|---|---|
| 2026-09-03 | Scaffolding cloned from MetaMask's `agent-wallet-plugin-template` (MIT): build config, plugin wiring, a `hello ping` sample and a security-scan workflow. The sample and workflow were removed on 2026-09-26. | `LICENSE` keeps MetaMask's notice |
| 2026-09-03 → 09-14 | Preflight command, 7-dimension scoring (`src/lib/score.ts`), limits loader (`src/lib/spec.ts`), unit tests, offline demo. | File modification dates; snapshot commit `10d4f25` |
| 2026-09-25 → | Registry contract and tests, on-chain preflight (`src/lib/onchain.ts`), anvil integration test, deployments to Monad testnet and Fuji, live demo, agent skill, this README. | Commits from `b923d94` on |
| 2026-09-26 | Renamed Mandate → Warrant; redeployed as `WarrantRegistry`. | This commit and later |

**Version control started late.** The repository was only put under git on 2026-09-25, so work from
09-03 to 09-14 appears as one snapshot commit instead of its own history. No commit is backdated.

- **Monad Metropolis** (build window 2026-09-01 → 10-13): all of the above falls inside the window;
  the only pre-existing code is the MetaMask template scaffolding.
- **Avalanche Buildathon** (2026-09-14 → 09-30): the preflight plugin predates the window. The
  work done for this event is the on-chain layer: the contract, on-chain preflight, the Fuji
  deployment and the live demo.

## AI disclosure

This project was built with AI coding tools, as both hackathons require to be disclosed:

- **Claude Code** (Anthropic; Claude Opus models, Opus 5.5 for the work from 2026-09-25) wrote most
  of the code, tests, scripts and this README under the author's direction; commits it co-authored
  carry a `Co-Authored-By` trailer.
- The design was critiqued twice by a panel of other AI models ("council" reviews, 2026-09-14 and
  2026-09-26). The first is why Warrant reveals instead of enforcing: an `mm` plugin cannot
  intercept native commands, so an enforcement layer would be bypassable by construction. The
  second surfaced the naming collision and the Guard Mode positioning above.
- Product thesis, scope, and every go/no-go decision are the author's. Each on-chain claim in this
  README was checked against transaction receipts.

## License

MIT. See `LICENSE`.
