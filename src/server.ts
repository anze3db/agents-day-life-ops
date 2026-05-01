import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
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

export type LifeServiceKind = "relationship" | "commitment" | "task";

export type LifeService = {
  id: string;
  name: string;
  kind: LifeServiceKind;
  cadenceDays: number;
  notes?: string;
  createdAt: number;
  lastFulfilled?: number;
  pdServiceId?: string;
  pdServiceUrl?: string;
  pdIntegrationKey?: string;
};

export type ChatAgentState = {
  services: LifeService[];
  pdUserId?: string;
  pdEscalationPolicyId?: string;
  pdWebhookSecret?: string;
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

  /**
   * Lazily provision the user-level PD primitives (user lookup, escalation
   * policy). Idempotent — reuses cached ids in state.
   */
  private async ensurePdAccountSetup(): Promise<{
    pdUserId: string;
    pdEscalationPolicyId: string;
  }> {
    let { pdUserId, pdEscalationPolicyId } = this.state;
    const pd = this.pd();

    if (!pdUserId) {
      const user = await pd.getUserByEmail(this.env.PAGERDUTY_USER_EMAIL);
      if (!user) {
        throw new Error(
          `No PagerDuty user found for email ${this.env.PAGERDUTY_USER_EMAIL}`
        );
      }
      pdUserId = user.id;
      this.setState({ ...this.state, pdUserId });
    }

    if (!pdEscalationPolicyId) {
      const ep = await pd.createEscalationPolicy({
        name: "Life Ops",
        description:
          "Five-nines uptime for the people who put up with your two-nines availability.",
        userId: pdUserId,
        delayMinutes: 30
      });
      pdEscalationPolicyId = ep.id;
      console.log(`[life-ops] created EP ${ep.id} -> ${ep.html_url}`);
      this.setState({ ...this.state, pdEscalationPolicyId });
    }

    return { pdUserId, pdEscalationPolicyId };
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
  async deployLifeService(serviceId: string) {
    const svc = this.state.services.find((s) => s.id === serviceId);
    if (!svc) throw new Error(`No life service with id ${serviceId}`);
    if (svc.pdServiceId && svc.pdIntegrationKey) {
      return { alreadyDeployed: true, service: svc };
    }

    const { pdEscalationPolicyId } = await this.ensurePdAccountSetup();
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
      escalationPolicyId: pdEscalationPolicyId
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
      pdIntegrationKey: integration.integration_key
    };
    this.setState({
      ...this.state,
      services: this.state.services.map((s) =>
        s.id === serviceId ? updated : s
      )
    });
    return { service: updated };
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const services = this.state.services;
    const servicesContext =
      services.length === 0
        ? "## Currently tracked services\n(none yet — this is a fresh setup)"
        : `## Currently tracked services
${services
  .map(
    (s) =>
      `- ${s.name} (id: ${s.id}, kind: ${s.kind}, cadence: ${s.cadenceDays}d${s.notes ? `, notes: "${s.notes}"` : ""}, deployed: ${s.pdServiceId ? "yes" : "no"})`
  )
  .join("\n")}

CRITICAL: If the user adds context about someone/something already in this list — clarifying a cadence, renaming, adding a note, mentioning the person again — use \`update_life_service\` with the matching id. NEVER call \`add_life_service\` for an entry that already exists here. Match by name case-insensitively; "mom", "Mom", "my mom" all refer to the same service.`;

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are Life Ops — an SRE-style agent for someone's personal life. The pitch is tongue-in-cheek: PagerDuty for the people and habits that matter. Your current job is **onboarding**: capture what the user cares about as structured "services" with cadence targets (their personal SLOs).

${servicesContext}

Conversation flow:
1. If this is a fresh chat (no services exist yet), open with a short, dry one-liner and a single question: something like "Tell me who and what matters — people, commitments, things you don't want to drop. Brain-dump it."
2. As the user describes things, immediately call \`add_life_service\` for each item you can identify. Don't batch — fire the tool calls as you read so the user sees cards appear live in their sidebar. Use the values you have; ask later for what's missing.
3. After the dump, ask targeted follow-ups **one at a time** for genuine ambiguities only. Examples:
   - "'Every couple weeks' for Mom — I'll set 14 days, ok?"
   - "How often do you usually catch up with Ana?" (no default for siblings)
   - "Anniversary — page you 1 week ahead, or 1 month?"
   Don't re-ask things they've already answered. Don't pile on questions.
4. Tone: light, dry, occasionally SRE-flavored ("Mom is a P1, plants are a P3"). Don't overdo it — one joke per turn, max.

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

After a service has a confirmed cadence, you can offer to wire it into PagerDuty by calling \`deploy_life_service\` with its id. Mention it casually after the brain-dump is settled — something like "Want me to wire these up to PagerDuty so you actually get paged?" — then deploy the ones the user agrees to. Don't deploy without confirmation. Each service in the "Currently tracked services" list above shows whether it's already deployed by whether you've seen a deploy result for it; trust that — don't re-deploy.

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
            "Register a new Life Ops service: a person, commitment, or recurring task the user cares about. Call this immediately as the user describes things — don't wait for a complete list.",
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
            notes: z
              .string()
              .optional()
              .describe(
                "Any context worth remembering: location, last contact, gift ideas, etc."
              )
          }),
          execute: async ({ name, kind, cadenceDays, notes }) => {
            const existing = this.state.services.find(
              (s) => s.name.trim().toLowerCase() === name.trim().toLowerCase()
            );
            if (existing) {
              return {
                error: `A service named "${existing.name}" already exists (id: ${existing.id}). Use update_life_service with that id to modify it instead of creating a duplicate.`,
                existing
              };
            }
            const svc: LifeService = {
              id: crypto.randomUUID(),
              name,
              kind,
              cadenceDays,
              notes,
              createdAt: Date.now()
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
            "Update fields on an existing Life Ops service. Use this to refine cadenceDays after the user clarifies, or to rename, etc.",
          inputSchema: z.object({
            id: z.string().describe("The id of the service to update"),
            name: z.string().optional(),
            kind: z.enum(["relationship", "commitment", "task"]).optional(),
            cadenceDays: z.number().int().positive().optional(),
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
            const svc = this.state.services.find((s) => s.id === id);
            if (!svc) return { error: `No service ${id}` };
            if (svc.pdServiceId) {
              try {
                await this.pd().deleteService(svc.pdServiceId);
              } catch (err) {
                console.error("PD delete failed (continuing):", err);
              }
            }
            this.setState({
              ...this.state,
              services: this.state.services.filter((s) => s.id !== id)
            });
            return { removed: id };
          }
        }),

        deploy_life_service: tool({
          description:
            "Provision a Life Ops service in PagerDuty: creates a PD service + Events API integration tied to the user's escalation policy. The escalation policy is created lazily on first deploy. Returns the updated service with pdServiceId and pdIntegrationKey set. Use this once the user has confirmed cadence and is ready to wire alerting.",
          inputSchema: z.object({
            id: z.string().describe("The id of the Life Ops service to deploy")
          }),
          execute: async ({ id }) => {
            try {
              return await this.deployLifeService(id);
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
      stopWhen: stepCountIs(5),
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

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
