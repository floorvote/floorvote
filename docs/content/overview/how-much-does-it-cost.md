# How much does it cost?

Running FloorVote means keeping two accounts: Cloudflare and LegiScan.

## Cloudflare — about $5/month

Cloudflare provides the hosting, email, and artificial intelligence billing, all in one bill. The Workers Paid plan is $5/month and includes a large usage allowance — most deployments never come close to it, though a busy deployment with many users may go somewhat over.

AI summarization also runs through Cloudflare, and it's inexpensive: about $10 summarizes roughly 2,000 bills. Your AI cost scales with how much you're actually tracking — the number of keywords your team watches, the number of states you cover, and how often the bill text you're tracking changes.

## LegiScan — free to start

LegiScan is the source of the legislative data itself. Its free tier — 1,000 queries a day, roughly 30,000 a month — is enough to run a national deployment, covering every state at once. A paid tier only becomes worth considering if you're tracking a very high volume of states, keywords, or bill updates.

## The takeaway

Realistically, expect about $5/month to start. See the [Self-hosting](/self-hosting/) guide for how to set both accounts up.
