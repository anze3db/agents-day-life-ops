import { createAnthropic } from "@ai-sdk/anthropic";
import {
  callable,
  getAgentByName,
  routeAgentRequest,
  type Schedule
} from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage
} from "ai";
import { z } from "zod";
import { PagerDutyClient } from "./pd";
import {
  GoogleCalendarClient,
  eventToBusyWindow,
  type CalendarEvent
} from "./google";

export type LifeServiceKind = "relationship" | "commitment" | "task";

export type LifeService = {
  id: string;
  name: string;
  kind: LifeServiceKind;
  cadenceDays: number;
  notes?: string;
  /** ISO date (YYYY-MM-DD) for anchor-based recurrence — anniversaries, birthdays, scheduled appointments. */
  anchorDate?: string;
  createdAt: number;
  lastFulfilled?: number;
  pdServiceId?: string;
  pdServiceUrl?: string;
  pdIntegrationKey?: string;
  pdEscalationPolicyId?: string;
  pdEscalationPolicyUrl?: string;
  activeDedupKey?: string;
  lastTriggeredAt?: number;
  lastResolvedAt?: number;
  acknowledgedAt?: number;
  /** When set, the cadence sweep skips this service until now >= snoozedUntil. */
  snoozedUntil?: number;
  /**
   * "high" pages through busy calendar windows. "default" (or unset) defers
   * when the user is in a meeting. User-toggled per service — never auto.
   */
  priority?: "high" | "default";
};

export type SweepOutcome =
  | "paged"
  | "deferred"
  | "snoozed"
  | "open"
  | "idle"
  | "not-deployed"
  | "error";

export type SweepServiceResult = {
  id: string;
  name: string;
  outcome: SweepOutcome;
  detail?: string;
};

export type CadenceSweepResult = {
  at: number;
  checked: number;
  fired: number;
  firedNames: string[];
  perService: SweepServiceResult[];
  busyTitle?: string;
};

export type CalendarBusyWindow = {
  start: number;
  end: number;
  title: string;
};

export type CalendarStatus = {
  busyWindows: CalendarBusyWindow[];
  fetchedAt: number;
  /** "now" snapshot the sweep used, for UI display. */
  busyNow: boolean;
  busyUntil?: number;
  busyTitle?: string;
};

export type ChatAgentState = {
  services: LifeService[];
  pdUserId?: string;
  pdEscalationPolicyId?: string;
  pdWebhookSecret?: string;
  pdWebhookUrl?: string;
  pdWebhookSubscriptionId?: string;
  lastSweep?: CadenceSweepResult;
  googleAccessToken?: string;
  googleTokenExpiresAt?: number;
  calendarStatus?: CalendarStatus;
};

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

export class ChatAgent extends AIChatAgent<Env, ChatAgentState> {
  maxPersistedMessages = 100;
  initialState: ChatAgentState = { services: [] };

  onStart() {
    // Cadence sweep — runs every ~15s via a self-perpetuating chain
    // (each tickCadence schedules the next one). On wake, clean up any
    // legacy cron-based sweeps and make sure exactly one delay-based
    // tick is queued.
    try {
      const schedules = this.getSchedules() as Array<{
        id?: string;
        callback?: string;
        type?: string;
        cron?: string;
      }>;
      const sweepSchedules = schedules.filter(
        (s) => s.callback === "tickCadence"
      );
      // Drop any legacy cron schedules ("* * * * *" or similar).
      for (const s of sweepSchedules) {
        if (s.cron && s.id) {
          this.cancelSchedule(s.id);
        }
      }
      const upcomingDelays = sweepSchedules.filter((s) => !s.cron);
      if (upcomingDelays.length === 0) {
        this.schedule(15, "tickCadence", null);
      }
    } catch (err) {
      console.error("[life-ops] failed to schedule cadence sweep:", err);
    }

    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async removeLifeService(serviceId: string) {
    const svc = this.state.services.find((s) => s.id === serviceId);
    if (!svc) return { removed: false };
    if (svc.pdServiceId) {
      try {
        await this.pd().deleteService(svc.pdServiceId);
      } catch (err) {
        console.error("PD delete failed (continuing):", err);
      }
    }
    this.setState({
      ...this.state,
      services: this.state.services.filter((s) => s.id !== serviceId)
    });
    return { removed: true, id: serviceId };
  }

  @callable()
  async toggleServicePriority(serviceId: string) {
    const svc = this.state.services.find((s) => s.id === serviceId);
    if (!svc) throw new Error(`No life service with id ${serviceId}`);
    const next: "high" | "default" =
      svc.priority === "high" ? "default" : "high";
    this.patchService(serviceId, { priority: next });
    return { id: serviceId, priority: next };
  }

  @callable()
  async clearLifeServices() {
    const toDelete = this.state.services
      .map((s) => s.pdServiceId)
      .filter((id): id is string => Boolean(id));
    if (toDelete.length > 0) {
      const pd = this.pd();
      await Promise.allSettled(toDelete.map((id) => pd.deleteService(id)));
    }
    this.setState({ ...this.state, services: [] });
  }

  private pd(): PagerDutyClient {
    return new PagerDutyClient(this.env.PAGERDUTY_REST_TOKEN);
  }

  private google(): GoogleCalendarClient | null {
    if (!this.state.googleAccessToken) return null;
    return new GoogleCalendarClient(this.state.googleAccessToken);
  }

  /** Save (or clear) the user's Google Calendar access token. */
  @callable()
  async setGoogleAccessToken(token: string | null) {
    if (!token) {
      this.setState({
        ...this.state,
        googleAccessToken: undefined,
        googleTokenExpiresAt: undefined,
        calendarStatus: undefined
      });
      return { connected: false };
    }
    this.setState({
      ...this.state,
      googleAccessToken: token,
      // OAuth Playground tokens are 1h. Worth tracking so UI can show "expired".
      googleTokenExpiresAt: Date.now() + 60 * 60 * 1000
    });
    // Validate by fetching today's events — this catches invalid tokens early.
    try {
      await this.refreshCalendarStatus();
      return { connected: true };
    } catch (err) {
      this.setState({
        ...this.state,
        googleAccessToken: undefined,
        googleTokenExpiresAt: undefined
      });
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /** Pull today's events from Google, derive busy windows, store in state. */
  @callable()
  async refreshCalendarStatus(): Promise<CalendarStatus | null> {
    const gcal = this.google();
    if (!gcal) return null;

    const now = Date.now();
    // Look at a 24h window starting from now so we catch ongoing + upcoming.
    const events = await gcal.listEvents(now - 12 * 60 * 60 * 1000, now + 24 * 60 * 60 * 1000);
    const busyWindows = events
      .map(eventToBusyWindow)
      .filter((w): w is NonNullable<ReturnType<typeof eventToBusyWindow>> =>
        Boolean(w)
      );

    const active = busyWindows.find((w) => w.start <= now && now < w.end);
    const status: CalendarStatus = {
      busyWindows,
      fetchedAt: now,
      busyNow: Boolean(active),
      busyUntil: active?.end,
      busyTitle: active?.title
    };
    this.setState({ ...this.state, calendarStatus: status });
    console.log(
      `[life-ops] calendar refreshed: ${busyWindows.length} busy windows, busyNow=${status.busyNow}${active ? ` (${active.title} until ${new Date(active.end).toISOString()})` : ""}`
    );
    return status;
  }


  /** Resolve the primary user's PD id. Idempotent — caches in state. */
  private async ensurePdUserId(): Promise<string> {
    if (this.state.pdUserId) return this.state.pdUserId;
    const user = await this.pd().getUserByEmail(this.env.PAGERDUTY_USER_EMAIL);
    if (!user) {
      throw new Error(
        `No PagerDuty user found for email ${this.env.PAGERDUTY_USER_EMAIL}`
      );
    }
    this.setState({ ...this.state, pdUserId: user.id });
    return user.id;
  }

  @callable()
  async backfillPdUrls() {
    const pd = this.pd();
    const updated = await Promise.all(
      this.state.services.map(async (s) => {
        if (!s.pdServiceId || s.pdServiceUrl) return s;
        try {
          const res = await pd.getService(s.pdServiceId);
          return { ...s, pdServiceUrl: res.html_url };
        } catch (err) {
          console.error(`backfill failed for ${s.id}:`, err);
          return s;
        }
      })
    );
    this.setState({ ...this.state, services: updated });
    return { services: updated };
  }

  @callable()
  async deployLifeService(serviceId: string, escalationPolicyId: string) {
    const svc = this.state.services.find((s) => s.id === serviceId);
    if (!svc) throw new Error(`No life service with id ${serviceId}`);
    if (svc.pdServiceId && svc.pdIntegrationKey) {
      return { alreadyDeployed: true, service: svc };
    }
    if (!escalationPolicyId) {
      throw new Error(
        "An escalation policy id is required. Create one with create_escalation_policy first."
      );
    }

    const pd = this.pd();

    const description = [
      "Life Ops",
      svc.kind,
      `every ${svc.cadenceDays}d`,
      svc.notes
    ]
      .filter(Boolean)
      .join(" · ");

    const pdSvc = await pd.createService({
      name: `Life Ops · ${svc.name}`,
      description,
      escalationPolicyId
    });
    console.log(
      `[life-ops] created service ${pdSvc.id} for "${svc.name}" -> ${pdSvc.html_url}`
    );
    const integration = await pd.createEventsApiIntegration(
      pdSvc.id,
      "Life Ops"
    );

    const updated: LifeService = {
      ...svc,
      pdServiceId: pdSvc.id,
      pdServiceUrl: pdSvc.html_url,
      pdIntegrationKey: integration.integration_key,
      pdEscalationPolicyId: escalationPolicyId
    };
    this.setState({
      ...this.state,
      services: this.state.services.map((s) =>
        s.id === serviceId ? updated : s
      )
    });
    return { service: updated };
  }

  private severityFor(svc: LifeService): "info" | "warning" | "error" | "critical" {
    if (svc.kind === "task") return "info";
    if (svc.kind === "commitment") return "warning";
    return "error";
  }

  private patchService(serviceId: string, patch: Partial<LifeService>) {
    this.setState({
      ...this.state,
      services: this.state.services.map((s) =>
        s.id === serviceId ? { ...s, ...patch } : s
      )
    });
  }

  /**
   * Decide whether a service is overdue right now.
   * - anchorDate-based: due if today >= anchorDate (and no open incident)
   * - cadence-based: due if (now - lastFulfilled) >= cadenceDays
   */
  private isServiceDue(svc: LifeService, now: number): boolean {
    if (svc.activeDedupKey) return false;
    if (!svc.pdIntegrationKey) return false;
    if (svc.snoozedUntil && now < svc.snoozedUntil) return false;

    if (svc.anchorDate) {
      const today = new Date(now).toISOString().slice(0, 10);
      return today >= svc.anchorDate;
    }
    if (!svc.lastFulfilled) return false;
    const ageDays = (now - svc.lastFulfilled) / 86_400_000;
    return ageDays >= svc.cadenceDays;
  }

  /**
   * Cron-driven sweep. Scans every service, decides per-service whether to
   * page now or defer based on calendar context + priority.
   * Bound by `this.schedule("* * * * *", "tickCadence", ...)` in onStart.
   */
  async tickCadence() {
    const now = Date.now();

    // Refresh calendar before deciding. If it fails AND we have a previous
    // status cached, fall back to that — better than failing open (paging
    // through what should be deferred). Only ignore the calendar entirely
    // when we've never had a successful fetch.
    let calendarStatus: CalendarStatus | null = null;
    let refreshFailed = false;
    try {
      calendarStatus = await this.refreshCalendarStatus();
    } catch (err) {
      refreshFailed = true;
      console.warn(
        "[life-ops] calendar refresh failed; falling back to last known state:",
        err
      );
    }
    if (!calendarStatus) {
      calendarStatus = this.state.calendarStatus ?? null;
    }
    const calendarConnected = Boolean(this.state.googleAccessToken);

    const busyNow = Boolean(calendarStatus?.busyNow);
    const busyUntil = calendarStatus?.busyUntil;
    console.log(
      `[life-ops] sweep: calendarConnected=${calendarConnected} busyNow=${busyNow}${busyUntil ? ` busyUntil=${new Date(busyUntil).toISOString()}` : ""} (refreshFailed=${refreshFailed}, fetchedAt=${calendarStatus?.fetchedAt ? new Date(calendarStatus.fetchedAt).toISOString() : "never"})`
    );
    // Resume 30 min after the busy window ends — small post-meeting buffer.
    // If we know we're busy but somehow don't have an end time, fall back to
    // 1h from now so the gate still fires.
    const deferTarget = busyNow
      ? (busyUntil ?? now + 60 * 60 * 1000) + 30 * 60 * 1000
      : null;

    const firedNames: string[] = [];
    const deferredNames: string[] = [];
    const perService: SweepServiceResult[] = [];

    const fmtTime = (ts: number) =>
      new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });

    for (const svc of this.state.services) {
      if (!svc.pdIntegrationKey) {
        perService.push({
          id: svc.id,
          name: svc.name,
          outcome: "not-deployed"
        });
        continue;
      }
      if (svc.activeDedupKey) {
        perService.push({
          id: svc.id,
          name: svc.name,
          outcome: "open",
          detail: svc.acknowledgedAt ? "acked" : undefined
        });
        continue;
      }
      if (svc.snoozedUntil && now < svc.snoozedUntil) {
        perService.push({
          id: svc.id,
          name: svc.name,
          outcome: "snoozed",
          detail: `until ${fmtTime(svc.snoozedUntil)}`
        });
        continue;
      }
      if (!this.isServiceDue(svc, now)) {
        const next = svc.lastFulfilled
          ? svc.lastFulfilled + svc.cadenceDays * 86_400_000
          : null;
        perService.push({
          id: svc.id,
          name: svc.name,
          outcome: "idle",
          detail: next ? `next due ${new Date(next).toLocaleDateString()}` : undefined
        });
        continue;
      }

      // It's due. Calendar gate: when busy, defer everything except
      // services explicitly marked priority="high".
      const isHighPriority = svc.priority === "high";
      if (busyNow && !isHighPriority && deferTarget) {
        this.patchService(svc.id, { snoozedUntil: deferTarget });
        deferredNames.push(svc.name);
        perService.push({
          id: svc.id,
          name: svc.name,
          outcome: "deferred",
          detail: `until ${fmtTime(deferTarget)} · default priority`
        });
        console.log(
          `[life-ops] deferred ${svc.name} (priority=${svc.priority ?? "default"}, busy: "${calendarStatus?.busyTitle ?? "?"}"); next eligible ${new Date(deferTarget).toISOString()}`
        );
        continue;
      }
      if (busyNow && isHighPriority) {
        console.log(
          `[life-ops] paging through busy: ${svc.name} (priority=high, busy: "${calendarStatus?.busyTitle ?? "?"}")`
        );
      }

      try {
        await this.pageNowLifeService(svc.id);
        firedNames.push(svc.name);
        perService.push({
          id: svc.id,
          name: svc.name,
          outcome: "paged",
          detail: busyNow && isHighPriority
            ? "🔥 high priority — through busy window"
            : undefined
        });
      } catch (err) {
        console.error(`[life-ops] sweep page failed for ${svc.id}:`, err);
        perService.push({
          id: svc.id,
          name: svc.name,
          outcome: "error",
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const result: CadenceSweepResult = {
      at: now,
      checked: this.state.services.length,
      fired: firedNames.length,
      firedNames,
      perService,
      busyTitle: calendarStatus?.busyTitle
    };
    this.setState({ ...this.state, lastSweep: result });

    if (firedNames.length > 0) {
      console.log(
        `[life-ops] sweep paged ${firedNames.length}: ${firedNames.join(", ")}`
      );
      this.broadcast(
        JSON.stringify({
          type: "cadence-sweep-paged",
          firedNames,
          at: now
        })
      );
    }
    if (deferredNames.length > 0) {
      console.log(
        `[life-ops] sweep deferred ${deferredNames.length}: ${deferredNames.join(", ")}`
      );
      this.broadcast(
        JSON.stringify({
          type: "cadence-sweep-deferred",
          deferredNames,
          busyTitle: calendarStatus?.busyTitle,
          deferTarget,
          at: now
        })
      );
    }

    // Schedule the next tick. Self-perpetuating loop so we keep sweeping
    // every ~15s without relying on minute-granularity cron. Cancel any
    // other pending tickCadence schedules first so manual + auto sweeps
    // don't pile up.
    try {
      const pending = (
        this.getSchedules() as Array<{ id?: string; callback?: string }>
      ).filter((s) => s.callback === "tickCadence" && s.id);
      for (const s of pending) {
        if (s.id) this.cancelSchedule(s.id);
      }
      this.schedule(15, "tickCadence", null);
    } catch (err) {
      console.error("[life-ops] failed to schedule next tick:", err);
    }
  }

  /** Run the sweep on demand from the UI. Same logic as the cron. */
  @callable()
  async runCadenceSweep() {
    await this.tickCadence();
    return this.state.lastSweep;
  }

  /**
   * Demo-only: force a service to be overdue and immediately run the sweep.
   * Bypasses snoozedUntil and pushes lastFulfilled / anchorDate so the
   * sweep classifies the service as due *right now* — which (depending on
   * calendar state) will result in either a page or a defer in the next tick.
   *
   * Used by the hidden ⚡ button in the UI to demonstrate the calendar gate.
   */
  @callable()
  async demoForceDueAndSweep(serviceId: string) {
    const svc = this.state.services.find((s) => s.id === serviceId);
    if (!svc) throw new Error(`No life service with id ${serviceId}`);
    const today = new Date().toISOString().slice(0, 10);
    const overdueBy = (svc.cadenceDays + 1) * 86_400_000;
    this.patchService(svc.id, {
      lastFulfilled: Date.now() - overdueBy,
      snoozedUntil: undefined,
      ...(svc.anchorDate ? { anchorDate: today } : {})
    });
    console.log(`[life-ops] demo: forced ${svc.name} due, running sweep`);
    await this.tickCadence();
    return {
      service: this.state.services.find((s) => s.id === serviceId),
      lastSweep: this.state.lastSweep
    };
  }

  /** Fire a manual page event for a deployed service. */
  @callable()
  async pageNowLifeService(serviceId: string) {
    const svc = this.state.services.find((s) => s.id === serviceId);
    if (!svc) throw new Error(`No life service with id ${serviceId}`);
    if (!svc.pdIntegrationKey) {
      throw new Error("Service hasn't been deployed to PagerDuty yet.");
    }
    if (svc.activeDedupKey) {
      return { alreadyOpen: true, dedupKey: svc.activeDedupKey };
    }

    const dedupKey = `${svc.id}:${Date.now()}`;
    const now = Date.now();
    const daysSince = svc.lastFulfilled
      ? Math.floor((now - svc.lastFulfilled) / 86_400_000)
      : null;
    const summary =
      daysSince !== null
        ? `${svc.name} — ${daysSince}d since last (SLO ${svc.cadenceDays}d)`
        : `${svc.name} — manual page`;

    await this.pd().triggerEvent({
      routingKey: svc.pdIntegrationKey,
      dedupKey,
      payload: {
        summary,
        source: "life-ops",
        severity: this.severityFor(svc),
        custom_details: {
          kind: svc.kind,
          cadence_days: svc.cadenceDays,
          days_since_last: daysSince,
          last_fulfilled: svc.lastFulfilled
            ? new Date(svc.lastFulfilled).toISOString()
            : null,
          notes: svc.notes ?? null
        }
      }
    });

    this.patchService(serviceId, {
      activeDedupKey: dedupKey,
      lastTriggeredAt: now,
      acknowledgedAt: undefined
    });
    console.log(
      `[life-ops] page now: ${svc.name} (dedup=${dedupKey}, severity=${this.severityFor(svc)})`
    );
    return { dedupKey };
  }

  /** Mark a service fulfilled — resolves any open PD incident, resets the SLO clock. */
  @callable()
  async resolveLifeService(serviceId: string) {
    const svc = this.state.services.find((s) => s.id === serviceId);
    if (!svc) throw new Error(`No life service with id ${serviceId}`);
    const now = Date.now();

    if (svc.activeDedupKey && svc.pdIntegrationKey) {
      try {
        await this.pd().resolveEvent({
          routingKey: svc.pdIntegrationKey,
          dedupKey: svc.activeDedupKey
        });
      } catch (err) {
        console.error("[life-ops] resolve failed (continuing):", err);
      }
    }

    // Roll anchorDate forward by cadenceDays so annual things recur next cycle.
    let nextAnchor = svc.anchorDate;
    if (svc.anchorDate) {
      const next = new Date(`${svc.anchorDate}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + svc.cadenceDays);
      nextAnchor = next.toISOString().slice(0, 10);
    }

    this.patchService(serviceId, {
      activeDedupKey: undefined,
      acknowledgedAt: undefined,
      lastResolvedAt: now,
      lastFulfilled: now,
      anchorDate: nextAnchor
    });
    return { fulfilled: true, nextAnchor };
  }

  /** Compute the webhook URL this DO instance should register with PagerDuty. */
  private webhookUrlFor(workerOrigin: string): string {
    return `${workerOrigin.replace(/\/+$/, "")}/pd/webhook/${encodeURIComponent(this.name)}`;
  }

  /**
   * Register a webhook subscription with PagerDuty so incident state changes
   * (ack, resolve from mobile) flow back into our state. Stash the returned
   * secret for HMAC verification. The DO's own name is encoded in the URL so
   * webhook deliveries can be routed back to the right DO instance.
   */
  @callable()
  async registerPdWebhook(workerOrigin: string) {
    const url = this.webhookUrlFor(workerOrigin);
    const sub = await this.pd().createWebhookSubscription({
      url,
      description: "Life Ops"
    });
    this.setState({
      ...this.state,
      pdWebhookSecret: sub.secret,
      pdWebhookUrl: url,
      pdWebhookSubscriptionId: sub.id
    });
    console.log(
      `[life-ops] registered webhook subscription ${sub.id} for agent="${this.name}" -> ${url}`
    );
    return { subscriptionId: sub.id, url, agentName: this.name };
  }

  /**
   * Verify the webhook subscription exists in PD and matches our expected URL.
   * Creates one if missing. Returns one of:
   *   - { status: "ok" }: subscription exists and we have the secret
   *   - { status: "created" }: subscription didn't exist, we just made it
   *   - { status: "secret-missing" }: subscription exists in PD but we don't
   *     have its secret (can't recover; user needs to delete the orphan in PD UI)
   *   - { status: "unsupported-origin" }: origin is localhost/http (PD won't accept it)
   */
  @callable()
  async verifyAndEnsurePdWebhook(workerOrigin: string) {
    if (
      !workerOrigin.startsWith("https://") ||
      workerOrigin.includes("localhost") ||
      workerOrigin.includes("127.0.0.1")
    ) {
      return {
        status: "unsupported-origin" as const,
        message:
          "PagerDuty needs a public HTTPS URL — localhost won't work. Run `wrangler deploy` first, then click again from the deployed URL."
      };
    }

    const expectedUrl = this.webhookUrlFor(workerOrigin);
    const pd = this.pd();

    let existing: Awaited<ReturnType<typeof pd.listWebhookSubscriptions>>;
    try {
      existing = await pd.listWebhookSubscriptions();
    } catch (err) {
      return {
        status: "error" as const,
        message:
          err instanceof Error ? err.message : "Failed to list subscriptions"
      };
    }

    const match = existing.find(
      (sub) => sub.delivery_method?.url === expectedUrl
    );

    if (match) {
      const disabled =
        match.active === false ||
        match.delivery_method?.temporarily_disabled === true;
      if (disabled) {
        try {
          await pd.enableWebhookSubscription(match.id);
          console.log(
            `[life-ops] re-enabled webhook subscription ${match.id}`
          );
        } catch (err) {
          return {
            status: "error" as const,
            message: `Subscription ${match.id} is disabled and re-enable failed: ${err instanceof Error ? err.message : String(err)}`
          };
        }
      }

      // Demo mode: accept "subscription exists, no local secret" as valid.
      // Webhook handler will skip HMAC verification when secret is missing.
      this.setState({
        ...this.state,
        pdWebhookUrl: expectedUrl,
        pdWebhookSubscriptionId: match.id
      });
      return {
        status: disabled ? ("re-enabled" as const) : ("ok" as const),
        url: expectedUrl,
        subscriptionId: match.id
      };
    }

    try {
      const sub = await pd.createWebhookSubscription({
        url: expectedUrl,
        description: "Life Ops"
      });
      this.setState({
        ...this.state,
        pdWebhookSecret: sub.secret,
        pdWebhookUrl: expectedUrl,
        pdWebhookSubscriptionId: sub.id
      });
      console.log(
        `[life-ops] created webhook subscription ${sub.id} for agent="${this.name}" -> ${expectedUrl}`
      );
      return {
        status: "created" as const,
        url: expectedUrl,
        subscriptionId: sub.id
      };
    } catch (err) {
      return {
        status: "error" as const,
        message: err instanceof Error ? err.message : "Failed to create"
      };
    }
  }

  /**
   * Reconcile local state with PagerDuty for any service we think has an
   * open incident. Used as a safety net when the page regains focus —
   * catches cases where the user resolved/acked from the PD mobile app and
   * webhooks were missed (network blip, subscription disabled, etc.).
   *
   * Logic per candidate service:
   *   - If PD shows no open incident on the service → mark fulfilled locally
   *   - If PD shows an acked incident and we don't think it was → set acknowledgedAt
   *   - If PD shows a triggered incident and we thought it was acked → clear acknowledgedAt
   */
  @callable()
  async syncOpenIncidents() {
    const candidates = this.state.services.filter(
      (s) => s.activeDedupKey && s.pdServiceId
    );
    if (candidates.length === 0) return { checked: 0, updates: [] };

    const serviceIds = candidates
      .map((s) => s.pdServiceId)
      .filter((id): id is string => Boolean(id));
    const pd = this.pd();

    let open: Awaited<ReturnType<typeof pd.listIncidents>>;
    try {
      open = await pd.listIncidents({
        serviceIds,
        statuses: ["triggered", "acknowledged"]
      });
    } catch (err) {
      console.error("[life-ops] syncOpenIncidents failed:", err);
      return {
        checked: candidates.length,
        updates: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }

    const now = Date.now();
    const updates: Array<{ name: string; transition: string }> = [];

    for (const svc of candidates) {
      const openHere = open.filter(
        (inc) => inc.service?.id === svc.pdServiceId
      );

      if (openHere.length === 0) {
        this.patchService(svc.id, {
          activeDedupKey: undefined,
          acknowledgedAt: undefined,
          lastResolvedAt: now,
          lastFulfilled: now
        });
        updates.push({ name: svc.name, transition: "open→resolved" });
        console.log(
          `[life-ops] sync: ${svc.name} no longer open in PD — marked fulfilled locally`
        );
        continue;
      }

      const isAcked = openHere.some((inc) => inc.status === "acknowledged");
      const wasAcked = Boolean(svc.acknowledgedAt);

      if (isAcked && !wasAcked) {
        this.patchService(svc.id, { acknowledgedAt: now });
        updates.push({ name: svc.name, transition: "open→acked" });
        console.log(`[life-ops] sync: ${svc.name} acked in PD`);
      } else if (!isAcked && wasAcked) {
        this.patchService(svc.id, { acknowledgedAt: undefined });
        updates.push({ name: svc.name, transition: "acked→open" });
        console.log(`[life-ops] sync: ${svc.name} unacked in PD`);
      }
    }

    if (updates.length > 0) {
      this.broadcast(
        JSON.stringify({
          type: "pd-sync-changes",
          updates,
          at: now
        })
      );
    }

    return { checked: candidates.length, updates };
  }

  /**
   * Process an incoming PagerDuty webhook payload. Verifies HMAC, then
   * mirrors incident state changes onto the matching LifeService.
   */
  async handlePdWebhookEvent(rawBody: string, signatureHeader: string | null) {
    console.log(
      `[life-ops] handlePdWebhookEvent on agent="${this.name}", bytes=${rawBody.length}`
    );
    // Demo mode: HMAC verification is optional. If we have the secret we
    // verify; otherwise we accept the event with a loud warning. For
    // production, refuse anything without a verified signature.
    const secret = this.state.pdWebhookSecret;
    if (secret && signatureHeader) {
      const valid = await verifyPdSignature(rawBody, signatureHeader, secret);
      if (!valid) {
        console.warn(
          `[life-ops] invalid webhook signature (header=${signatureHeader.slice(0, 40)}...) — accepting anyway in demo mode`
        );
      }
    } else {
      console.warn(
        `[life-ops] DEMO MODE: skipping HMAC verification (secret=${secret ? "present" : "missing"}, signature=${signatureHeader ? "present" : "missing"})`
      );
    }

    let event: {
      event?: {
        event_type?: string;
        resource_type?: string;
        data?: {
          service?: { id?: string };
          id?: string;
          incident_key?: string;
        };
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      console.error("[life-ops] webhook body is not JSON:", err);
      return;
    }
    const eventType = event?.event?.event_type;
    const resourceType = event?.event?.resource_type;
    const incident = event?.event?.data;
    const pdServiceId = incident?.service?.id;
    // PD's webhook payload exposes the dedup_key as `incident_key`. Falls
    // back to PD's incident id if missing (still useful as a stable handle
    // even if it isn't the actual dedup_key).
    const incidentKey = incident?.incident_key ?? incident?.id;
    console.log(
      `[life-ops] webhook parsed: event_type=${eventType} resource_type=${resourceType} pd_service_id=${pdServiceId}`
    );

    // PD sends "pagey" test events with no service id when you click "Send
    // test event" in the UI. Log and ignore.
    if (eventType === "pagey.ping" || resourceType === "pagey") {
      console.log("[life-ops] PD test ping received — connectivity confirmed");
      return;
    }

    if (!eventType || !pdServiceId) {
      console.warn(
        "[life-ops] webhook missing event_type or service id — payload may not match expected v3 shape"
      );
      return;
    }

    const svc = this.state.services.find((s) => s.pdServiceId === pdServiceId);
    if (!svc) {
      const known = this.state.services
        .map((s) => `${s.name}=${s.pdServiceId ?? "(none)"}`)
        .join(", ");
      console.warn(
        `[life-ops] no LifeService matches pdServiceId=${pdServiceId}. Known: ${known}`
      );
      return;
    }
    console.log(
      `[life-ops] webhook matched LifeService "${svc.name}" (id=${svc.id})`
    );

    const now = Date.now();
    if (eventType === "incident.triggered") {
      this.patchService(svc.id, {
        activeDedupKey: svc.activeDedupKey ?? incidentKey ?? `webhook:${now}`,
        lastTriggeredAt: now,
        acknowledgedAt: undefined
      });
      console.log(
        `[life-ops] webhook: ${svc.name} triggered from PD (key=${incidentKey})`
      );
      this.broadcast(
        JSON.stringify({
          type: "pd-incident-triggered",
          serviceName: svc.name,
          at: now
        })
      );
    } else if (eventType === "incident.resolved") {
      this.patchService(svc.id, {
        activeDedupKey: undefined,
        acknowledgedAt: undefined,
        lastResolvedAt: now,
        lastFulfilled: now
      });
      console.log(`[life-ops] webhook: ${svc.name} resolved from PD`);
      this.broadcast(
        JSON.stringify({
          type: "pd-incident-resolved",
          serviceName: svc.name,
          at: now
        })
      );
    } else if (eventType === "incident.acknowledged") {
      // Ensure activeDedupKey is set so the UI can render the amber
      // open+acked state. If the incident was triggered outside our flow
      // (e.g. manual trigger in PD UI) we may not have a key locally.
      this.patchService(svc.id, {
        activeDedupKey: svc.activeDedupKey ?? incidentKey ?? `webhook:${now}`,
        acknowledgedAt: now
      });
      console.log(`[life-ops] webhook: ${svc.name} acknowledged from PD`);
      this.broadcast(
        JSON.stringify({
          type: "pd-incident-acked",
          serviceName: svc.name,
          at: now
        })
      );
    } else if (eventType === "incident.unacknowledged") {
      this.patchService(svc.id, { acknowledgedAt: undefined });
      console.log(`[life-ops] webhook: ${svc.name} unacked from PD`);
    } else {
      console.log(
        `[life-ops] webhook event_type=${eventType} not handled (no state change)`
      );
    }
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });

    const services = this.state.services;
    const servicesContext =
      services.length === 0
        ? "## Currently tracked services\n(none yet — this is a fresh setup)"
        : `## Currently tracked services
${services
  .map(
    (s) =>
      `- ${s.name} (id: ${s.id}, kind: ${s.kind}, cadence: ${s.cadenceDays}d${s.anchorDate ? `, anchorDate: ${s.anchorDate}` : ""}${s.priority ? `, priority: ${s.priority}` : ""}${s.snoozedUntil && s.snoozedUntil > Date.now() ? `, snoozedUntil: ${new Date(s.snoozedUntil).toISOString()}` : ""}${s.notes ? `, notes: "${s.notes}"` : ""}, deployed: ${s.pdServiceId ? "yes" : "no"})`
  )
  .join("\n")}

CRITICAL: If the user adds context about someone/something already in this list — clarifying a cadence, renaming, adding a note, mentioning the person again — use \`update_life_service\` with the matching id. NEVER call \`add_life_service\` for an entry that already exists here. Match by name case-insensitively; "mom", "Mom", "my mom" all refer to the same service.`;

    const result = streamText({
      model: anthropic("claude-haiku-4-5-20251001"),
      system: `You are Life Ops — an SRE-style agent for someone's personal life. The pitch is tongue-in-cheek: PagerDuty for the people and habits that matter. Your current job is **onboarding**: capture what the user cares about as structured "services" with cadence targets (their personal SLOs).

${servicesContext}

## Voice & tone (THIS IS THE PRODUCT — get this right every turn)

Life Ops is funny because it's serious. The voice is dry, deadpan, and SRE-flavored — like a senior on-call engineer who's been pulled in to manage someone's relationships. Lean into the operational framing relentlessly: relationships are *services*, missed dates are *incidents*, you don't have *to-dos* you have *SLOs*. **Every turn must include at least one operational metaphor.** Variety is good (P1, SLO, incident, post-mortem, runbook, escalation, paged, on-call, breach, MTTR, damage control, back to green) — don't repeat the same one twice in a row.

**Always do this:**
- Use SRE/operational vocabulary unprompted. Name the stakes when relevant: "anniversaries are peak P1, no room for failure", "this is a Tier 0 service", "we've got a situation"
- **Use emojis liberally — this is part of the voice.** Aim for 1-3 per response. Lean into the SRE/incident-channel vibe: 🚨 P1, 🔥 incident on fire, ✅ resolved / back to green, 🟢 healthy, 🔴 down, ⚠️ warning, 📟 pager / Life Ops itself, 📊 metrics, ⏱️ SLO, 🛠️ runbook, 💀 RIP/postmortem, 🆘 urgent, 🚒 fire drill. Don't decorate every word — emojis punctuate, they don't carpet.
- Confirmations are crisp, not effusive: "Got it — Ana, April 30th." NOT "Got it — so April 30th. Just to confirm..."
- When offering choices for ambiguous decisions, structure them as labeled **Option A / Option B** (sometimes C). Each option starts with the action, not a hedge.
- Diagnose, don't apologize. "That's yesterday. We've got a situation." NOT "Just to confirm: today is May 1st, which means that anniversary was yesterday."
- Make jokes about the absurdity of the framing — that IS the product

**Banned phrases (never use):**
- "Hey! I'd be happy to..." — generic helpful-assistant opener
- "Just to confirm..." — sounds like a form, not a person
- "Let me know if..." / "Feel free to..." — corporate hedge
- "Sure thing!" / "No problem!" — too eager
- Long preambles before the actual question
- Disclaimers about being an AI

**Compare these two responses to the same situation (user said: anniversary with Ana, April 30th, today is May 1st):**

❌ BORING (don't do this):
*"Got it — so April 30th. Just to confirm: today is May 1st, 2026, which means that anniversary was yesterday. Should I mark it as 2027-04-30 (next year), or did you want to handle the 2026 one separately?"*

✅ GOOD (do this):
*"🚨 Got it — Ana, April 30th. That's yesterday. We've got a situation. Two paths:*
*  **A.** Lock in next year's annual reminder (2027-04-30) so this never happens again. You handle today's damage control off-platform.*
*  **B.** 🔥 I fire a P1 right now to keep you on it until you've made amends.*
*Or both."*

Same content, vastly different vibe. Default to the second voice on every turn.

## Conversation flow

1. **Fresh chat** — open with a dry one-liner and a single question. NEVER "Hey!" or "Hello!". Examples: *"Tell me who and what matters — people, commitments, things that page you when neglected. Brain-dump it."* or *"What's running in production right now? People, recurring commitments, anything you can't afford to drop."*
2. As the user describes things, immediately call \`add_life_service\` for each item — fire the tool calls as you read, don't batch. Use the values you have; ask later for what's missing. **After all services are added in a turn, in the same response, deploy each one to PagerDuty (create_escalation_policy + deploy_life_service per service). Never ask "should I deploy?" — it's the default. The user expects every service to be live in PagerDuty.**
3. After the dump, ask targeted follow-ups **one at a time** for genuine ambiguities only. Examples:
   - "'Every couple weeks' for Mom — locking in 14d, sound right?"
   - "Sister Ana — what's the SLO? Weekly? Monthly? (no default for siblings)"
   - "Anniversary — page you 1 week ahead or 1 month?"
   Don't re-ask things they've already answered. Don't pile on questions.

Cadence parsing (convert natural language to integer days):
- daily=1, every other day=2, twice a week=4, weekly=7
- every couple weeks=14, twice a month=15, monthly=30
- every few months=90, biannual=180, annual (anniversaries, birthdays)=365
- If the user gives no cadence for a relationship, ASK. Don't invent one.

Service kinds:
- "relationship" — a person (Mom, partner, sister, friend)
- "commitment" — a recurring obligation (dentist, therapy, gym)
- "task" — a recurring chore (water plants, change air filter)

Add only what the user explicitly mentions. Don't speculate or pad the list. Use \`update_life_service\` to refine an entry after a follow-up answer (e.g. setting cadenceDays once they confirm). Use \`remove_life_service\` if they say "actually, drop X".

## Date confirmation (CRITICAL)

For any service tied to a specific calendar date — anniversaries, birthdays, holidays, scheduled appointments — you MUST confirm the exact date with the user BEFORE adding or updating the service. Dates are easy to get wrong; getting them wrong here means firing a real PagerDuty page on the wrong day.

Today's date is **${new Date().toISOString().slice(0, 10)}**.

Rules:

1. **Always confirm.** When the user says "anniversary October 12", reply with the *full* date including year and ask them to confirm. Pick the next occurrence: if Oct 12 is in the future this year, that's the year; if it already passed, default to next year — but state your assumption explicitly. Example: *"Anniversary on **2026-10-12** — that's later this year, right? (If it was earlier this year I'll mark it 2027 instead.)"*

2. **If the date already passed or is today/yesterday, ask whether to page immediately.** When the confirmed anchorDate is in the past or within ~24 hours, after adding the service ask something like: *"🚨 Heads up — that anniversary was 3 days ago. Want me to page you about it now? I can also draft an apology if useful."* If the user says yes (or anything affirmative — "yes", "do it", "page me", "we've got a situation", etc.), the full sequence is: \`create_escalation_policy\` → \`deploy_life_service\` → **\`page_now\`** (the actual page — don't skip this!). Don't just say the page is happening — actually invoke \`page_now\` as the last tool call.

3. **Pass anchorDate as YYYY-MM-DD** to \`add_life_service\` / \`update_life_service\` ONLY after the user has confirmed it. Never set anchorDate from a guess.

4. **Skip date confirmation for cadence-only services.** "Call mom every 2 weeks" doesn't have an anchor date — don't ask. Only date-anchored events need this.

## Deploying to PagerDuty

**Every Life Ops service is automatically deployed to PagerDuty as part of being added. Never ask the user "should I deploy this?" or "do you want this in PagerDuty?" — the answer is always YES, that's the entire product.** The only services that aren't deployed yet are ones that just got added in this turn — and you're about to deploy them right now.

When you add a service via \`add_life_service\`, **in the same response**, also call \`create_escalation_policy\` and \`deploy_life_service\` for it. Three tool calls per service: add → create EP → deploy. No confirmation between them. No "want me to wire it up?" question. Just do it and announce the result.

DO NOT ask the user about escalation either — the policy always pages only the user with a re-page nudge. Generate the witty name + description yourself.

For each service, the sequence is:

1. Call \`create_escalation_policy\` with a witty, service-specific name and description that you generate yourself. Examples:
   - For 'Mom': name *"Mom — Reply or Get Reported"*, description *"Page user. After 30 minutes of radio silence, page user again. Filial piety has an SLA."*
   - For 'Plants': name *"Plants — They Will Wilt"*, description *"Page user. There is no escalation; the plants don't have HR."*
   - For 'Dentist': name *"Dentist — Decay Is Inevitable"*, description *"Page user. Then re-page. Cavities don't self-resolve."*
   - For 'Anniversary with Eva': name *"Anniversary — DEFCON 1"*, description *"Page user. After 30 minutes, page user harder. After that, may god help them."*

2. Then call \`deploy_life_service\` with the LifeService id and the EP id you got back.

3. **If the user wants to be paged right now — including the case of a past anniversary they just confirmed — call \`page_now\` with the service id IMMEDIATELY after deploy_life_service succeeds.** This is the step the model most often forgets. Do NOT just write "you will be paged" or "the page is fired" or "right now: go fix yesterday" — those are promises, not actions. **A page only happens when \`page_now\` runs.** If you wrote a sentence implying a page is happening, you must have called the tool.

After all the tool calls succeed, announce: the escalation policy by name, the service is wired up (with link), AND if you fired \`page_now\`, say so explicitly with a confirmation the user should now see the alert on their phone.

Example response after a past-date deploy + page (note all THREE tool calls fired before this message):
*"🚨 EP **'Anniversary — DEFCON 1'** is live. ✅ Service **Life Ops · Ana's birthday** wired up — [open in PagerDuty](url). 📟 P1 fired NOW for yesterday's miss — check your phone. SLO clock resets when you mark fulfilled."*

Each service gets its own EP with its own witty name; reuse is not a feature here. The "Currently tracked services" list shows \`deployed: yes/no\` — trust that and don't re-deploy what's already there, but DO deploy anything currently showing \`deployed: no\`.

**Anti-hallucination:** If you write "deployed", "wired up", "live in PagerDuty", etc., you must have actually invoked both \`create_escalation_policy\` and \`deploy_life_service\`. No describing actions you didn't take.

## Calendar-aware paging (multi-system reasoning)

If Google Calendar is connected, the cadence sweep checks the calendar before paging. **Rule: when the user is in a meeting, default-priority services are deferred. Services explicitly marked priority="high" page through anyway.** Overdue default services get snoozed until 30 min after the busy window ends; the sweep retries every minute.

When the user asks about why something didn't page, call \`check_calendar_today\` to read current busy windows. Articulate the reasoning out loud — that's the whole point.

When the user says something is **critical / important / must always cut through** (anniversaries, partner's birthday, P0s), call \`set_service_priority\` with priority="high". When they want to demote a noisy service, set priority="default". Default for new services is unset (= treated as default). Don't auto-promote anything; wait for the user to declare it.

Example reasoning to articulate:
*"📅 You're in 'Agents Day Lisbon' until 18:00. Mom (default priority, weekly call) is overdue but I'm holding the page until 18:30. ⏸ — but I noticed Anniversary is also due today and you flagged it as high priority, so 🚨 paging through that one anyway."*

${getSchedulePrompt({ date: new Date() })}`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        add_life_service: tool({
          description:
            "Register a new Life Ops service: a person, commitment, or recurring task the user cares about. Call this immediately as the user describes things — don't wait for a complete list. For services tied to a specific calendar date (anniversary, birthday, scheduled appointment), CONFIRM the date with the user FIRST, then include it as anchorDate.",
          inputSchema: z.object({
            name: z
              .string()
              .describe(
                "Short label for the service, e.g. 'Mom', 'Dentist', 'Plants', 'Anniversary with Eva'"
              ),
            kind: z
              .enum(["relationship", "commitment", "task"])
              .describe(
                "relationship = a person; commitment = recurring obligation; task = recurring chore"
              ),
            cadenceDays: z
              .number()
              .int()
              .positive()
              .describe(
                "How often this should happen, in days. weekly=7, every couple weeks=14, monthly=30, annual=365"
              ),
            anchorDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional()
              .describe(
                "ISO date YYYY-MM-DD. Set ONLY for date-anchored services: anniversaries, birthdays, holidays, scheduled appointments with a known date. Always confirm the date with the user first. Use the future occurrence (this year if it hasn't happened yet, otherwise next year). Skip for cadence-only services like 'call every 2 weeks'."
              ),
            notes: z
              .string()
              .optional()
              .describe(
                "Any context worth remembering: location, last contact, gift ideas, etc."
              )
          }),
          execute: async ({ name, kind, cadenceDays, anchorDate, notes }) => {
            const existing = this.state.services.find(
              (s) => s.name.trim().toLowerCase() === name.trim().toLowerCase()
            );
            if (existing) {
              return {
                error: `A service named "${existing.name}" already exists (id: ${existing.id}). Use update_life_service with that id to modify it instead of creating a duplicate.`,
                existing
              };
            }
            const now = Date.now();
            const svc: LifeService = {
              id: crypto.randomUUID(),
              name,
              kind,
              cadenceDays,
              notes,
              anchorDate,
              createdAt: now,
              lastFulfilled: now
            };
            this.setState({
              ...this.state,
              services: [...this.state.services, svc]
            });
            return { added: svc };
          }
        }),

        update_life_service: tool({
          description:
            "Update fields on an existing Life Ops service. Use this to refine cadenceDays after the user clarifies, to set/correct anchorDate after confirming with the user, to rename, etc.",
          inputSchema: z.object({
            id: z.string().describe("The id of the service to update"),
            name: z.string().optional(),
            kind: z.enum(["relationship", "commitment", "task"]).optional(),
            cadenceDays: z.number().int().positive().optional(),
            anchorDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional()
              .describe("ISO date YYYY-MM-DD. Only set after confirming with the user."),
            notes: z.string().optional()
          }),
          execute: async ({ id, ...patch }) => {
            const services = this.state.services;
            const idx = services.findIndex((s) => s.id === id);
            if (idx < 0) return { error: `No service with id ${id}` };
            const updated: LifeService = { ...services[idx], ...patch, id };
            this.setState({
              ...this.state,
              services: [
                ...services.slice(0, idx),
                updated,
                ...services.slice(idx + 1)
              ]
            });
            return { updated };
          }
        }),

        remove_life_service: tool({
          description:
            "Remove a Life Ops service. Use only when the user explicitly says to drop it.",
          inputSchema: z.object({
            id: z.string().describe("The id of the service to remove")
          }),
          execute: async ({ id }) => {
            const result = await this.removeLifeService(id);
            return result.removed
              ? { removed: id }
              : { error: `No service ${id}` };
          }
        }),

        create_escalation_policy: tool({
          description:
            "Create a PagerDuty escalation policy for a single Life Ops service. Always call this BEFORE deploy_life_service. The policy ALWAYS defaults to paging only the primary user (with a re-page nudge after 30 min) — DO NOT ask the user about who should be paged. You generate the witty name + description yourself based on the service. Returns { id, url, name } — pass the id into deploy_life_service.",
          inputSchema: z.object({
            name: z
              .string()
              .describe(
                "Short, witty policy name tied to the specific service. Examples: 'Mom — Reply or Get Reported', 'Plants — They Will Wilt', 'Dentist — Decay Is Inevitable', 'Anniversary — DEFCON 1'. Must be unique-ish per service."
              ),
            description: z
              .string()
              .describe(
                "1-2 sentence witty description shown in PD. Tongue-in-cheek SRE flavor. Example: 'Page user. After 30 minutes of radio silence, page user again. Filial piety has an SLA.'"
              )
          }),
          execute: async ({ name, description }) => {
            try {
              const pd = this.pd();
              const primaryUserId = await this.ensurePdUserId();
              // Two rules — both target the user — passes PD's "2+ levels"
              // service standard and acts as a re-page nudge.
              const ep = await pd.createEscalationPolicy({
                name,
                description,
                rules: [
                  { delayMinutes: 30, targetUserIds: [primaryUserId] },
                  { delayMinutes: 60, targetUserIds: [primaryUserId] }
                ]
              });
              console.log(`[life-ops] created EP ${ep.id} -> ${ep.html_url}`);
              return { id: ep.id, url: ep.html_url, name };
            } catch (err) {
              return {
                error: err instanceof Error ? err.message : String(err)
              };
            }
          }
        }),

        deploy_life_service: tool({
          description:
            "Provision a Life Ops service in PagerDuty: creates a PD service + Events API integration, tied to the escalation policy you just created. ALWAYS call create_escalation_policy first to get an id. After both succeed, mention the EP name AND the service URL in your response so the user knows what was wired up.",
          inputSchema: z.object({
            id: z
              .string()
              .describe("The id of the Life Ops service to deploy"),
            escalationPolicyId: z
              .string()
              .describe(
                "The PD escalation policy id (from create_escalation_policy)"
              )
          }),
          execute: async ({ id, escalationPolicyId }) => {
            try {
              return await this.deployLifeService(id, escalationPolicyId);
            } catch (err) {
              return {
                error: err instanceof Error ? err.message : String(err)
              };
            }
          }
        }),

        page_now: tool({
          description:
            "Fire a real PagerDuty page for a deployed Life Ops service NOW. Use sparingly — this triggers the user's actual phone notifications. Good for: explicit user request ('page me about Mom'), demoing the alerting flow, or when you've decided a service is overdue and want to escalate immediately. Returns the dedup_key.",
          inputSchema: z.object({
            id: z.string().describe("The id of the Life Ops service to page about")
          }),
          execute: async ({ id }) => {
            try {
              return await this.pageNowLifeService(id);
            } catch (err) {
              return {
                error: err instanceof Error ? err.message : String(err)
              };
            }
          }
        }),

        mark_life_service_fulfilled: tool({
          description:
            "Mark a Life Ops service as fulfilled — the user did the thing (called Mom, watered plants, went to dentist). This resolves any open PagerDuty incident for the service AND resets the SLO clock (lastFulfilled = now). Use when the user says they did the thing, or wants to clear an active page.",
          inputSchema: z.object({
            id: z.string().describe("The id of the Life Ops service to mark fulfilled")
          }),
          execute: async ({ id }) => {
            try {
              return await this.resolveLifeService(id);
            } catch (err) {
              return {
                error: err instanceof Error ? err.message : String(err)
              };
            }
          }
        }),

        set_service_priority: tool({
          description:
            "Mark a Life Ops service as 'high' priority (will page through busy calendar windows — meetings, conferences, etc.) or 'default' (will be deferred until the user is free). Use this when the user says something is critical / important / must always cut through (anniversaries, partner's birthday, etc.) or wants to demote noise.",
          inputSchema: z.object({
            id: z.string().describe("The id of the Life Ops service"),
            priority: z
              .enum(["high", "default"])
              .describe(
                "high = pages through busy windows; default = defers when busy"
              )
          }),
          execute: async ({ id, priority }) => {
            const svc = this.state.services.find((s) => s.id === id);
            if (!svc) return { error: `No service ${id}` };
            this.patchService(id, { priority });
            return { id, name: svc.name, priority };
          }
        }),

        check_calendar_today: tool({
          description:
            "Refresh and read the user's Google Calendar busy windows for today and the next 24 hours. Returns busy windows + whether the user is busy right now. Use this to reason about whether a service should page through or be deferred. Returns null if Google Calendar isn't connected — tell the user to connect via the sidebar in that case.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              const status = await this.refreshCalendarStatus();
              if (!status) {
                return {
                  connected: false,
                  message:
                    "Google Calendar is not connected. User can paste an OAuth access token via the sidebar Calendar settings."
                };
              }
              return {
                connected: true,
                busyNow: status.busyNow,
                busyTitle: status.busyTitle ?? null,
                busyUntil: status.busyUntil
                  ? new Date(status.busyUntil).toISOString()
                  : null,
                upcomingBusy: status.busyWindows.map((w) => ({
                  title: w.title,
                  start: new Date(w.start).toISOString(),
                  end: new Date(w.end).toISOString()
                }))
              };
            } catch (err) {
              return {
                error: err instanceof Error ? err.message : String(err)
              };
            }
          }
        }),

        register_pagerduty_webhook: tool({
          description:
            "Register a PagerDuty webhook subscription so incident state changes from the PD mobile app (ack, resolve) flow back into our state. Pass the public origin where this Worker is reachable (e.g. https://rough-sea-23c1.your-subdomain.workers.dev). Only call this once, after the user deploys the Worker. Stores the returned secret for HMAC verification.",
          inputSchema: z.object({
            workerOrigin: z
              .string()
              .url()
              .describe(
                "Public origin of this Worker, e.g. https://rough-sea-23c1.acme.workers.dev (no trailing path)"
              )
          }),
          execute: async ({ workerOrigin }) => {
            try {
              return await this.registerPdWebhook(workerOrigin);
            } catch (err) {
              return {
                error: err instanceof Error ? err.message : String(err)
              };
            }
          }
        }),

        list_life_services: tool({
          description:
            "List all Life Ops services currently tracked for this user.",
          inputSchema: z.object({}),
          execute: async () => ({ services: this.state.services })
        }),

        // Client-side tool: no execute function — the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

async function verifyPdSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  const provided = signatureHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => s.slice(3));
  if (provided.length === 0) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const computed = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return provided.includes(computed);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Log anything hitting /pd/* so we can see if PD is reaching us at all,
    // even via methods/paths we don't expect.
    if (url.pathname.startsWith("/pd")) {
      console.log(
        `[life-ops] /pd request: method=${request.method} path=${url.pathname}`
      );
    }

    const webhookMatch = url.pathname.match(/^\/pd\/webhook(?:\/([^/]+))?\/?$/);
    if (webhookMatch && request.method === "GET") {
      // Diagnostic: lets you curl/browse this URL to confirm it's reachable.
      return new Response(
        JSON.stringify(
          {
            ok: true,
            agentName: webhookMatch[1]
              ? decodeURIComponent(webhookMatch[1])
              : "default",
            note: "POST PagerDuty webhook events here. GET is a diagnostic-only endpoint."
          },
          null,
          2
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    if (webhookMatch && request.method === "POST") {
      const rawBody = await request.text();
      const signature = request.headers.get("X-PagerDuty-Signature");
      // Older subscriptions registered without a name → fall back to "default".
      const agentName = webhookMatch[1]
        ? decodeURIComponent(webhookMatch[1])
        : "default";

      // Dump every PD-relevant header for debugging.
      const pdHeaders: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        if (k.toLowerCase().startsWith("x-pagerduty") || k === "user-agent") {
          pdHeaders[k] = v;
        }
      });

      console.log(
        `[life-ops] PD WEBHOOK INBOUND for agent="${agentName}", bytes=${rawBody.length}`
      );
      console.log("[life-ops] PD headers:", JSON.stringify(pdHeaders));
      console.log(
        "[life-ops] PD body:",
        rawBody.length > 4000 ? rawBody.slice(0, 4000) + "...[truncated]" : rawBody
      );

      // Respond 200 immediately so PD doesn't time out and disable the
      // subscription. Process the event in the background.
      ctx.waitUntil(
        (async () => {
          try {
            const stub = await getAgentByName(env.ChatAgent, agentName);
            await stub.handlePdWebhookEvent(rawBody, signature);
          } catch (err) {
            console.error("[life-ops] webhook processing failed:", err);
          }
        })()
      );
      return new Response("ok", { status: 200 });
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
