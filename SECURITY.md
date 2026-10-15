# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) on this repository.
Don't open a public issue for them.

Include what you found, how to reproduce it, and what an attacker could do with it.
You'll get an acknowledgement, and a fix or a decision, as quickly as the problem warrants.

## Scope

In scope: the Worker (`src/`), the CLI (`cli/`), the schema, and the setup guidance in the README,
including any step that would leave a deployment less safe than the README says.

Out of scope: your own Cloudflare account configuration beyond what the README tells you to do,
and the fact that a link is a bearer secret (anyone holding it can open the file; this is by design).

## Supported versions

Only the latest commit on `main` is supported.
