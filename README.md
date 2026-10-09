# Bulk Email Verifier

A product of **Rodexco** — fast, protocol-level email verification that tells you what's actually deliverable, not just what looks right.

## What it does

Checks a list of email addresses and returns a clear status for each:
syntax validity, domain existence, disposable-email detection, and a real
SMTP-level mailbox check — without ever sending an actual email.

## Why it's different

- **You only pay for determined results.** Addresses we genuinely can't
  verify (timeouts, unreachable servers) are returned as `unknown` and
  are **never charged** — most verification tools charge for every row
  regardless of outcome.
- **Blanket-reject detection.** Some mail providers reject every
  unverified address with an identical generic error specifically to
  defeat verification tools. We detect this pattern and report it
  honestly as `unknown` instead of falsely marking a real, working
  address as `invalid`.
- **Catch-all detection.** If a domain accepts mail to any address, we
  flag it as `risky` rather than reporting false confidence that a
  specific address is deliverable.
- **Respectful of mail servers.** Checks are throttled per mail domain,
  so we never hammer a single provider hard enough to get flagged or
  blocked.

## Input

| Field | Description | Default |
|---|---|---|
| `emails` | List of email addresses to verify (or a dataset/KV store reference) | — |
| `smtpTimeoutMs` | Timeout per SMTP connection attempt | 10000 |
| `maxConcurrentPerDomain` | Max simultaneous checks against one mail domain | 2 (max 3) |
| `checkCatchAll` | Detect catch-all domains | true |
| `checkRoleAccounts` | Flag role-based addresses (info@, admin@, etc.) | true |

## Output

One record per address:

```json
{
  "email": "name@example.com",
  "status": "valid",
  "reason": "Mailbox accepted",
  "isDisposable": false,
  "isRoleAccount": false,
  "isCatchAll": false,
  "possibleBlanketReject": false,
  "mxRecordFound": true,
  "checkedAt": "2026-10-03T12:00:00Z"
}
```

Possible `status` values: `valid`, `invalid`, `disposable`, `risky`, `unknown`.

## Notes

- `unknown` is a legitimate, honest outcome — not a failure. It means we
  could not conclusively determine deliverability (server timeout, or a
  provider that uniformly rejects all unverified probes).
- This Actor never sends actual email — verification stops before the
  `DATA` command in every case.
- Pricing applies only to `valid`, `invalid`, `risky`, and `disposable`
  results.

## Support

Built and maintained by Rodexco. For issues or feature requests, reach
out via the Actor's Issues tab on Apify Store.
