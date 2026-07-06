# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in FloorVote, please report it responsibly.

**Email:** security@example.com (replace with your security contact)

Please include:
- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix, if you have one

We will acknowledge receipt within 48 hours and provide an initial assessment within 5 business days.

## Scope

This policy covers the FloorVote application code in this repository. It does not cover specific deployments, infrastructure, or third-party services.

## Practices

This project follows several security practices:

- **No passwords.** Authentication is magic-link only with SHA-256 token hashing and HTTP-only secure cookies.
- **Secret hygiene.** Secrets live in `.dev.vars` (gitignored) and Cloudflare Worker secrets, never in source. A [gitleaks](https://github.com/gitleaks/gitleaks) pre-commit hook guards against accidental commits.
- **Per-tenant isolation.** Each organization gets its own D1 database, queue, and Worker deployment. There is no shared multi-tenant database.
- **Binding-authenticated RPC.** Tenant-to-central and central-to-tenant communication uses Cloudflare service bindings (named entrypoints), not shared secrets over the public internet.
- **Rate limiting.** Login endpoints are rate-limited per IP via Cloudflare Rate Limiting.
