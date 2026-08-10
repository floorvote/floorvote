# Security

## Reporting a vulnerability

If you discover a security vulnerability in FloorVote, please report it to Will at [will@wtadler.com](mailto:will@wtadler.com) rather than opening a public issue.

Please include:

- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix, if you have one

You should get a response within 48 hours.

## Review

Architecture and security have been reviewed and strengthened through a volunteer engagement with [U.S. Digital Response](https://www.usdigitalresponse.org/) (volunteer: [Larry Hitchon](https://github.com/lhitchon)).

## What the app does for you

Every FloorVote deployment ships with:

- **Magic-link sign-in**, so there are no passwords to store, leak, or reset.
- **Security headers**, including a Content Security Policy defined in one place (`shared/securityHeaders.ts`) and asserted by tests so the served headers can't drift from it.
- **Per-route rate limiting** on the endpoints that matter, including sign-in.
- **Cloudflare Turnstile** on public forms, to keep automated traffic off your sign-in route.
- **HTML sanitization** of bill text, which arrives from a third-party API and is never trusted.
- **Tenant isolation.** Each team is a separate Worker with its own database. One team's members, votes, and positions are not reachable from another's, because there is no shared multi-tenant database to get authorization wrong in.
- **Binding-authenticated internal calls.** Tenants and the central service talk over Cloudflare service bindings, and the tenant-facing entrypoint is deny-by-default: only an explicit allowlist of operations is forwarded, and operator-only routes aren't on it. No shared secret travels between them.
- **Self-serve account deletion**, so members can remove their own data.

## What the project does

Every push to the repository runs typecheck, lint, and the full test suite across `api/`, `central/`, and `web/`, plus a [gitleaks](https://github.com/gitleaks/gitleaks) scan that fails the build on a committed secret.

## What you're responsible for

Self-hosting means you own the deployment, so a few things are yours to get right:

- **Keep your secrets out of version control.** Real `wrangler.toml` files are gitignored for this reason; commit only the `*.example.toml` templates.
- **Scope your Cloudflare API tokens narrowly.** The [self-hosting guide](/self-hosting/) explains which runtime tokens are needed and what each one needs access to.
- **Set `TURNSTILE_SECRET_KEY`** if you want the sign-in gate enforced. If it's unset, the gate fails open by design, so local development isn't blocked.
- **Rotate a token immediately** if you suspect it has leaked, and rotate `ADMIN_SECRET` alongside it.
