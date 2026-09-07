# Website buyback estimates

Proposed display contract for the owner's September 7, 2026 request. This document does not replace the authoritative project specification.

Show a small estimated buyback amount below each insured card value. In the pack library, calculate it from the card's insured USD value and the same inventory response's validated pack percentage, rounded to cents. Accept only finite numeric percentages greater than zero and no greater than 100; unavailable rates yield an unavailable estimate.

For the illustrative homepage, match exact NFT IDs to observed pack inventory. Show a range when verified packs have different rates, retain the verification date, and show an unavailable estimate when membership cannot be verified. The source record is `docs/evidence/showcase-buyback-sources.json`.

Keep insured values, estimates and confirmed sale proceeds distinct. Each estimate states that the actual offer may vary. This adds read-only presentation fields; it does not change purchase, sale or payout decisions.

Validation covers provider percentage rejection, cent rounding, missing rates, pack response propagation and the rendered pack and homepage labels.
