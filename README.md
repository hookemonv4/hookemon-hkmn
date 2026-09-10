# Hookemon

Hookemon is a clean-room project for a programmable launch on chain ID `4663`.

## Current product state

The active assisted-launch source is version 0.1.2, requirements revision 76 and architecture revision 11. It supersedes source submission `45ddd161-e5bb-4cb0-ad92-8f4eb044d82e` while retaining the custom Hookemon contracts and native-ETH money path.

The inclusive swap fee is 3.00% of gross native-ETH quote volume on buys and sells: 0.20% Programmable, 0.30% Treasury and 2.50% process. Each stream retains independent cumulative remainders. Programmable's recipient is `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`; Treasury is `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729`.

The production graph comprises the immutable token, hook and permanent liquidity-position custody. Initialization allocates the token to the hook, binds custody and initializes the graph, followed by inventory seeding by the launch authority with exactly zero ETH. The assisted route may split these steps across transactions without changing the authority wallet. Buyers fund the initial market; gas is manually funded separately. No automatic Treasury-to-Operations refill exists.

Current Operations can claim accrued native process liability under the existing six-hour caps and role restrictions. The selected claim-count limit is 24 per six hours. The bot's dynamic USD budget remains separate from the fixed ETH contract caps. See [the revision handoff](decisions/assisted-launch-v012/README.md) for exact configuration, caller order and evidence boundaries.

Local tests and source review do not establish provider admission, deployed-router integration or live readiness. Deployment, signatures, funding and launch are outside this preparation.

## Open facts

Programmable will supply authoritative route namespaces, runtime and binding commitments, CREATE2 deployment bindings, permits and transaction payloads, then verify the complete deployment, seeding and buyer flow. Launch time, optional purchase, live deadlines and wallet nonces remain unset. The selected fee allocation and zero-ETH inventory configuration do not depend on those later choices.

## Source boundary

Only current `product/`, `decisions/`, `architecture/`, `specs/`, `gates/`, and `protocol/` artifacts can become normative for this product. Historical repository content is retained solely for recoverability and technical study.

See [product/SOURCE_BOUNDARY.md](product/SOURCE_BOUNDARY.md) and [decisions/ADR-0022-operations-wallet-money-path.md](decisions/ADR-0022-operations-wallet-money-path.md).

## Security

Do not commit credentials, private keys, seed phrases, signing payloads, or private operator data. A credential exposed in chat or logs is compromised and must be rotated before use.
