# Life Ops

**SRE for the people you care about.** Treat your relationships, commitments, and recurring tasks as services with SLOs. When you fall behind, PagerDuty pages you. The same primitives that keep production healthy, applied to the people who put up with your two-nines availability.

Built on Cloudflare Workers + the [Agents SDK](https://developers.cloudflare.com/agents/), with Anthropic Claude for the agent, PagerDuty for actual alerting, and Google Calendar for context-aware paging.

## The pitch

```
Mom is a service.       SLO: call every 14 days.
Plants are a service.   SLO: water every 3 days.
Anniversary is a P1.    SLO: don't miss it. Ever.

If you ignore the page, your sister gets paged. Filial piety has an SLA.
```

A Life Ops agent runs onboarding by chat ("brain-dump what matters"), provisions a real PagerDuty service + escalation policy per item, and runs a sweep every 15 seconds that pages your phone via the PagerDuty mobile app the moment something breaches its SLO.

## What it does

- **Conversational onboarding** — brain-dump people / commitments / chores to the agent; it extracts structured services live as you type
- **Per-service PagerDuty provisioning** — every Life Ops service gets its own PD service, Events API integration, and witty escalation policy (e.g. *"Mom — Reply or Get Reported"*)
- **Real pages on real phones** — uses PD's Events API v2 with rich `custom_details` (cadence, last fulfilled, notes); incidents show up in the actual PagerDuty mobile app
- **Calendar-aware paging** — connects to Google Calendar; defers default-priority pages while you're in meetings, lets `high` priority cut through anyway
- **15-second autonomous sweep** — self-perpetuating delay-based loop that scans every service and decides per-service: page, defer, or skip
- **Bidirectional sync** — webhook subscription keeps state in sync with PagerDuty; ack/resolve from the mobile app updates the UI in real time
- **Focus-driven safety net** — when the tab regains focus, syncs incident state with PD as a backup if webhooks were missed
- **Auto-recurring anchors** — anniversaries roll forward by their cadence on resolve, so they automatically come back next year

## Stack

- **Cloudflare Workers** + **Agents SDK** — Durable Object per user, SQLite-backed state, native scheduling, WebSocket auto-reconnect
- **Anthropic Claude (Haiku 4.5)** via Vercel AI SDK — the conversational agent + multi-step tool flow
- **PagerDuty** — Events API v2 (triggering), REST API (provisioning services / escalation policies / webhook subscriptions), Webhooks v3 (state sync)
- **Google Calendar API** — OAuth access token (read-only `calendar.events.readonly` scope), busy-window detection
- **React + Kumo** — the chat UI and sidebar dashboard

## Project structure

```
src/
  server.ts    # ChatAgent (Durable Object) — tools, sweep loop, webhook handler
  pd.ts        # PagerDuty REST + Events API client
  google.ts    # Google Calendar API client
  app.tsx      # Chat UI + Life Ops sidebar
  client.tsx   # React entry
  styles.css
```

## Quick start

### 1. Install + run

```bash
npm install
npm run dev
```

Opens on http://localhost:5173.

### 2. Required secrets

Add to `.dev.vars`:

```
PAGERDUTY_REST_TOKEN=<General Access REST API key>
PAGERDUTY_USER_EMAIL=<your email on the PagerDuty account>
ANTHROPIC_API_KEY=<your Anthropic API key>
```

To get the PD REST token: PagerDuty UI → **Integrations → Developer Tools → API Access Keys → Create New API Key**. Make sure the read-only checkbox is **off**.

For production, mirror each secret with `npx wrangler secret put NAME`.

### 3. Set up the PagerDuty webhook (after deploy)

After `npm run deploy`, open the deployed app and click **Set up webhook** in the sidebar footer. This calls `POST /webhook_subscriptions` against your PD account, registers the Worker URL as a destination, and stashes the signing secret. Without it, ack/resolve from the PD mobile app won't sync back to the UI.

### 4. Connect Google Calendar (optional)

Click **Connect Google Calendar** in the sidebar, then paste an OAuth access token from Google's [OAuth Playground](https://developers.google.com/oauthplayground/) using scope `https://www.googleapis.com/auth/calendar.events.readonly`. Tokens expire after ~1 hour; for the demo, just paste a fresh one.

When connected, the sweep checks "are you in a meeting right now?" before paging. Default-priority services get deferred until 30min after the meeting ends; services you've toggled to **🔥 High** page through anyway.

## Using it

1. **Open the app**, the agent greets you.
2. **Brain-dump** what matters: *"Mom every 14 days, dentist every 6 months, plants twice a week, anniversary with Eva on Oct 12."*
3. The agent extracts each item, deploys it to PagerDuty, and creates a witty escalation policy. You'll see service cards appear in the left sidebar live.
4. **Click the icon** on a card to force the service due (demo trick — backdates `lastFulfilled` and re-runs the sweep). Watch it either page (calendar free) or defer (calendar busy).
5. **Click the priority badge** on any card to toggle between **🔥 High** (always pages, even during meetings) and **Default** (defers when busy).
6. **Hover a card → click X** in the top-right to delete (also deletes the PD service).

The sidebar footer has a **Sweep** status that ticks live; click to expand and see per-service outcomes from the last sweep.

## Architecture notes

- One `ChatAgent` Durable Object per user; state syncs to all connected clients via the Agents SDK's `setState` primitive
- Cron is minute-granularity, so the sweep uses a self-perpetuating `this.schedule(15, "tickCadence", null)` chain instead — each tick schedules the next, with cleanup logic in `onStart` to handle DO wakes
- PagerDuty webhook deliveries are HMAC-signed; we verify when the secret is present (production), skip with a warning when missing (demo mode)
- All webhook processing happens in `ctx.waitUntil()` so the handler returns 200 immediately and PD doesn't disable the subscription on slow deliveries
- Each Life Ops service stores `pdServiceId`, `pdIntegrationKey`, and `pdEscalationPolicyId` so the bidirectional sync knows which local card a webhook event refers to

## Deploy

```bash
npm run deploy
```

Then open the deployed URL, set up the webhook from the sidebar, and connect Calendar if you want the meeting-aware paging. Messages and Life Ops state both persist in SQLite-backed Durable Object storage; the agent hibernates when idle and the sweep cron wakes it up on schedule.

## License

MIT
