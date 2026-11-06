# Security policy

Cirrus Mail holds people's email, so security reports are taken seriously and handled first.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report privately through GitHub Security Advisories:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.

Or use this link: <https://github.com/jackh54/cirrus-mail/security/advisories/new>

Include as much as you can:

- what the issue is, and what an attacker could do with it
- steps to reproduce, or a proof of concept
- the version or commit you tested
- any suggested fix

## What to expect

- An acknowledgement within a few days.
- An assessment, and a plan for a fix, as soon as the issue is understood.
- Credit in the advisory and release notes, unless you'd rather stay anonymous.

Please give a reasonable amount of time for a fix to be released before disclosing anything publicly.

## Supported versions

Only the latest release on the `main` branch gets security fixes. Upgrade with `git pull && npm run deploy`, or merge upstream into your copy if you used the Deploy to Cloudflare button.

## Scope

In scope: the code in this repository, including the Worker, the web client and the deploy configuration.

Especially interesting:

- authentication, sessions, 2FA and login throttling
- access control between users and mailboxes
- HTML mail sanitizing and sandboxing
- the signed image proxy and signed attachment URLs
- anything that could leak message content

Out of scope: vulnerabilities in Cloudflare's own platform (report those to Cloudflare), and issues that need an already-compromised Cloudflare account or device.
