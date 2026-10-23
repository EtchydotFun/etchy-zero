# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately to **security@etchy.fun**. Do not open a public issue.

Include a description of the problem, steps to reproduce it, and the impact as you understand it.
We acknowledge every report within 48 hours and keep you updated until it is resolved.

## Scope

This repository contains the TypeScript SDK. The SDK holds no keys: it reads chain data and builds
transactions that the user's own wallet signs. The Etchy Zero programs verify every signature,
Bitcoin proof and amount on chain, so a modified client cannot bypass those checks.

Reports about the programs, the vault canister or Etchy's public API are welcome at the same
address.
