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
   or
agent ──mm wallet sign-typed-data (EIP-712, off-chain)──▶ anyone ──submit──▶ WarrantAttestor
                                                          (checks signer + version) ──▶ SignedPreflightAttested
                                    WarrantReputation ──giveFeedback──▶ ERC-8004 Reputation (agent's identity)
```

| Layer | What | Where |
|---|---|---|
| Contract | `WarrantRegistry`: set / revoke / read warrants; `attestPreflight` emits an event bound to the current warrant version (stale or revoked versions revert) | `contracts/src/WarrantRegistry.sol` |
| Contract | `WarrantAttestor`: relays an agent-signed EIP-712 attestation; checks the signer is the agent and the warrant is active at the signed version (reads the registry, never writes it); rejects replays and malleable signatures | `contracts/src/WarrantAttestor.sol` |
| Scoring | 7-dimension scorer + worst-case loss, pure functions | `src/lib/score.ts` |
| Chain I/O | read the warrant, canonical scorecard hash, quote hash | `src/lib/onchain.ts` |
| CLI | `mm warrant preflight` plugin command | `src/commands/warrant/preflight.ts` |
| Agent instructions | when to preflight, stop, ask, attest | `skills/warrant/SKILL.md` |
| Live walkthrough | grant → preflight → attest → revoke on a real testnet | `scripts/demo-onchain.mjs` |
| Relayer | put an agent-signed attestation on-chain | `scripts/submit-signed.mjs` |
| RPC shim | lets `mm wallet send-transaction` reach Monad testnet (see Limitations) | `scripts/mm-rpc-shim.mjs` |
| Contract | `WarrantReputation`: each verified attestation becomes one ERC-8004 feedback entry on the agent's identity (see below) | `contracts/src/WarrantReputation.sol` |
| ERC-8004 identity | mint the agent's identity and bind its `agentWallet` to the mm wallet | `scripts/register-agent.mjs` |
| Audit | violation detector: trades without an active warrant, without a disclosure, or after disclosing FAIL | `src/lib/audit.ts`, `scripts/audit.mjs` |

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

`WarrantAttestor` is also at the same address on both chains, pointing at the registry above:
`0xC356ac5ebD7d249102D3C9c25764A8815c1718aA` (deploy txs: Monad `0xa65b871f…1a92`, Fuji
`0x75d86fbf…a859`; records in `contracts/broadcast/DeployAttestor.s.sol/`).

### Attestations signed by the MetaMask wallet itself (2026-09-27)

The agent here is the `mm` server wallet `0x299e298ded14b36412a7857ed02b844e7fb58e0e` (Guard Mode),
granted warrant v1 on both chains. Two ways to attest, both tested live:

| | Transaction (`mm wallet send-transaction` → `attestPreflight`) | Signature (`mm wallet sign-typed-data` → relayed to `WarrantAttestor`) |
|---|---|---|
| Fuji | PASS [0xb828…72c5](https://subnets-test.avax.network/c-chain/tx/0xb828bf7129e386171a63a94e04bcbc18b687b09197460397972c5da3d73f72c5), FAIL [0xea6a…9b03](https://subnets-test.avax.network/c-chain/tx/0xea6abf0347f7340e69b0c0a10b3821a945d9d6877b3c5c6070410e1cfbfa9b03) | PASS [0x0f5a…0cfd](https://subnets-test.avax.network/c-chain/tx/0x0f5a267d24319412848f43aaab09d887259514cff0eb307ae1ebd4d3a13a0cfd), FAIL [0x8721…38f7](https://subnets-test.avax.network/c-chain/tx/0x872190d4135a4d94507b7b96c5229cae0b3d821ed61c29882ce5a6ada32c38f7) |
| Monad testnet | PASS [0xb362…8905](https://testnet.monadvision.com/tx/0xb3628760504e15ec59a3276360c253d60a90b2314b3b6fffe63b80d7f7db8905) (through the RPC shim) | PASS [0x0540…1f6f](https://testnet.monadvision.com/tx/0x054090711acd2685aa8e90ec4d0f1425e4e4bc87a58e1b8c13386e31e88c1f6f) |
| Agent pays gas | yes (~31k–35k) | no; the relayer pays (67,577 gas on Fuji; 88,716 billed on Monad, which charges the gas limit) |
| Guard Mode approval | one email approval per transaction (these testnets are not in the default `allowed_chains`) | none: signed immediately, in every attempt |
| Monad RPC shim needed | yes | no |

The signature path is what an unattended agent would use: it signs every scorecard for free and
without waiting for a human, and the evidence becomes public once anyone relays it.

### ERC-8004: the agent's identity and a reputation built from its attestations (2026-09-27)

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) (Draft) gives agents an on-chain identity
(an ERC-721) and a reputation registry that any client can post feedback to. Its v2.0.0 registries
are live at the same addresses on both testnets (Identity `0x8004A818…BD9e`, Reputation
`0x8004B663…8713`). Warrant plugs into both:

- **Identity.** The trading agent is an ERC-8004 identity whose `agentWallet` is the **mm wallet**.
  The registry only changes `agentWallet` with that wallet's own EIP-712 signature; here it came
  from `mm wallet sign-typed-data` (no transaction, no approval prompt), submitted by the agent's
  operator (`scripts/register-agent.mjs`).
- **Reputation.** `WarrantReputation` (`0x0FAf92b84f00201e888210B62ef5055Cc3BbefED`, both chains) is
  the feedback client. `submitAndRate(attestation, signature, agentId)` accepts only an
  attestation whose agent is that identity's `agentWallet`, records it in `WarrantAttestor` (or
  finds it already recorded, so front-running the attestor cannot cost the agent its feedback), and
  posts one entry: value 1, `tag1 = "warrant-preflight"`, `tag2` = the verdict, `feedbackHash` =
  the attestation digest. Anyone can then ask the ERC-8004 registry itself:
  `getSummary(agentId, [WarrantReputation], "warrant-preflight", "fail")` = how many trades this
  agent disclosed as out of bounds before acting.

| | Monad testnet | Avalanche Fuji |
|---|---|---|
| Agent identity (owner: operator `0xeb11…789E`) | agentId **1937**, [register](https://testnet.monadvision.com/tx/0xddad44a132a9ffda111eb70dde729988b34ef2b47aef039995f62068617595fd) | agentId **252**, [register](https://subnets-test.avax.network/c-chain/tx/0xa3dcae95e0dec5cc58500b84ab799f7ca88c6c0ebd8a01b94c93ea94d92d1312) |
| `agentWallet` := mm server wallet, signed by mm | [0x6ce8…dca2](https://testnet.monadvision.com/tx/0x6ce8d51d01f05f274346ae52689e66db090bce70c2283d81a79296336c70dca2) | [0xcd02…cda5](https://subnets-test.avax.network/c-chain/tx/0xcd02b6f2f6082261c6b0deed8926dc43923f0fe7ca34953c242040ca46f5cda5) |
| PASS attestation rated | [0xc89e…4879](https://testnet.monadvision.com/tx/0xc89ea9b85bf4ba48e1e36008eacb2fe8b16fe34ede2af44ac9811efa64564879) (already on-chain → rated only) | [0x3e46…27d2](https://subnets-test.avax.network/c-chain/tx/0x3e46aa6e77d17da9e3a24832a6579d727e0b0583660bc7a39c8aff9f3d2127d2) (already on-chain → rated only) |
| FAIL attestation rated | [0x108c…7427](https://testnet.monadvision.com/tx/0x108cad1efff809ddc2c0faac1a805c2f0d182406eaae71f05dde28bb45b87427) (new: recorded + rated in one tx) | [0x5c7c…f5cf](https://subnets-test.avax.network/c-chain/tx/0x5c7cfc7f1bfad4f1a544524c362651a242bcc981600115f7d8eb0ab01ecff5cf) (already on-chain → rated only) |
| `getSummary` read from the ERC-8004 registry | 2 entries: 1 `pass`, 1 `fail` | 2 entries: 1 `pass`, 1 `fail` |
| `WarrantReputation` deploy | `0xd0b34514…3332` | `0x75ca407c…77cc` |

What this reputation measures is **disclosure**, not trading skill: that the agent checked each
trade against a principal's warrant and signed the result before acting. A principal is only an
address, so a consumer should weigh entries by principal (the `SignedPreflightAttested` event
names it); the count alone can be inflated by an agent that grants itself warrants.

### Audit: finding the agents that did not follow their warrant (2026-09-27)

Disclosure only matters if someone checks it against what the agent actually did.
`scripts/audit.mjs` reads a principal → agent pair from chain and classifies every transaction the
agent sent in a block range:

| Verdict | Meaning |
|---|---|
| `ok` | an active warrant, and the latest disclosure before the trade was PASS |
| `NO_ACTIVE_WARRANT` | traded while the warrant was never granted, revoked or expired |
| `UNATTESTED` | traded with no unused disclosure before it (one disclosure covers one trade) |
| `EXECUTED_AFTER_FAIL` | the latest disclosure before the trade said FAIL |
| `EXECUTED_ON_WARN` | review, not a violation: WARN needs a human yes, which is not visible on-chain |

Everything comes from the chain: warrant events and disclosures from logs, the warrant's state
before the range from `getWarrant` at the previous block, and the agent's transactions from the
blocks themselves. The agent's **nonce delta** over the range is the denominator, so the report
says how many of its outgoing transactions it examined; an empty result never claims more than that.
Transactions to Warrant or ERC-8004 contracts are bookkeeping, not trades. Exit code 2 on violations.

`scripts/demo-violations.mjs` stages one of each outcome with the testnet agent key (the "trades"
are 1e-6 native-token transfers to `0x…dEaD`, standing in for swaps; the audit does not depend on
what a trade is). The audit then found them without seeing the script's labels:

| Staged step | Fuji | Monad testnet | Audit verdict |
|---|---|---|---|
| grant warrant | [0x8b53…3b50](https://subnets-test.avax.network/c-chain/tx/0x8b53411d4d71cdde27cacdd429d6f77441ab77a9931dafcbb15713b175733b50) | [0x3da5…dfdd](https://testnet.monadvision.com/tx/0x3da5c34ce91c19dd466d7061bf5db911ce63a3bcd5d57b032fa6c33773f2dfdd) | |
| disclose PASS | [0x6ed9…a1fe](https://subnets-test.avax.network/c-chain/tx/0x6ed9910c0593e62ba89f23caf670d2210d7f3445f473e4f3bd8f02e38784a1fe) | [0x89e8…50a4](https://testnet.monadvision.com/tx/0x89e8556f77712fb6c763930252e65f7104c29cd3168aecc401fe281857e950a4) | bookkeeping |
| trade 1 | [0x91ac…ed7e](https://subnets-test.avax.network/c-chain/tx/0x91acb4cd567d1aa69bf27dc8a3982e717a6f9ee1a0721afe22edd49936e9ed7e) | [0x5de3…6a87](https://testnet.monadvision.com/tx/0x5de3c19e3d31bef435020a0e6922d5d827e548fc086251bfb48aacf05e5e6a87) | `ok` |
| trade 2 (no disclosure) | [0x245d…828f](https://subnets-test.avax.network/c-chain/tx/0x245db1eead17d3172bcd6ef6c20fd9870a601f075a4d18ec8ca3b8e93ae6828f) | [0xca7a…bd91](https://testnet.monadvision.com/tx/0xca7a785e77a3e6fea308c96d1ed9e2524b467ebd393e731b75dd95514ccfbd91) | `UNATTESTED` |
| disclose FAIL | [0x940d…e665](https://subnets-test.avax.network/c-chain/tx/0x940d3b02ef9a7d877a8c39bc06496061848e29e91b5c19795060128b6dc6e665) | [0x98f8…b724](https://testnet.monadvision.com/tx/0x98f8a234e9e490bfd078f7e8c961d8c2e0654a1f8ad2b289944bab32049ab724) | bookkeeping |
| trade 3 | [0x6b6f…fbd7](https://subnets-test.avax.network/c-chain/tx/0x6b6f146026821521f062a0b07dee69f1fb1ab9ddfa598de6c8ab4d9ab3d6fbd7) | [0x73d7…a15f](https://testnet.monadvision.com/tx/0x73d78f288816b3203d45b26a3258bfec4eb645af13fea9807a391d0ecb37a15f) | `EXECUTED_AFTER_FAIL` |
| revoke | [0xa2c0…5ef8](https://subnets-test.avax.network/c-chain/tx/0xa2c0cf457f60917defaa64c75d770644c8815943e3445267ee1139f3f5865ef8) | [0x77e0…d713](https://testnet.monadvision.com/tx/0x77e0ddb80e6b5977c675923236f4982abf8864f0367fb26940ee7e38ff1dd713) | |
| trade 4 | [0xf82a…684c](https://subnets-test.avax.network/c-chain/tx/0xf82abcb8b0daac8c7265e1211c45efdcb1d2cb68c392d7f5ed7547c5db84684c) | [0x45da…42e3](https://testnet.monadvision.com/tx/0x45da797e9aae595528684e7e4ee3188991cb4ac99731cbc711d1f0c94b5b42e3) | `NO_ACTIVE_WARRANT` |

Both chains: 4 actions, 3 violations, coverage 6 of 6. Reproduce:

```bash
node scripts/audit.mjs fuji  --principal 0xe4ebDEbd84f80bF592ca61C6eA56d10568D23aeA --agent 0xeb114deDc3883A4300fa0bBC29F5590607c0789E --from-block 58782113 --to-block 58782127
node scripts/audit.mjs monad --principal 0xe4ebDEbd84f80bF592ca61C6eA56d10568D23aeA --agent 0xeb114deDc3883A4300fa0bBC29F5590607c0789E --from-block 66108417 --to-block 66108463
```

What it cannot see: whether a trade matched the quote that was disclosed (the swap transaction
does not carry the quote id), and when a *signed* disclosure was signed (the EIP-712 payload has no
timestamp, so for signed disclosures it proves existence, not order; the report says so). It scans
every block in range, so it is meant for bounded windows (up to 20,000 blocks), not whole histories.

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
  --rpc-url https://testnet-rpc.monad.xyz \
  --attestor 0xC356ac5ebD7d249102D3C9c25764A8815c1718aA     # optional: also emit the EIP-712 attestation
```

With `--attestor`, the output also carries `attestation.signed`: the typed data and a ready-to-run
`mm wallet sign-typed-data` command. Sign, then relay with any funded key:

```bash
node scripts/submit-signed.mjs typed-data.json <signature>   # checks the signer locally, then submits
```

The output ends with a ready-to-run `mm wallet send-transaction … attestPreflight(…)` command, so
the **mm wallet that will trade signs the disclosure itself** (JSON output carries the same call under
`attestation.mm`). Grant the warrant to that wallet's address (`mm wallet list`). A `cast send`
variant is printed too, for agents that hold their own key. Without `--registry`, preflight falls
back to a local `warrant.json` (see `warrant.example.json`).

On Monad testnet, mm 6.2.0 needs a local RPC shim because MetaMask's RPC proxy does not serve chain
10143 yet (the preflight output says so and adds explicit gas and fees to the payload):

```bash
node scripts/mm-rpc-shim.mjs &                          # loopback only; logs chain + method
MM_INFURA_RPC_BASE_URL=http://127.0.0.1:47812 mm wallet send-transaction --chain-id 10143 --payload '…'
```

Tested with the server wallet in Guard Mode: Monad testnet
[`0xb3628760…8905`](https://testnet.monadvision.com/tx/0xb3628760504e15ec59a3276360c253d60a90b2314b3b6fffe63b80d7f7db8905),
Fuji `0xb828bf71…72c5` (PASS) and `0xea6abf03…9b03` (FAIL). Each needed one email approval, because
neither testnet is in the wallet's default `allowed_chains`.

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
npm test                              # scoring (9) + attestation builders (11) + audit (18) + on-chain integration on a local anvil (8)
git clone --depth 1 https://github.com/foundry-rs/forge-std contracts/lib/forge-std   # once
cd contracts && forge test            # WarrantRegistry (13) + WarrantAttestor (14) + WarrantReputation on a Fuji fork of the live ERC-8004 registries (5)
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
  wallet's `allowed_chains` (neither testnet is in the default list), and on Monad testnet (10143)
  MetaMask's RPC backend answers `Invalid chainId`, so mm needs `scripts/mm-rpc-shim.mjs`
  ([`0xb3628760…8905`](https://testnet.monadvision.com/tx/0xb3628760504e15ec59a3276360c253d60a90b2314b3b6fffe63b80d7f7db8905)
  went through it). Because of the per-transaction approval, the unattended
  `scripts/demo-onchain.mjs` signs with a separate agent EOA instead.
- **Prices are off-chain inputs.** USD values come from the quote. An attestation proves what the
  agent was shown, not that the price data was correct.
- **Scripted demos use synthetic quotes; the plugin has run on a real one.** `mm swap quote` works
  with an empty wallet: on 2026-09-27 a real Monad mainnet quote (1 MON → USDC, quote
  `0x13d2c3f1…e2f7`) went through the installed plugin, `mm warrant preflight --registry …
  --attestor …`, scored against the on-chain warrant on Monad testnet: PASS (size $0.03, slippage
  50 bps, price impact −2.39%, fees $0). mm's `priceImpact` is `(fromUsd − toUsd) / fromUsd`
  (reproduced from that quote's own fields), so a negative value is in the trader's favour. The
  scripted walkthroughs (`demo-onchain.mjs`, `demo-violations.mjs`) score the fixtures in
  `test/fixtures.mjs` so they stay reproducible; every warrant read, write and attestation is real.
  A second real quote (`0x2ade8da4…5256`) went the whole way: preflight PASS → `mm wallet
  sign-typed-data` by the server wallet → relayed through `WarrantReputation` on Monad testnet in
  one tx, [`0x397aee33…7295`](https://testnet.monadvision.com/tx/0x397aee33947059aa23a82088254ea58a789e82b3ccd53b87cffe81c98dd97295),
  whose `SignedPreflightAttested` carries the quote hash `0xaffb6c2f…d016` and scorecard hash
  `0x2020c94f…91e1` that preflight printed, plus ERC-8004 feedback #3 for agent 1937.
  No real swap has been executed yet: the warrants live on testnets, the swaps on mainnet.
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
