# Warrant

**A prompt is not suitability.** When an AI agent trades for you, the only thing standing between
"what you meant" and "what it did" is usually a sentence in a system prompt. Warrant turns that
sentence into an on-chain object: a **versioned, revocable, expiring warrant** that a principal
grants to an agent, plus a **preflight** that scores every proposed trade against it and an
**on-chain attestation** that the agent saw that scorecard before it acted.

Warrant **reveals, it does not enforce.** It never custodies funds, never blocks a trade and never
tries to bypass a wallet's own guard rails. What it adds is *verifiability*: after the fact anyone
can check what the agent was allowed to do, and prove it was told the trade was out of bounds.

**Demo videos:** Monad (2:31: real quote, mm-signed attestation, ERC-8004, audit) https://youtu.be/qOab45ZLuJg · Avalanche Fuji (2:44) https://youtu.be/yitnbGgzKOA · **Pitch deck (EN/中文):** [`docs/warrant-pitch.pdf`](docs/warrant-pitch.pdf)

**New for ETH Shenzhen 2026: the agent no longer grades its own homework on price.** Every scorecard
number used to come from the agent's own plugin. `WarrantPriceCheck` re-prices each signed disclosure
on chain with **Chainlink Data Feeds**, and an agent that signs PASS on a quote the oracle puts out of
bounds is recorded as **contradicted**, with an ERC-8004 reputation entry to match. The same check
settles **ERC-8183 jobs** (an agent hired to swap is paid only if what it delivered matches its own
disclosure and the Chainlink-fair price; Warrant's first real swap was settled this way) and answers
**ERC-8004 validation** requests, so an honest agent can carry a credential. All live on Arc mainnet;
see [Chainlink price check](#chainlink-price-check-on-arc-mainnet-2026-10-14),
[ERC-8183 swap job](#erc-8183-swap-job-and-erc-8004-validation-on-arc-mainnet-2026-10-14) and
[what was built for this event](#pre-existing-work-and-build-window).

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

## Related work: ERC-8226 (Regulated Agent Mandate)

[ERC-8226](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8226.md) ("RAMS", Draft, by
Brickken) lets a verified principal delegate scoped, time-bounded, financially capped authority to
an on-chain agent, and has a regulated token check that mandate before an agent-initiated action.
It overlaps with Warrant's first half (principal → agent, revocable, expiring, capped, EIP-712) and
answers a different question:

| | ERC-8226 RAMS | Warrant |
|---|---|---|
| Question | Was this agent authorised to act for this principal on this asset? | Was *this particular trade* suitable, and was the agent told before it acted? |
| Limits | asset address, action type, per-tx and cumulative quantity, validity window | slippage, price impact, fee load, recipient, new approvals, cross-chain route, USD size |
| Where it applies | tokens that implement the RAMS gate (regulated assets) | any swap an `mm` agent is about to make |
| Mode | enforces: the gated token reverts | reveals: signed disclosure, then audit |
| Principal eligibility | `IComplianceProvider` (KYC / investor status) | out of scope |

A RAMS mandate can hold and a trade still be unsuitable (a 3% slippage sale of a bond the agent was
allowed to sell); a Warrant scorecard can pass for an asset the agent was never mandated to touch.
They are complements. `mm warrant preflight --rams <registry>` reads a RAMS mandate into the
scorecard when the trade touches a RAMS-gated asset (see below).

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
| ERC-8226 | `--rams <registry>`: when the sold asset is RAMS-gated, the agent's mandate check becomes a scorecard dimension | `readRamsCheck` in `src/lib/onchain.ts`; vendored reference in `rams/`; `scripts/demo-rams.mjs` |

**Tech stack:** Solidity 0.8.28 + Foundry 1.8.3 · TypeScript on Node 22+ · viem 2.56 ·
MetaMask Agent Wallet plugin SDK (`@metamask/agent-wallet` 6.2.0, oclif) · Arc mainnet · Monad testnet ·
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

### Chainlink price check on Arc mainnet (2026-10-14)

**The gap it closes.** A Warrant disclosure proves the agent *was shown* a scorecard, but every number
on it (price impact, fees, output) came from the agent's own plugin and the quote it was handed. An agent
that skips preflight, runs a modified plugin or is fed a bad quote can sign PASS on anything, and the
chain had no independent way to say otherwise.

**What `WarrantPriceCheck` does** ([`contracts/src/WarrantPriceCheck.sol`](contracts/src/WarrantPriceCheck.sol)):

1. **The terms are bound by the agent's existing signature.** For a checkable disclosure, the
   attestation's `quoteHash` is `keccak256(abi.encode(quoteIdHash, sellToken, buyToken, sellAmount,
   buyAmount))`. A relayer cannot swap in friendlier amounts (`TermsMismatch`), and the agent needs no
   second signature.
2. **Chainlink prices the trade.** `fairOut` reads the sell and buy tokens' USD feeds
   (`latestRoundData`), rejects a non-positive answer (`BadPrice`) or a stale one (`StaleFeed`: an
   unpriceable quote must not be recorded as checked), and converts across token and feed decimals.
3. **The shortfall is compared with the warrant.** `shortfallBps = (fairOut − quotedOut) / fairOut`
   (0 when the quote beats the oracle) against the warrant's cost budget, `maxPriceImpactBps +
   maxFeeBps`, plus a tolerance for oracle lag: a feed only updates when the price moves past its
   deviation threshold, so the tolerance is the sum of both feeds' thresholds (0.5% + 0.5% = 100 bps).
4. **The verdict is checked, not trusted.** Out of bounds and disclosed PASS = **contradicted**. The
   contract only accepts disclosures `WarrantAttestor` already verified (agent signature, active warrant
   version), each once. `checkAndRate` also posts ERC-8004 feedback from the contract itself: tag1
   `warrant-oracle`, tag2 `consistent` (value +1) or `contradicted` (value −1).

The plugin uses the same contract before the agent signs: `mm warrant preflight --price-check <addr>`
adds an eighth dimension, **Chainlink price check**, which fails exactly where the contract would record
a PASS as contradicted and warns inside the tolerance band. An honest agent therefore never gets
contradicted; one that lies, or skips the plugin, does.

| | Address / transaction (Arc mainnet, chain 5042) |
|---|---|
| `WarrantPriceCheck` | [`0xdF3fE689F0a3C74Ce299018cB573870769f04571`](https://explorer.arc.io/address/0xdF3fE689F0a3C74Ce299018cB573870769f04571), deployed in [`0xcc34e3d7…b956`](https://explorer.arc.io/tx/0xcc34e3d71a53601740356e95dc8c9ad2e347df5ab3de95c7c906e25fa629b956) (`contracts/script/DeployPriceCheckArc.s.sol`, 1,258,254 gas), wired to the deployed `WarrantAttestor` and Arc's ERC-8004 registries |
| Chainlink feeds | USDC / USD [`0x84EA90AC…7905`](https://explorer.arc.io/address/0x84EA90AC252Dc437031461836DB5164219147905) for native USDC (18 decimals) · EURC / USD [`0x361b95c1…Bf23`](https://explorer.arc.io/address/0x361b95c10b76Ca3f35C686d423e43A951755Bf23) for EURC `0xbEf5f6d5…21c1` (6 decimals). Both: 8 decimals, 24 h heartbeat, 0.5% deviation threshold; max age set to 25 h |
| Disclosure, relayed and rated | [`0x9c4a0ae8…02be`](https://explorer.arc.io/tx/0x9c4a0ae86adf85640b63ef094146a390334cf5057790634b4ddba69c732902be) (`WarrantReputation.submitAndRate`) |
| Chainlink check, rated | [`0xfcceb21a…4117`](https://explorer.arc.io/tx/0xfcceb21ad86dbada766f40204c00eea4c83d82fa1a1b107879b850bc62a84117) (`WarrantPriceCheck.checkAndRate`) |
| Staged dishonest agent, caught | agentId **2437**, agentWallet `0x8F31FaFc…957B` (throwaway key; [register](https://explorer.arc.io/tx/0x0a6054895b40f8ad9bbe2f064b8198de7468475161ad8b5eea07cf43f9227aae), [bind](https://explorer.arc.io/tx/0xb1ed106bcc07485dcf404bd23db05ce2d6ae91fa36f3863b30b90e7a012181da), [warrant](https://explorer.arc.io/tx/0xe478ee1c238ac11b2970046cb20c0aa8ecc6b3a7df91917a7ccdae11ad8f497e)); PASS relayed [`0xd6f22c09…b8af`](https://explorer.arc.io/tx/0xd6f22c09904d09c91bea914efdf5a438f278baaad71411af3cbbb50cd79eb8af); **contradicted** [`0xbde80bd4…8f4d`](https://explorer.arc.io/tx/0xbde80bd4ef702fd7bb6ad3d3d7df63d22bcc7a92cfe90f8971dde4503bb98f4d) (`scripts/stage-liar-arc.mjs`) |

**The live run.** A real `mm swap quote` on Arc (0.5 USDC → EURC via Uniswap, quote `0xc700a574…1a29`)
went through `mm warrant preflight --registry … --attestor … --price-check 0xdF3f…4571`. Chainlink
priced 0.5 USDC at **448,542** EURC base units; the quote offered **449,499**, so the price check passed
(0 bps shortfall). The verdict was still **FAIL**, on fee load (gas was 199 bps of a $0.50 trade against
a 50 bps limit), exactly as on 2026-10-05. The `mm` server wallet signed the FAIL disclosure
(`quoteHash` = the terms hash `0xd8d15a0f…2b40`), and two relayed transactions recorded it, rated it
`warrant-preflight / fail`, and had `WarrantPriceCheck` re-price it: `PriceChecked` logged fairOut
448,542, quotedOut 449,499, shortfall 0, budget 200, out of bounds false, contradicted false. ERC-8004
`getSummary(1419, [WarrantPriceCheck], "warrant-oracle", "consistent")` now returns 1. No swap was
executed.

**The case it exists for, on a fork.** `node scripts/demo-pricecheck.mjs` forks Arc mainnet and uses
the contracts and live feeds deployed there. Two staged agents (throwaway keys, fork only) get an
ERC-8004 identity and the same warrant, and both face the same bad quote, 5% below the Chainlink-fair
output:

```
  fair 448542 vs quoted 426114 EURC base units
  preflight: FAIL  Chainlink price check: 500bps below the Chainlink-fair output
▶ honest agent signs FAIL …  PriceChecked: shortfall 500 bps, budget 200 bps, out of bounds true, contradicted false
▶ liar agent signs PASS …    PriceChecked: shortfall 500 bps, budget 200 bps, out of bounds true, contradicted true
  honest agentId 2436: consistent 1, contradicted 0
  liar   agentId 2437: consistent 0, contradicted 1
```

**The same case on Arc mainnet.** `scripts/stage-liar-arc.mjs` staged it for real: a throwaway agent
key, an ERC-8004 identity whose registration says it is a staged dishonest agent (agentId 2437), the
same warrant the `mm` wallet holds, and a staged quote 5% below what Chainlink said 0.5 USDC buys. The
agent signed PASS without running preflight; the disclosure was relayed and rated like any other, and
`checkAndRate` logged fairOut 448,542, quotedOut 426,114, shortfall 500 bps, budget 200 bps, out of
bounds true, **contradicted true**. `getSummary(2437, [WarrantPriceCheck], "warrant-oracle",
"contradicted")` returns count 1, value −1. The dishonest agent and its quote are staged, not observed:
no real trading agent has been caught lying.

#### Chainlink usage (files)

| Chainlink product | Where | Role |
|---|---|---|
| Data Feeds (`AggregatorV3Interface`: `latestRoundData`, `decimals`) | [`contracts/src/WarrantPriceCheck.sol`](contracts/src/WarrantPriceCheck.sol) (`fairOut`, `_price`) | The independent price every PASS is checked against; staleness and non-positive answers revert |
| Same feeds, read through the contract | [`src/lib/onchain.ts`](src/lib/onchain.ts) (`readOracleCheck`), [`src/lib/score.ts`](src/lib/score.ts) (`oracleDimension`), [`src/commands/warrant/preflight.ts`](src/commands/warrant/preflight.ts) (`--price-check`) | The agent sees the oracle's verdict before it signs |
| Feed addresses and parameters | [`contracts/script/DeployPriceCheckArc.s.sol`](contracts/script/DeployPriceCheckArc.s.sol) | Arc mainnet USDC/USD and EURC/USD |
| Tests against the live feeds | [`contracts/test/ArcPriceCheck.fork.t.sol`](contracts/test/ArcPriceCheck.fork.t.sol), [`test/pricecheck.test.mjs`](test/pricecheck.test.mjs) | Fair output recomputed from raw feed answers |

### ERC-8183 swap job and ERC-8004 validation on Arc mainnet (2026-10-14)

Two more places the Chainlink check now reaches, both live on Arc mainnet.

**1. A paid job, settled by chain data (ERC-8183).** [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183)
(Draft) is a job with an escrowed fee and an evaluator who alone decides complete or reject.
[`WarrantSwapJob`](contracts/src/WarrantSwapJob.sol) is both the hook and the evaluator of "swap this for
me" jobs, where the client is also the agent's Warrant principal:

- **Funding** hands the agent the client's capital (the hook pulls it from the client).
- **Submitting** requires the agent to deposit what it actually got and attach the Warrant disclosure it
  signed for the quote: on chain, signed by the job's provider, principal = the job's client, terms = the
  order. No disclosure, no delivery.
- **Settling** is permissionless and decided from chain data only. The agent is paid if the delivered output
  is within the warrant's price-impact + fee budget of the **Chainlink-fair** output (plus the oracle
  tolerance), within the warrant's **slippage** limit of the output it **disclosed** (the disclosure is the
  quote, the deposit is the execution: inside a job, the two are finally linked), it did not disclose FAIL
  and trade anyway, and the warrant is still active at the disclosed version. Otherwise the job is rejected
  and the fee goes back to the client. Either way the delivered tokens go to the client: the capital was
  theirs.

The core is the ERC-8183 reference implementation ([`erc-8183/base-contracts`](https://github.com/erc-8183/base-contracts)
`142e669`, MIT), vendored unmodified in [`contracts/src/vendor/erc8183`](contracts/src/vendor/erc8183) and
deployed behind a proxy with no fees. Its reference `FundTransferHook` returns the same token and amount, so
it cannot express a swap; Arc's own ERC-8183 instance is testnet-only, has no Chainlink feeds there, and only
Circle can whitelist hooks on it.

**The live job.** Job 1: the deployer (principal) hired the `mm` wallet (ERC-8004 agent 1419) to turn 0.5
USDC into EURC for a 0.01 USDC fee. The agent took a real `mm swap quote` (`0xe984b279…b2ea`), ran
`mm warrant preflight --price-check` (PASS on all eight dimensions; Chainlink-fair 448,542 EURC units, quote
448,903), signed the disclosure, **executed the swap** (Warrant's first real trade, via Uniswap on Arc:
448,903 EURC units received, exactly the quote), deposited the output and submitted. `settle` read: shortfall
0 of 450 bps, slippage vs quote 0 of 100 bps, warrant active, no FAIL → **paid**; the fee went to the agent
and the EURC to the client.

For a $0.50 trade, gas alone is 199 bps of the notional on Arc, over warrant v1's 50 bps fee limit, so the
principal re-granted the `mm` wallet's warrant as **v2 with a 300 bps fee limit** before the job (otherwise
preflight says FAIL, as on 2026-10-05, and an honest agent does not trade).

**2. A credential an honest agent can ask for (ERC-8004 validation).** Arc mainnet also hosts ERC-8004's
ValidationRegistry. [`WarrantValidator`](contracts/src/WarrantValidator.sol) answers validation requests for
Warrant disclosures with the same rule as `WarrantPriceCheck`: 100 when the disclosure survives the oracle,
0 for a PASS the oracle puts out of bounds, tag `warrant-oracle`. Requests can only come from the agent's
side, so this is the opt-in, positive half; `checkAndRate` (no consent needed) stays the way to catch a
liar. The registry does not tie a request to the agent whose disclosure it names, so `respond` requires the
identity's `agentWallet` to be the disclosure's signer; without that, anyone could collect a credential for
someone else's honest disclosure (`test_credentialCannotBeBorrowed`). The 2026-10-14 FAIL disclosure of
agent 1419 was validated: response **100**, `getSummary(1419, [WarrantValidator], "warrant-oracle")` = count 1,
average 100.

| | Address / transaction (Arc mainnet) |
|---|---|
| `WarrantValidator` | [`0x38Bc8a02…ce65`](https://explorer.arc.io/address/0x38Bc8a022F41B97A1b7CC7B49EfbBFeFA52fce65), deployed in [`0x0d70f356…7965`](https://explorer.arc.io/tx/0x0d70f3563059e75865e82c67c840eb3a02c48ab50d723e00ca9b8fa5bbfa7965); ERC-8004 ValidationRegistry `0x8004Cc84…AB58` |
| Validation of agent 1419's disclosure `0x0466ddf1…3517` | [request](https://explorer.arc.io/tx/0x539e35499a7c62413a34ea1b643cc53650d59cae3f05d906f6c39e2e0539c1c4), [response 100](https://explorer.arc.io/tx/0xf6efa2637ba37079697eb9151d44b8d8ef433d92a1af64dae0c1df6ecc725973) |
| ERC-8183 core (proxy) | [`0x15faD1B6…efD1`](https://explorer.arc.io/address/0x15faD1B686B6223A0a633483De6572Ae96e3efD1), implementation `0x7F2e54d3…E62B` |
| `WarrantSwapJob` | [`0x63a97f29…9e0f`](https://explorer.arc.io/address/0x63a97f29de3fCD840dDfAB80727d226446cB9e0f) (`contracts/script/DeploySwapJobArc.s.sol`; 6 txs incl. whitelisting, ~6.99M gas) |
| Warrant v2 for the `mm` wallet | [`0xbcac0320…7547`](https://explorer.arc.io/tx/0xbcac03203e69f97026e4b96de8ae4743885655cc7fdc527b338448ac40275547) (fee limit 300 bps) |
| Job 1 | [create](https://explorer.arc.io/tx/0xa5bde16979fa1aea3ce67ab9457ed6289c44308698b8d943ae1b8f970ac2dc85), [order](https://explorer.arc.io/tx/0x5660b75e534c1dd5694f56377cc37031c24e090c24f048a6eb5adacff1914f3c), fee set by the agent [`0xad7f609c…8352`](https://explorer.arc.io/tx/0xad7f609c15b593f36e1f042faad22b63f836c3815c2a1c8792f737e770308352), [fund](https://explorer.arc.io/tx/0xb973812befd6da9a9a4159478fbe14571f8619e620bc0058b13c680b742d8721) |
| The swap | [`0xeca1755b…95fa`](https://explorer.arc.io/tx/0xeca1755bf656938933bd76c02ebc59d083e6ffe34e7c545b4b4e462ec1d995fa) (`mm swap execute`, 0.5 USDC → 448,903 EURC units) |
| Disclosure relayed + Chainlink check | [`0x5cc325f0…d303`](https://explorer.arc.io/tx/0x5cc325f087459a2ba05a44e70d44683b0123484272e0a4b760c3b12ab3edd303), [`0xc26cbf4d…d059`](https://explorer.arc.io/tx/0xc26cbf4dbfbaf18ea73a8b6c8da59e4625008f830540045096d343abdd28d059) |
| Delivery | [approve](https://explorer.arc.io/tx/0x4f9d9cd3144220c813f95cdc92ef3ec3bebfef5a055f488ecbcdbbf43177318e), [submit](https://explorer.arc.io/tx/0x24ef3edf7e5254ce1d10d7e9a83f39745b395a09e7f83dc71d38c7733d162959) (by the `mm` wallet; Guard Mode email approval each) |
| **Settled: paid** | [`0xc5124ed1…43a3`](https://explorer.arc.io/tx/0xc5124ed1fc64e9efa4eaf8bceaf4821b1c1ebaf0c943e9ebea63c5f1f7b343a3) (job Completed; 0.01 USDC to the agent, 448,903 EURC units to the client) |

Driven by `scripts/swap-job-arc.mjs` (the agent's steps are printed as `mm wallet send-transaction`
commands) and `scripts/validate-arc.mjs`. The fork tests use a 6-decimal stand-in for USDC: Arc's ERC-20
USDC moves native balances through Arc protocol precompiles (`0x1800…0000` transfer, `0x1800…0001`
isBlocklisted) that stock Foundry does not implement, and Arc Foundry ships Linux/macOS binaries only. The
real USDC path is what the mainnet job above exercised.

### Arc mainnet (2026-10-05)

The whole stack runs on [Arc](https://docs.arc.io) mainnet (chain 5042, USDC as gas), wired to Arc's own
ERC-8004 v2.0.0 registries, and one real quote went the whole way:

| | Address / transaction |
|---|---|
| `WarrantRegistry` | [`0x80B435fF87276f1302BfCAB4D7202555EeCDe73f`](https://explorer.arc.io/address/0x80B435fF87276f1302BfCAB4D7202555EeCDe73f) |
| `WarrantAttestor` | [`0x33B7B8db2927783dEbb58a589CF5c7B95824fae1`](https://explorer.arc.io/address/0x33B7B8db2927783dEbb58a589CF5c7B95824fae1) |
| `WarrantReputation` | [`0x30906fFDE26d87868B602D34DA96f2C0006e3962`](https://explorer.arc.io/address/0x30906fFDE26d87868B602D34DA96f2C0006e3962) (feedback client of ERC-8004 `ReputationRegistry` `0x8004BAa1…9b63`) |
| Deploy + warrant v1 to the `mm` wallet | `contracts/script/DeployArc.s.sol`; records in `contracts/broadcast/DeployArc.s.sol/5042/` (4 txs, ~1.99M gas) |
| Agent identity | ERC-8004 agentId **1419** on `IdentityRegistry` `0x8004A169…a432`: [register](https://explorer.arc.io/tx/0xa1e2d96c8d22678a527602ac067fbda1c2b828865a12f39380c141973e5a7cc5), [agentWallet := `mm` wallet](https://explorer.arc.io/tx/0x98ee08991dc29a09faca850f6ed2bae9a7abb9c48b4b11ba6113a4a0f1e51240) (signed by the `mm` wallet) |
| Disclosure, relayed and rated | [`0x2123414c…11f6`](https://explorer.arc.io/tx/0x2123414c96c17804a6617192c719a172206baf38ebef2b4406e6e48309c711f6) |

The quote is a real `mm swap quote` on Arc: 0.5 USDC → EURC through Uniswap
(`0xb5a7cebf…9ad3`), price impact 0.08%, slippage 50 bps. Preflight against the warrant on Arc
returned **FAIL on one dimension, fee load: $0.01 (199 bps) against a 50 bps limit**, because on
Arc the gas is paid in the coin being sold and the quote prices it (0.00997 USDC network fee on a
$0.50 trade). The `mm` server wallet signed that scorecard (`mm wallet sign-typed-data`, chain
5042), and one relayed transaction recorded it in `WarrantAttestor` with the quote hash
`0xac086309…b68c` and scorecard hash `0x3b065817…a596` that preflight printed, and posted ERC-8004
feedback `warrant-preflight / fail` for agent 1419. No swap was executed: the agent disclosed FAIL
and stopped. Before deploying, `contracts/test/ArcMainnet.fork.t.sol` ran the same flow on an Arc
mainnet fork against the live registries.

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

### ERC-8226: a RAMS mandate and a Warrant scorecard on the same trades (2026-09-28)

The unmodified ERC-8226 reference implementation is deployed on Monad testnet (addresses and
provenance in [`rams/README.md`](rams/README.md)); its ERC-7943 mock asset stands in for a
tokenized bond ("wDBOND"). The principal holds 1,000 wDBOND and grants the agent both a **RAMS
mandate** (`transferFrom` only, ≤100 per trade, ≤250 in total) and a **Warrant** (≤100 bps slippage,
etc.). `scripts/demo-rams.mjs` then preflights three sales with `readRamsCheck`, the same call
`mm warrant preflight --rams` makes, so the RAMS answer is inside the attested scorecard hash:

| Sale | RAMS `canExecute` | Warrant | Attestation | What happened |
|---|---|---|---|---|
| A. 50 wDBOND, 0.5% slippage | `OK` | PASS | [0x9de6…6285](https://testnet.monadvision.com/tx/0x9de6b65eac9d960f34a93466b4a3263655482f46905cc6b303cf61b8593e6285) | agent sold: [0x65e9…a56d](https://testnet.monadvision.com/tx/0x65e90803d98a484c14c98ba185ed7e97ad32fcba77f8fe1b939b01463c08a56d) |
| B. 80 wDBOND, **3%** slippage | `OK` | **FAIL** (slippage) | [0x5385…0bd3](https://testnet.monadvision.com/tx/0x53857706c36de7ee49ce606af96df83fe8f502dc2c32f8498ecd51c562f10bd3) | agent stopped; RAMS alone would have allowed it |
| C. **150** wDBOND, 0.5% slippage | `OVER_TX_CAP` | **FAIL** (mandate) | [0x8a36…3bd5](https://testnet.monadvision.com/tx/0x8a3636f47fe53214ea8ea6fefa6b37a2c598b0f3dbc298743cce081b165e3bd5) | the token itself reverts `MandateBlocked(OVER_TX_CAP)` (checked with `eth_call`) |

Setup transactions: mandate [0xe7d4…7671](https://testnet.monadvision.com/tx/0xe7d47440317d88cf96af4ab1cb7473d7961e4d5075da84a39ad83bd434937671),
warrant v5 [0x845d…5287](https://testnet.monadvision.com/tx/0x845d78e3d61246eca563710d618fdd0de0d542884aaa3876812c8c202c9f5287).
Sale B is the point: a mandate that holds does not make a trade suitable. Limits of this demo: the
quotes are synthetic (no DEX lists wDBOND), the "sale" settles as `transferFrom` to a venue address,
one key plays principal, compliance operator and token admin, and the `--rams` CLI flag has been
exercised through the same library functions but not yet against a real `mm` stored quote of a
RAMS-gated asset. `test/rams.test.mjs` checks on anvil that every RAMS verdict the plugin reports
matches what the gated token does with the same call (accept, `OVER_TX_CAP`, `OVER_CUMULATIVE_CAP`).

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

**Avalanche.** Same contract on the Fuji C-Chain. Snowman consensus fixes the order of accepted
blocks in under a second with no reorgs, so an attestation accepted before the trade stays before
it. Since the Helicon upgrade (ACP-194; scheduled by avalanchego for Fuji on 2026-07-28 and mainnet
on 2026-09-22, both before the Fuji transactions in this README) C-Chain execution is asynchronous:
a block is accepted first, executed after, and its results settled about τ = 5 s later. So order
is final at acceptance, but an agent that waits for the attestation's receipt before trading is
waiting for execution, not acceptance. Measured cost of one `attestPreflight` on Fuji: 30,788 gas at a
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
| Chainlink price check (with `--price-check`) | `maxPriceImpactBps + maxFeeBps`, against Chainlink Data Feeds |

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
npm test                              # scoring (14) + attestation builders (11) + audit (18) + on-chain integration on a local anvil (8) + ERC-8226 on anvil (8) + Chainlink price check, incl. an Arc mainnet fork (6)
git clone --depth 1 https://github.com/foundry-rs/forge-std contracts/lib/forge-std   # once
(cd rams && git clone --depth 1 --branch v5.4.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts && git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std)   # once, for the ERC-8226 test
git clone --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts contracts/lib/openzeppelin-contracts                          # once, for ERC-8183
git clone --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable contracts/lib/openzeppelin-contracts-upgradeable  # once, for ERC-8183
cd contracts && forge test            # 78: WarrantRegistry (13) + WarrantAttestor (14) + WarrantReputation on a Fuji fork (5) + the stack on an Arc fork (1) + WarrantPriceCheck (20) + it on an Arc fork with live Chainlink feeds (3) + WarrantValidator on an Arc fork with the live ValidationRegistry (9) + WarrantSwapJob with the ERC-8183 reference core on an Arc fork (13)
cd ../rams && forge test               # the vendored ERC-8226 reference suite (105), unmodified
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
- **Fee load counts gas only when the quote prices it.** Since 2026-10-05 the network fee is added
  to the fee load when it is paid in the coin being sold (USDC on Arc, the native coin when selling
  it), valued at the quote's own sell-side rate; otherwise it is left out rather than guessed (a
  quote from an empty wallet on Monad carries no network fee). The worst-case loss still covers
  only the fill at `minDestAssetAmount`, not gas.
- **Prices are off-chain inputs, except where Chainlink checks them.** USD values in the scorecard
  come from the quote. With `--price-check`, the quote's output is re-priced on chain against
  Chainlink Data Feeds, with these limits: only tokens the contract has a feed for (on Arc: native
  USDC and EURC); a 100 bps tolerance, so a shortfall inside the feeds' deviation thresholds is not
  flagged; gas paid outside the quote is not in the output, so it is not counted (the fee-load
  dimension covers it); and the check runs only when someone calls it. A disclosure nobody checked is
  visible (no `PriceChecked` event for its digest) but not penalised.
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
  The first real swap was executed on 2026-10-14 inside an ERC-8183 job on Arc mainnet (see
  "ERC-8183 swap job"); outside a job, Warrant still does not execute or match trades.
- **Mainnet, but not audited.** The Arc deployment is mainnet; Monad and Fuji are testnets. None of the
  contracts has been audited. All but one hold no funds (they record warrants and disclosures);
  `WarrantSwapJob` escrows the delivered tokens of a job between submit and settle, and the ERC-8183 core
  escrows the job fee. A job whose agent takes the capital and never submits loses the capital (the fee is
  refunded on expiry), as in the reference design.
- **Static analysis only.** Slither 0.11.6 over `contracts/src` (vendored ERC-8183 and OpenZeppelin
  excluded): 14 results, none exploitable on review. Two `arbitrary-send-erc20` in `WarrantSwapJob`: the
  `from` is the job's client in `afterAction(fund)` and the submitting provider in `_deliver`; the hook is
  callable only by its own ERC-8183 core, which already requires `fund` to come from the client and
  `submit` from the provider. One `reentrancy-no-eth` and three `reentrancy-events`: the external calls go
  to Warrant's own attestor and to the ERC-8004 registries. Four `unused-return` (ignored tuple fields;
  the Chainlink read checks `answer > 0` and staleness), three `timestamp` (expiry and feed age, by design),
  one `missing-zero-check` on a constructor argument. This is not an audit. Reproduce:
  `cd contracts && slither . --filter-paths "lib|vendor|test|script"`.

## Pre-existing work and build window

The hackathons Warrant was entered in allow a pre-existing foundation if it is disclosed. Timeline:

| Date | Work | Evidence |
|---|---|---|
| 2026-09-03 | Scaffolding cloned from MetaMask's `agent-wallet-plugin-template` (MIT): build config, plugin wiring, a `hello ping` sample and a security-scan workflow. The sample and workflow were removed on 2026-09-26. | `LICENSE` keeps MetaMask's notice |
| 2026-09-03 → 09-14 | Preflight command, 7-dimension scoring (`src/lib/score.ts`), limits loader (`src/lib/spec.ts`), unit tests, offline demo. | File modification dates; snapshot commit `10d4f25` |
| 2026-09-25 → | Registry contract and tests, on-chain preflight (`src/lib/onchain.ts`), anvil integration test, deployments to Monad testnet and Fuji, live demo, agent skill, this README. | Commits from `b923d94` on |
| 2026-09-26 | Renamed Mandate → Warrant; redeployed as `WarrantRegistry`. | This commit and later |
| 2026-09-27 → 09-28 | Signed attestations (`WarrantAttestor`), ERC-8004 identity and reputation, audit, real `mm` quotes, ERC-8226 (RAMS) integration. | Commits and deployments listed above |
| 2026-10-05 | Arc mainnet deployment; fee load counts the quote's network fee. | `9e87ccf`, `3ab44f8` |
| 2026-10-14 → | **ETH Shenzhen 2026:** `WarrantPriceCheck` (Chainlink Data Feeds), its unit and Arc-fork tests, `--price-check` in the plugin, `checkAndRate` in the relayer, the Arc mainnet deployment and live run, `scripts/demo-pricecheck.mjs`, `scripts/stage-liar-arc.mjs`, the ETH Shenzhen deck (`docs/warrant-ethsz.pdf`); then `WarrantValidator` (ERC-8004 validation) and `WarrantSwapJob` (ERC-8183, with the reference core vendored), their Arc-fork tests and the live mainnet job with Warrant's first real swap. | Commits from `388053e` on |

**Version control started late.** The repository was only put under git on 2026-09-25, so work from
09-03 to 09-14 appears as one snapshot commit instead of its own history. No commit is backdated.

- **Monad Metropolis** (build window 2026-09-01 → 10-13): all of the above falls inside the window;
  the only pre-existing code is the MetaMask template scaffolding.
- **Avalanche Buildathon** (2026-09-14 → 09-30): the preflight plugin predates the window. The
  work done for this event is the on-chain layer: the contract, on-chain preflight, the Fuji
  deployment and the live demo.
- **ETH Shenzhen 2026** (2026-09-30 → 10-23): Warrant was submitted to earlier hackathons (Monad
  Metropolis, Avalanche Buildathon, Arc Microgrants, BLI Legal Tech Hackathon 2). The increment built
  for this event, listed in the row above: three new contracts (`WarrantPriceCheck`, `WarrantValidator`,
  `WarrantSwapJob`; the ERC-8183 core is vendored, not ours), 45 new contract tests, 6 new plugin tests, the
  `--price-check` dimension, the relayer step, mainnet deployments with an honest live run, a staged
  dishonest agent, a validated disclosure and a settled ERC-8183 job, and a fork demo. Everything else is the earlier work it
  builds on.

## AI disclosure

This project was built with AI coding tools, as the hackathons require to be disclosed:

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
