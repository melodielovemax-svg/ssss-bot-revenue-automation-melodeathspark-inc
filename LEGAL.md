# LEGAL.md

Not legal advice. Nothing in this repository has been reviewed by a lawyer. This
file records the design constraints that were chosen, so a reviewer can see what
was decided and why, and so nobody discovers the reasoning later.

## What this project is

A storefront selling digital products and services. Payments are settled by a
compliant payment processor. Customers earn loyalty points. Points buy a
percentage discount on a future purchase.

## What this project deliberately is not

| Not | Because |
|---|---|
| A token or coin | Creating or promoting one is a securities question in most jurisdictions, and a token sold for profit is the specific pattern regulators look at. |
| A staking or yield product | Paying returns on deposited balances is how an investment product is defined in most places. |
| A DAO | Governance over a treasury, with members voting on distributions, reads as an investment arrangement regardless of the label. |
| A multi-level or referral payout | Paying people to recruit people is the classic prohibited structure. Affiliate payment for a genuine referral, disclosed, with no recruitment component, is a different thing. |
| Money transmission | The store does not hold, move, or custody customer funds. A processor settles; the store takes instructions and issues entitlements. |
| A reputation system on a public chain | See below. |

## Why the loyalty design is what it is

The loyalty ledger awards points for spending and for contribution. Those points
have exactly one use: a percentage discount.

There is no withdrawal, no transfer between accounts, no conversion to any asset,
no expiry guarantee. `test/loyalty.test.mjs` asserts the withdrawal methods do not
exist on the object, so the constraint is enforced by the code rather than by a
promise in a readme.

**The reason is the liability.** A points scheme that can be redeemed for
something of value — cash, a transferable instrument, another currency — in
exchange for deposits or participation is treated as a security or as money
transmission in a large number of jurisdictions, and both carry registration
obligations, capital requirements, and reporting. A closed loop that only ever
reduces the price of the next purchase is an ordinary customer loyalty programme.

Adding a redemption path is not a small feature. It changes the legal analysis of
the whole system, and it needs a lawyer in every jurisdiction you intend to
serve. That is why it is absent rather than merely unimplemented.

## Why "crypto payments" means processor-settled

The store accepts crypto-denominated prices. Settlement happens at a compliant
processor that performs its own KYC and sanctions screening.

- No private keys are generated, held, or requested.
- No seed phrase is ever entered into this software.
- No unsigned transaction is broadcast.
- No manual "confirm the transfer" step exists in the payment path.

If the processor will not serve a jurisdiction, the correct outcome is that the
store does not operate there. Working around that is a sanctions and AML problem,
not an engineering problem, and it is out of scope for this repository.

## Why reputation is off-chain

The "karma" track — points for completed bounties, accepted reviews, accepted
answers — is stored inside the application.

Publishing that to a public blockchain would mean permanently recording which
account reviewed which submission for which project, and when. That is
information about identified people and their professional relationships,
permanent and publicly linkable, with no mechanism to withdraw it. It is a
privacy problem, and in most jurisdictions a data protection one.

The same points inside the store are meaningful, because that is where they can
be used. Public reputation requires a different design with consent, a deletion
path, and probably a legal basis this project does not have.

## Consumer protection obligations not addressed here

The following are required in most consumer-facing jurisdictions and are **not
implemented**. They are listed so the gap is visible rather than assumed away:

- Clear, prominent disclosure of pricing, subscription terms, and renewal
- A cancellation and refund flow that a customer can complete without contacting
  support
- Automatic renewal with notice before the charge, where subscriptions exist
- Tax-inclusive pricing, or an accurate statement of when tax is added
- Data access, correction, and deletion requests
- Age restrictions and content rating where relevant
- Accessibility requirements for the storefront

## Business entity and licensing

Not addressed. Operating a storefront requires, at minimum and depending on
jurisdiction:

- A registered business entity
- A merchant account with the payment processor, which will require identity
  verification and may restrict categories of product
- Sales tax or VAT registration and filing
- Consumer protection terms in the customer's jurisdiction
- Export and sanctions compliance

None of that is in this repository, and none of it can be inferred from it.

## Third-party claims

No claim is made here that these products are "superior", "best in class", or
that any comparison to another product is favourable. Automated generation of
reviews or testimonials is not implemented and should not be: fabricated reviews
are a consumer fraud matter in most jurisdictions that regulate them.

## Review status

Unreviewed. Before operating anything built on this, a lawyer needs to review at
minimum: the loyalty mechanism, the refund and cancellation policy, tax
treatment, the payment processor's category restrictions, and the privacy
position on stored customer and contributor data.
