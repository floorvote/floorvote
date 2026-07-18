# Architecture

FloorVote uses a central-and-tenant design. One **central** Cloudflare Worker talks to LegiScan, stores every bill and its text, and fans changes out to per-tenant queues. Each **tenant** is a self-contained Worker with its own database, users, votes, and positions, and it never calls LegiScan directly. That way your legislative-API usage stays on a single account no matter how many tenants you run.

```mermaid
flowchart LR
    LS[(LegiScan API)]
    subgraph CENTRAL [Central Worker]
        Cron[Cron<br/>0 * * * *]
        Ingestor[Ingestor<br/>processLsBill]
    end
    CentralDB[("Central D1<br/>bills + children")]
    CentralR2[("Central R2<br/>bill text files")]
    IQ{{"Ingestor Queue"}}
    TQ{{"Per-tenant Queues"}}
    subgraph TENANT [Per-tenant Worker]
        TenantProc[Tenant Consumer<br/>processCentralNotification]
    end
    TenantDB[("Tenant D1<br/>denormalized bill<br/>+ engagement")]
    UI[Bill UI]
    Admin[/Admin routes/]

    LS -->|"getMasterList<br/>getMasterListRaw"| Cron
    Cron -->|"writes change_hash<br/>+ masterlist fields"| CentralDB
    Cron -->|"matched bills"| IQ
    Cron -->|"stubOnly for<br/>monitoring-only changes"| TQ
    IQ --> Ingestor
    Ingestor -->|"getBill"| LS
    Ingestor -->|"writes everything"| CentralDB
    Ingestor -->|"downloads bill text"| CentralR2
    Ingestor -->|"notifyLsTenants"| TQ
    TQ --> TenantProc
    TenantProc -->|"GET /bills/:id<br/>(no API call)"| CentralDB
    TenantProc -->|"upserts row + AI"| TenantDB
    TenantDB --> UI
    Admin -.->|"reprocess, refresh-stubs,<br/>refresh-metadata"| TQ
    Admin -.->|"reingest-bill,<br/>reingest-tenant, etc."| IQ
```

For the full, code-grounded pipeline — the cron passes, the ingestor, deduplication, and queue boundaries — see `docs/internal/sync-pipeline.md` in the repository.
