# Demo video script (3:00)

One take per chain is enough; record Monad for Metropolis and Fuji for the Avalanche Buildathon
(only the chain name and explorer change). Terminal font ≥ 18pt, explorer in a second window.

Before recording:

```bash
npm run build
node test/demo.mjs          # sanity: two scorecards render
```

The live script re-grants the mandate each run, so the version number goes up by one per take.

---

## 0:00–0:30 · The problem

**Screen:** README title and the one-line thesis.

> When an AI agent trades for you, your limits usually live in a system prompt. A prompt is not
> suitability: nobody can check it, nobody can revoke it, and after a bad trade nobody can prove
> the agent was told. Mandate puts the limits on-chain and makes the agent's pre-trade disclosure
> verifiable.

## 0:30–1:00 · Grant

**Screen:** run `node scripts/demo-onchain.mjs monad` (or `fuji`); pause after step 1.
Click the `setMandate` link → explorer shows the `MandateSet` event.

> The principal grants this agent a mandate on-chain: at most $1,000 a trade, 1% slippage,
> 1.5% price impact, 0.5% fees, funds must come back to the same wallet, expires in 30 days.
> It is versioned and revocable.

## 1:00–1:50 · Preflight + attest, clean trade vs risky trade

**Screen:** step 2–3 output. Stay on the two scorecards.

> Before trading, the agent runs preflight. It reads the mandate from chain, not from a file,
> and scores the quote on seven dimensions.
>
> A $250 same-chain swap: every line passes. The agent attests the PASS on-chain.
>
> Now a $4,200 swap with 3% slippage, bridging to Arbitrum, paying out to someone else's address:
> five failures, two warnings, and a $120 worst-case loss. Verdict FAIL. The agent does not
> execute, and it still attests the FAIL, so the refusal is on the record too.

**Screen:** click one `attestPreflight` link → `PreflightAttested` event: principal, agent,
quoteHash, mandate version, verdict, scorecardHash.

## 1:50–2:20 · Revoke

**Screen:** step 4 output.

> The principal revokes. The same clean $250 trade now comes back FAIL: the agent is no longer
> authorised. The mandate version on-chain moved from 1 to 2, and any attestation against the old
> version would revert.

## 2:20–2:45 · Chain integration and honesty

**Screen:** README "How it integrates with each chain" and "Limitations".

> *(Monad take)* An agent trading at machine speed needs one attestation per quote. On Monad
> testnet that costs about 0.0036 MON.
>
> *(Fuji take)* On Avalanche, finality is sub-second, so the attestation is final before the trade
> would be, and on Fuji it costs effectively nothing.
>
> Mandate reveals, it does not enforce. A plugin can't intercept the wallet's native commands, so
> we don't pretend to. What we give you is proof.

## 2:45–3:00 · Close

**Screen:** repo URL and contract address.

> Mandate: suitability as an on-chain object, not a prompt. Contract, plugin, agent skill and
> tests are open source.

---

Numbers quoted above come from the scorecards in `test/fixtures.mjs` and the receipts listed in
the README. If a fixture changes, re-read the numbers from the new output before recording.
