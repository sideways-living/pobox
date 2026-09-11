# Deterministic mail and parcel matching

Mail2Day subjects such as `Mail2Day: PO Box 3020 has mail.` match the active
box number exactly after normalization. Case, repeated whitespace, dotted P.O.,
an optional number sign, and a final full stop/exclamation mark are supported.
One-digit and alphanumeric box numbers are supported. Leading zeroes remain
significant. Duplicate active numbers across locations require review.
An exact Mail2Day subject takes precedence over unrelated numbers in its body.
Generic notices mentioning multiple distinct box numbers require review.

Parcel subjects `Your PO Box item is ready to collect` (case/whitespace and
final punctuation variations included) use the body `Collect from:` field.
HTML is parsed, entities decoded, and table cells/block boundaries preserved.
The first destination line/cell is used, not subsequent address/footer lines.
Markdown table cells and bold markers are supported too.

Locations are compared after case/punctuation/spacing normalization, optional
`Australia Post` prefix removal, and removal of known trailing office labels:
Post Office, Local/Licensed/Licenced Post Office, LPO, GPO, or PO.
There is no substring, proximity, or fuzzy matching. South Melbourne North is
not South Melbourne. Distinct active offices with the same normalized name,
multiple active boxes at a destination, missing records, or conflicting
Collect from fields require review. Even if only one of two same-named offices
has a box, the destination is ambiguous and is not automatically chosen.

Mail sets only the mail flag/time; parcels set only the parcel flag/time.
Both can be waiting simultaneously, while the waiting count remains one box.
Each distinct source notification adds history. Manual parcel resolution keeps
the parcel type. Review messages remain unread until resolved or ignored;
acknowledgement durability and retries are described in
[Gmail processing reliability](gmail-processing-reliability.md).

Fixtures are synthetic, with no customer email content. Regression coverage
includes full HTML/plain-text notifications, punctuation, inactive records,
ambiguity, both arrival orders, and PostgreSQL concurrent flag updates.
Wrapped location names split across multiple cells/lines, arbitrary aliases,
and unsupported notification templates intentionally remain review cases.
