---
description: "How to report a security vulnerability in FloorVote, what the app and the project protect for you, and what a self-hosting operator stays responsible for."
---

# Security

## Reporting a vulnerability

If you discover a security vulnerability in FloorVote, please report it to Will at [will@wtadler.com](mailto:will@wtadler.com) rather than opening a public issue.

Please include:

- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix, if you have one

## What the app does for you

Every FloorVote deployment ships with:

- **Magic-link sign-in**, so there are no passwords to store, leak, or reset.
- **Security headers**, including a Content Security Policy defined in one place (`shared/securityHeaders.ts`) and asserted by tests so the served headers can't drift from it.
- **Per-route rate limiting** on the endpoints that matter, including sign-in.
- **Optional Cloudflare Turnstile** on the sign-in forms, to keep automated traffic off your sign-in route. It is off until you set it up, as the [Turnstile page](/self-hosting/turnstile) describes.
- **HTML sanitization** of bill text, which arrives from a third-party API and is never trusted.
- **Tenant isolation.** Each team is a separate Worker with its own database. One team's members, votes, and positions are not reachable from another's, because there is no shared multi-tenant database to get authorization wrong in.
- **Binding-authenticated internal calls.** Tenants and the central service talk over Cloudflare service bindings, and the tenant-facing entrypoint is deny-by-default: only an explicit allowlist of operations is forwarded, and operator-only routes aren't on it. No shared secret travels between them.
- **Self-serve account deletion**, so members can remove their own data.
- **Confirmed email changes.** A member's email is their sign-in identity, so a change takes effect only when someone confirms it from the new address, through a single-use link that expires in 24 hours. The old address is told when the change is requested and again when it takes effect, with the new address masked. Taking effect ends the member's other sessions and voids sign-in links already sent to the old address. Each notice has a "This wasn't me" link, good for 7 days and usable once. Its page changes nothing until a button is pressed, and pressing it signs the member out everywhere and emails the instance's owners and admins who asked for the change, to which address, and when. It also cancels the member's own change that is still waiting for confirmation, so it can't be confirmed afterward. A change an admin started is left alone, so a member whose old mailbox someone else holds can still move by asking an admin. It never reverses a change that has already taken effect, because the old mailbox may now belong to someone else. Admins can also ask to change an active member's email from the member list: admins for Standard members, owners for anyone, and never for a superadmin account. It goes through the same confirmation from the new address and the same two notices, and when it takes effect it ends all of the member's sessions. These requests have admin limits of their own, the same numbers as for invites and sign-in links but counted separately from them. It is recorded with the admin as the actor. If the admin has lost the standing to ask for it by then, the change is cancelled instead.

## What the project does

Every push to the repository runs typecheck, lint, and the full test suite across `api/`, `central/`, and `web/`, plus a [gitleaks](https://github.com/gitleaks/gitleaks) scan that fails the build on a committed secret.

## What you're responsible for

Self-hosting means you own the deployment, so a few things are yours to get right:

- **Keep your secrets out of version control.** Real `wrangler.toml` files are gitignored for this reason; commit only the `*.example.toml` templates.
- **Scope your Cloudflare API tokens narrowly.** The [self-hosting guide](/self-hosting/) explains which runtime tokens are needed and what each one needs access to.
- **Set up Turnstile** if you want the sign-in gate enforced. That takes the public sitekey and the `TURNSTILE_SECRET_KEY` secret, and if the secret is unset the gate fails open by design, so local development isn't blocked.
- **Rotate a token immediately** if you suspect it has leaked, and rotate `ADMIN_SECRET` alongside it.
