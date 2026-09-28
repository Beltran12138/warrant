# ERC-8226 (RAMS) reference implementation, vendored

`contracts/` and `test/` are copied **unmodified** from the ERC-8226 reference implementation in
[ethereum/ERCs](https://github.com/ethereum/ERCs/tree/15475a13cd3dd0053ec92b97e44ea01e7482f789/assets/erc-8226)
at commit `15475a13cd3dd0053ec92b97e44ea01e7482f789` (2026-08-31). Authors: Brickken (see the ERC
header). The source files carry their own `SPDX-License-Identifier: MIT`. The ERC is a Draft and
its reference implementation says "Under development".

Added here: `foundry.toml`, `remappings.txt` and `script/DeployRams.s.sol` (deploys the unmodified
contracts for the Warrant demo).

```bash
git clone --depth 1 --branch v5.4.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
forge test        # the reference suite: 105 tests
```

Deployed on Monad testnet (10143) by `0xe4ebDEbd84f80bF592ca61C6eA56d10568D23aeA`:

| Contract | Address | Deploy tx |
|---|---|---|
| `ComplianceProvider` | `0xC43b6E7DF15e3a04B52156F2884De95d07a081Aa` | `0x6043fe335d71f1152fe606bcca01b204ba4e936e3f3bddae076f69a1199fd9dc` |
| `AgentMandate` (the RAMS registry) | `0x47ad95a1F151A2432F62ff77DcD8CAE19f61d2ab` | `0x4a6b1bab49df34f31b32dde799cfe5a7741ccb4a2c1268e1943c1917e7ffc395` |
| `RamsGatedURWA20` "Warrant Demo Bond" (wDBOND) | `0x6D7cfE98BE90b318a6456B7f75eF15F34720FaF2` | `0x339b00a36bee53424488b1e68d04fa22f4f89977cecc5d06320805daecee11ea` |
