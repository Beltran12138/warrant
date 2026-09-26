/** Synthetic quotes shared by the offline and on-chain demos. Field semantics: ProposedSwap in src/lib/score.ts. */
export const SELF = "0xA11ce0000000000000000000000000000000dEaD";

export const clean = {
  quoteId: "0x9f…a1",
  walletAddress: SELF,
  recipientAddress: SELF,
  srcChainId: 1,
  destChainId: 1,
  srcSymbol: "USDC",
  destSymbol: "WETH",
  fromUsd: 250,
  toUsd: 249.1,
  slippage: 0.005,
  priceImpact: 0.0021,
  feeUsd: 0.35,
  destAmount: 71_000_000_000_000_000,
  minDestAmount: 70_645_000_000_000_000,
  requiresApproval: false,
};

export const risky = {
  quoteId: "0x3c…7e",
  walletAddress: SELF,
  recipientAddress: "0xBEEF00000000000000000000000000000000C0DE",
  srcChainId: 1,
  destChainId: 42161,
  srcSymbol: "USDC",
  destSymbol: "PEPE",
  fromUsd: 4200,
  toUsd: 4010,
  slippage: 0.03,
  priceImpact: 0.028,
  feeUsd: 33,
  destAmount: 1000,
  minDestAmount: 970,
  requiresApproval: true,
};
