/**
 * Minimal PagerDuty client for Life Ops.
 *
 * REST: https://api.pagerduty.com (or https://api.eu.pagerduty.com for EU)
 * Events API v2: https://events.pagerduty.com/v2/enqueue
 *
 * Auth: REST uses `Authorization: Token token=<key>`. Events API uses
 * `routing_key` in the body (no auth header).
 */

const REST_BASE = "https://api.pagerduty.com";
const EVENTS_BASE = "https://events.pagerduty.com/v2/enqueue";

export type PdUserRef = { id: string; type: "user_reference" };
export type PdEpRef = { id: string; type: "escalation_policy_reference" };

export type PdSeverity = "info" | "warning" | "error" | "critical";

export type PdEventPayload = {
  summary: string;
  source: string;
  severity: PdSeverity;
  custom_details?: Record<string, unknown>;
};

export class PagerDutyClient {
  constructor(private readonly token: string) {}

  private async rest<T>(
    path: string,
    init: Omit<RequestInit, "body"> & { body?: unknown } = {}
  ): Promise<T> {
    const { body, headers, ...rest } = init;
    const res = await fetch(`${REST_BASE}${path}`, {
      ...rest,
      headers: {
        Authorization: `Token token=${this.token}`,
        Accept: "application/vnd.pagerduty+json;version=2",
        "Content-Type": "application/json",
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PD ${res.status} ${path}: ${text}`);
    }
    return (await res.json()) as T;
  }

  /** Look up a user by email. Returns null if no match. */
  async getUserByEmail(email: string): Promise<{ id: string } | null> {
    const data = await this.rest<{ users: { id: string; email: string }[] }>(
      `/users?query=${encodeURIComponent(email)}`
    );
    return data.users.find((u) => u.email === email) ?? null;
  }

  /** Create an escalation policy. */
  async createEscalationPolicy(input: {
    name: string;
    description?: string;
    rules: Array<{
      delayMinutes: number;
      targetUserIds: string[];
    }>;
  }): Promise<{ id: string; html_url: string }> {
    const data = await this.rest<{
      escalation_policy: { id: string; html_url: string };
    }>("/escalation_policies", {
      method: "POST",
      body: {
        escalation_policy: {
          type: "escalation_policy",
          name: input.name,
          description: input.description,
          escalation_rules: input.rules.map((r) => ({
            escalation_delay_in_minutes: r.delayMinutes,
            targets: r.targetUserIds.map((id) => ({
              id,
              type: "user_reference"
            }))
          }))
        }
      }
    });
    return data.escalation_policy;
  }

  /** Create a service tied to an escalation policy. */
  async createService(input: {
    name: string;
    description?: string;
    escalationPolicyId: string;
  }): Promise<{ id: string; html_url: string }> {
    const data = await this.rest<{
      service: { id: string; html_url: string };
    }>("/services", {
      method: "POST",
      body: {
        service: {
          type: "service",
          name: input.name,
          description: input.description,
          escalation_policy: {
            id: input.escalationPolicyId,
            type: "escalation_policy_reference"
          },
          alert_creation: "create_alerts_and_incidents"
        }
      }
    });
    return data.service;
  }

  /** Create an Events API v2 integration on a service; returns integration_key (routing key). */
  async createEventsApiIntegration(
    serviceId: string,
    name = "Life Ops"
  ): Promise<{ id: string; integration_key: string }> {
    const data = await this.rest<{
      integration: { id: string; integration_key: string };
    }>(`/services/${serviceId}/integrations`, {
      method: "POST",
      body: {
        integration: {
          type: "events_api_v2_inbound_integration",
          name
        }
      }
    });
    return data.integration;
  }

  /** Create a webhook subscription. Returns secret for HMAC verification. */
  async createWebhookSubscription(input: {
    url: string;
    description?: string;
    events?: string[];
  }): Promise<{ id: string; secret: string }> {
    const data = await this.rest<{
      webhook_subscription: { id: string; secret: string };
    }>("/webhook_subscriptions", {
      method: "POST",
      body: {
        webhook_subscription: {
          type: "webhook_subscription",
          delivery_method: {
            type: "http_delivery_method",
            url: input.url
          },
          description: input.description ?? "Life Ops",
          events: input.events ?? [
            "incident.triggered",
            "incident.acknowledged",
            "incident.resolved",
            "incident.unacknowledged"
          ],
          filter: { type: "account_reference" }
        }
      }
    });
    return data.webhook_subscription;
  }

  async getService(
    serviceId: string
  ): Promise<{ id: string; html_url: string }> {
    const data = await this.rest<{
      service: { id: string; html_url: string };
    }>(`/services/${serviceId}`);
    return data.service;
  }

  async deleteService(serviceId: string): Promise<void> {
    const res = await fetch(`${REST_BASE}/services/${serviceId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Token token=${this.token}`,
        Accept: "application/vnd.pagerduty+json;version=2"
      }
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`PD DELETE /services/${serviceId} ${res.status}`);
    }
  }

  /** Fire a trigger event via Events API v2. */
  async triggerEvent(input: {
    routingKey: string;
    dedupKey: string;
    payload: PdEventPayload;
  }): Promise<{ dedup_key: string }> {
    const res = await fetch(EVENTS_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: input.routingKey,
        event_action: "trigger",
        dedup_key: input.dedupKey,
        payload: input.payload
      })
    });
    if (!res.ok) {
      throw new Error(`PD events trigger ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as { dedup_key: string };
  }

  /** Resolve a previously-triggered event by dedup_key. */
  async resolveEvent(input: {
    routingKey: string;
    dedupKey: string;
  }): Promise<void> {
    const res = await fetch(EVENTS_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: input.routingKey,
        event_action: "resolve",
        dedup_key: input.dedupKey
      })
    });
    if (!res.ok) {
      throw new Error(`PD events resolve ${res.status}: ${await res.text()}`);
    }
  }
}
