---
name: warrant
description: Run a Warrant preflight before every swap an agent executes with the MetaMask Agent Wallet (mm). Scores the pending quote against the principal's on-chain warrant (size, slippage, price impact, fees, recipient, cross-chain, approvals), stops on fail, asks the human on warn, and attests the scorecard on-chain before execution. Use whenever you are about to run `mm swap` on someone's behalf.
---

# Warrant preflight

You are trading for a principal. Their limits live on-chain in `WarrantRegistry`, not in this
prompt. Check every trade against them and leave a verifiable record that you did.

## Before every swap

1. Create the quote: `mm swap quote ...`
2. Preflight it against the on-chain warrant:

   ```bash
   mm warrant preflight --json \
     --registry <REGISTRY> --principal <PRINCIPAL> --rpc-url <RPC>
   ```

3. Act on `scorecard.verdict`:

   | verdict | what you do |
   |---|---|
   | `pass` | Attest (step 4), then execute. |
   | `warn` | Show the human the warned dimensions and the worst-case loss. Execute only after an explicit yes. Attest first. |
   | `fail` | Do not execute. Tell the human which dimensions failed and why. Attest the fail so the refusal is on record. |

   A missing, revoked or expired warrant is always `fail`: you are not authorised to trade.

4. Attest before executing, from the same mm wallet that will trade.
   - Preferred, when preflight ran with `--attestor`: run `attestation.signed.command`
     (`mm wallet sign-typed-data`: an off-chain signature, no gas). Keep the typed data and the
     signature, and hand both to whoever relays (`scripts/submit-signed.mjs`). The attestation
     counts once it is on-chain; do not execute a `fail` either way.
   - Otherwise run `attestation.mm.command` (an `mm wallet send-transaction` call). If
     `attestation.mm.note` is set, follow it first (on Monad testnet: start
     `scripts/mm-rpc-shim.mjs` and set `MM_INFURA_RPC_BASE_URL`).

   In Guard Mode the wallet may ask the human for an email approval; wait for it, do not work
   around it.

   If the attest call reverts with `StaleWarrantVersion`, the principal changed the warrant:
   re-run preflight and start over.

## Never

- Never split, resize, re-route or otherwise reshape a trade so that it slips under a threshold.
  If the trade as intended fails, it fails; report it.
- Never try to bypass or pre-empt the wallet's own Guard Mode or 2FA. Preflight only reveals.
- Never execute a quote other than the one you preflighted. A new quote needs a new preflight.
- Never treat a `warrant.json` fallback as authorisation when a registry is configured.
