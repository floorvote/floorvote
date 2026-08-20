# How much does it cost?

To run FloorVote, you'll need to make two accounts: Cloudflare and LegiScan. You can realistically expect that running FloorVote will cost you about $5-7/month to start.

## Cloudflare — about $5-$7/month

Cloudflare provides the hosting and email services, and bills for AI usage. The [Cloudflare Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) plan is $5/month and includes a large usage and email allowance — you are unlikely to hit those limits, though a busy deployment with many users may go somewhat over.

### Emails

Your Cloudflare Workers Paid account includes [3,000 emails per month](https://developers.cloudflare.com/email-service/platform/pricing/), and then it's $0.35 per 1,000 emails. You shouldn't need to pay for those extra emails unless you have hundreds of users and daily email updates going out to everybody. Even then, costs should be very manageable.

### AI bill summaries
When a tracked bill gets new text, the bill is sent to an AI model for summarizing, scoring, and tagging according to your team's tags. Cloudflare's [AI Gateway](https://developers.cloudflare.com/ai-gateway/) routes the text to an AI model and Cloudflare bills you for that usage. Your AI cost scales with the number of bills you're summarizing, which is a function of the keywords your team watches, the number of states you cover, and how often the bill text you're tracking changes.

Typical AI usage is pretty cheap: With Google Gemini 2.5 Flash, $10 summarizes about 2,000 bills. You can change the model if you like, but Gemini 2.5 Flash appears to be cost-effective and does a good job with bill formats (HTML and long PDFs).
## LegiScan — free for most, paid for heavy users {#legiscan-free-for-most-paid-for-heavy-users}

LegiScan's API is the source of the bill data itself. Its free "Public" tier allows for 30,000 calls a month. Whether that will be enough for your team depends on the number of bills you track (which is a function of the number of states you want to track and the breadth of the keywords that you set) and the frequency of bill updates that you need (which you can set). A free API account should be enough for a team tracking a handful of states, but a broader deployment may need to pay for [LegiScan's "Pull API,"](https://legiscan.com/pricing) which costs between $1,000/year (for one state) and $6,000/year (for all states). (Congress is considered a single state.)

> [!IMPORTANT]
> LegiScan provides bill data via their API but is not involved with FloorVote. If you sign up for LegiScan, please **do not** reach out to them for support with FloorVote.
