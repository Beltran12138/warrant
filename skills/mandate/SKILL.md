---
name: mandate
description: Run a Mandate preflight before every swap an agent executes with the MetaMask Agent Wallet (mm). Scores the pending quote against the principal's on-chain mandate (size, slippage, price impact, fees, recipient, cross-chain, approvals), stops on fail, asks the human on warn, and attests the scorecard on-chain before execution. Use whenever you are about to run `mm swap` on someone's behalf.
---

# Mandate preflight

You are trading for a principal. Their limits live on-chain in `MandateRegistry`, not in this
prompt. Check every trade against them and leave a verifiable record that you did.

## Before every swap

1. Create the quote: `mm swap quote ...`
2. Preflight it against the on-chain mandate:

   ```bash
   mm mandate preflight --json \
     --registry <REGISTRY> --principal <PRINCIPAL> --rpc-url <RPC>
   ```

3. Act on `scorecard.verdict`:

   | verdict | what you do |
   |---|---|
   | `pass` | Attest (step 4), then execute. |
   | `warn` | Show the human the warned dimensions and the worst-case loss. Execute only after an explicit yes. Attest first. |
   | `fail` | Do not execute. Tell the human which dimensions failed and why. Attest the fail so the refusal is on record. |

   A missing, revoked or expired mandate is always `fail`: you are not authorised to trade.

4. Attest before executing, using the `attestation` object from the JSON output:

   ```bash
   cast send <REGISTRY> "attestPreflight(address,bytes32,uint32,uint8,bytes32)" \
     <principal> <quoteHash> <mandateVersion> <verdict> <scorecardHash> \
     --rpc-url <RPC> --private-key $AGENT_PRIVATE_KEY
   ```

   If the attest call reverts with `StaleMandateVersion`, the principal changed the mandate:
   re-run preflight and start over.

## Never

- Never split, resize, re-route or otherwise reshape a trade so that it slips under a threshold.
  If the trade as intended fails, it fails; report it.
- Never try to bypass or pre-empt the wallet's own Guard Mode or 2FA. Preflight only reveals.
- Never execute a quote other than the one you preflighted. A new quote needs a new preflight.
- Never treat a `mandate.json` fallback as authorisation when a registry is configured.
