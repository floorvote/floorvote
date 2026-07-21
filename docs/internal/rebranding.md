# Renaming resources (forks / rebranding)

> Moved out of the public docs to keep them focused. Relevant only if you fork FloorVote and want your Workers, D1 databases, and queues named something other than `floorvote-<slug>`.

The docs and scripts name Workers, D1 databases, and queues `floorvote-<slug>` by default. To rebrand — e.g. `acme-<slug>` — set **one** value and every derived name follows: `RESOURCE_PREFIX=acme` for the scripts (`new-instance.sh`, `teardown-instance.sh`, `deploy.sh`; or drop it in a gitignored `scripts/.env.ops`).

Critically, set the **matching** `TENANT_QUEUE_PREFIX=acme` var on the central Worker (`[env.legiscan.vars]`): central resolves each tenant's delivery queue *by name*, so if its prefix doesn't match yours it creates a **phantom queue with no consumer** and the tenant silently receives no bills. Keep `RESOURCE_PREFIX` and central's `TENANT_QUEUE_PREFIX` in lockstep.
