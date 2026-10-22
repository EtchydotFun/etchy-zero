# Security

Please report security problems privately to **security@etchy.fun**. Do not open a public
issue for them.

Include what you found, how to reproduce it, and what it could let someone do. We answer
within 48 hours.

This package builds transactions and reads chain data. It never holds keys: every
transaction is signed by the user's own wallet, and the rune-pool program checks every
signature, proof and amount on chain.
