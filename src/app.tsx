import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type {
  ChatAgent,
  ChatAgentState,
  LifeService,
  CadenceSweepResult,
  CalendarStatus,
  SweepServiceResult,
  SweepOutcome
} from "./server";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  Surface,
  Text
} from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  XIcon,
  PaperclipIcon,
  ImageIcon,
  HeartIcon,
  CalendarCheckIcon,
  RepeatIcon
} from "@phosphor-icons/react";

// ── Attachment helpers ────────────────────────────────────────────────

interface Attachment {
  id: string;
  file: File;
  preview: string;
  mediaType: string;
}

function createAttachment(file: File): Attachment {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    preview: URL.createObjectURL(file),
    mediaType: file.type || "application/octet-stream"
  };
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Small components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Tool rendering ────────────────────────────────────────────────────

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  // Completed
  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.output, null, 2)}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  // Needs approval
  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <GearIcon size={14} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approval needed: {toolName}
            </Text>
          </div>
          <div className="font-mono mb-3">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: true });
                }
              }}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: false });
                }
              }}
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  // Rejected / denied
  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </Surface>
      </div>
    );
  }

  // Executing
  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
            <Text size="xs" variant="secondary">
              Running {toolName}...
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  return null;
}

// ── Life Ops sidebar ──────────────────────────────────────────────────

const KIND_ICON = {
  relationship: HeartIcon,
  commitment: CalendarCheckIcon,
  task: RepeatIcon
} as const;

function cadenceLabel(days: number): string {
  if (days === 1) return "daily";
  if (days === 7) return "weekly";
  if (days === 14) return "biweekly";
  if (days === 30) return "monthly";
  if (days === 365) return "annual";
  return `every ${days}d`;
}

function daysSince(ts?: number): string | null {
  if (!ts) return null;
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "1 day ago";
  return `${d}d ago`;
}

function outcomeIcon(o: SweepOutcome): string {
  switch (o) {
    case "paged":
      return "🚨";
    case "deferred":
      return "⏸";
    case "snoozed":
      return "💤";
    case "open":
      return "🔥";
    case "idle":
      return "🟢";
    case "not-deployed":
      return "⚙️";
    case "error":
      return "⚠️";
  }
}

function ServiceCard({
  service,
  onDeploy,
  onForceDue,
  onTogglePriority,
  onDelete
}: {
  service: LifeService;
  onDeploy: (s: LifeService) => void;
  onForceDue: (s: LifeService) => void;
  onTogglePriority: (s: LifeService) => void;
  onDelete: (s: LifeService) => void;
}) {
  const Icon = KIND_ICON[service.kind];
  const deployed = Boolean(service.pdServiceId);
  const open = Boolean(service.activeDedupKey);
  const acked = Boolean(service.acknowledgedAt);
  const snoozed =
    Boolean(service.snoozedUntil) && service.snoozedUntil! > Date.now();
  const lastLabel = daysSince(service.lastFulfilled);

  const ring =
    open && !acked
      ? "ring-2 ring-kumo-danger"
      : open && acked
        ? "ring-2 ring-kumo-warning"
        : "ring ring-kumo-line";

  const badgeVariant: "primary" | "secondary" | "destructive" =
    open && !acked ? "destructive" : open && acked ? "secondary" : "primary";
  const dotClass =
    open && !acked
      ? "text-kumo-danger"
      : open && acked
        ? "text-kumo-warning"
        : "text-kumo-success";
  const badgeLabel =
    open && !acked
      ? "Incident open ↗"
      : open && acked
        ? "Acknowledged ↗"
        : "Open in PagerDuty ↗";

  return (
    <Surface className={`relative group px-3 py-2.5 rounded-lg ${ring}`}>
      <button
        type="button"
        onClick={() => onDelete(service)}
        className="absolute top-1 right-1 p-1 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-kumo-control transition-opacity cursor-pointer"
        aria-label={`Delete ${service.name}`}
        title="Delete service"
      >
        <XIcon size={12} className="text-kumo-default" />
      </button>
      <div className="flex items-start gap-2">
        {deployed ? (
          <button
            type="button"
            onClick={() => onForceDue(service)}
            className="text-kumo-accent mt-0.5 shrink-0 hover:opacity-60 transition-opacity cursor-pointer"
            aria-label={`Force ${service.name} due`}
            title="Click to force due (demo)"
          >
            <Icon size={16} />
          </button>
        ) : (
          <Icon size={16} className="text-kumo-accent mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <Text size="sm" bold>
              {service.name}
            </Text>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onTogglePriority(service)}
                className="cursor-pointer hover:opacity-70 transition-opacity"
                aria-label={
                  service.priority === "high"
                    ? `${service.name} is high priority. Click to demote.`
                    : `${service.name} is default priority. Click to mark high.`
                }
                title={
                  service.priority === "high"
                    ? "🔥 High priority — pages through busy calendar windows. Click to demote to default."
                    : "Default priority — defers when you're in a meeting. Click to mark high (always pages)."
                }
              >
                {service.priority === "high" ? (
                  <Badge variant="destructive">🔥 High</Badge>
                ) : (
                  <Badge variant="secondary">Default</Badge>
                )}
              </button>
              <Badge variant="secondary">
                {cadenceLabel(service.cadenceDays)}
              </Badge>
            </div>
          </div>
          <Text size="xs" variant="secondary">
            {service.kind}
            {service.anchorDate && ` · ${service.anchorDate}`}
            {lastLabel && ` · last: ${lastLabel}`}
          </Text>
          {service.notes && (
            <Text size="xs" variant="secondary">
              {service.notes}
            </Text>
          )}
          {snoozed && service.snoozedUntil && (
            <Text size="xs" variant="secondary">
              ⏸ deferred until{" "}
              {new Date(service.snoozedUntil).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit"
              })}
            </Text>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {!deployed && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onDeploy(service)}
              >
                Deploy
              </Button>
            )}

            {deployed && service.pdServiceUrl && (
              <a
                href={service.pdServiceUrl}
                target="_blank"
                rel="noreferrer"
                className="no-underline"
              >
                <Badge variant={badgeVariant}>
                  <CircleIcon
                    size={8}
                    weight="fill"
                    className={`mr-1 ${dotClass}`}
                  />
                  {badgeLabel}
                </Badge>
              </a>
            )}


          </div>
        </div>
      </div>
    </Surface>
  );
}

function LifeOpsSidebar({
  services,
  lastSweep,
  webhookUrl,
  calendarStatus,
  googleConnected,
  onDeploy,
  onForceDue,
  onTogglePriority,
  onDelete,
  onRunSweep,
  onVerifyWebhook,
  onConnectGoogle,
  onDisconnectGoogle,
  onRefreshCalendar
}: {
  services: LifeService[];
  lastSweep: CadenceSweepResult | undefined;
  webhookUrl: string | undefined;
  calendarStatus: CalendarStatus | undefined;
  googleConnected: boolean;
  onDeploy: (s: LifeService) => void;
  onForceDue: (s: LifeService) => void;
  onTogglePriority: (s: LifeService) => void;
  onDelete: (s: LifeService) => void;
  onRunSweep: () => void;
  onVerifyWebhook: () => void;
  onConnectGoogle: (token: string) => void;
  onDisconnectGoogle: () => void;
  onRefreshCalendar: () => void;
}) {
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [showSweepDetails, setShowSweepDetails] = useState(false);
  // Tick once per second so "Xs ago" stays live without depending on state.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const sweepRel = lastSweep ? daysSince(lastSweep.at) : null;
  const sweepSecs = lastSweep
    ? Math.max(1, Math.floor((Date.now() - lastSweep.at) / 1000))
    : null;
  const sweepLabel = !lastSweep
    ? "no sweeps yet"
    : sweepSecs !== null && sweepSecs < 60
      ? `${sweepSecs}s ago`
      : sweepRel || "recent";

  return (
    <aside className="w-72 shrink-0 border-r border-kumo-line bg-kumo-base flex flex-col">
      <div className="px-4 py-4 border-b border-kumo-line flex items-center justify-between">
        <h2 className="text-sm font-semibold text-kumo-default">
          <span className="mr-2">📟</span>Life Ops
        </h2>
        {services.length > 0 && (
          <Badge variant="secondary">{services.length}</Badge>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {services.length === 0 ? (
          <div className="text-center py-8 px-3">
            <Text size="sm" variant="secondary">
              No services yet.
            </Text>
            <Text size="xs" variant="secondary">
              Tell the agent what — and who — matters. Cards will appear here as
              it understands.
            </Text>
          </div>
        ) : (
          services.map((s) => (
            <ServiceCard
              key={s.id}
              service={s}
              onDeploy={onDeploy}
              onForceDue={onForceDue}
              onTogglePriority={onTogglePriority}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
      <div className="px-3 py-3 border-t border-kumo-line space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Text size="xs" variant="secondary">
              📅 Calendar:{" "}
              <span
                className={
                  googleConnected
                    ? "text-kumo-success"
                    : "text-kumo-inactive"
                }
              >
                {googleConnected ? "✓ connected" : "not connected"}
              </span>
            </Text>
          </div>
          {googleConnected && calendarStatus && (
            <Text size="xs" variant="secondary">
              {calendarStatus.busyNow ? (
                <>
                  Busy:{" "}
                  <span className="text-kumo-default">
                    {calendarStatus.busyTitle}
                  </span>{" "}
                  until{" "}
                  {calendarStatus.busyUntil &&
                    new Date(calendarStatus.busyUntil).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                </>
              ) : (
                "Free now"
              )}
            </Text>
          )}
          {!googleConnected && !showTokenForm && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowTokenForm(true)}
              className="w-full"
            >
              Connect Google Calendar
            </Button>
          )}
          {!googleConnected && showTokenForm && (
            <div className="space-y-1.5">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="OAuth access token"
                className="w-full px-2 py-1 text-xs rounded border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent font-mono"
              />
              <div className="flex gap-1">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    if (tokenInput.trim()) {
                      onConnectGoogle(tokenInput.trim());
                      setTokenInput("");
                      setShowTokenForm(false);
                    }
                  }}
                  className="flex-1"
                  disabled={!tokenInput.trim()}
                >
                  Connect
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTokenInput("");
                    setShowTokenForm(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
              <div className="text-center">
                <a
                  href="https://developers.google.com/oauthplayground/#step1&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events.readonly"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs underline text-kumo-subtle"
                >
                  get a token from OAuth Playground ↗
                </a>
              </div>
            </div>
          )}
          {googleConnected && (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={onRefreshCalendar}
                className="flex-1"
              >
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDisconnectGoogle}
              >
                Disconnect
              </Button>
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Text size="xs" variant="secondary">
              Webhook:{" "}
              <span
                className={
                  webhookUrl ? "text-kumo-success" : "text-kumo-inactive"
                }
              >
                {webhookUrl ? "✓ subscribed" : "not set up"}
              </span>
            </Text>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onVerifyWebhook}
            className="w-full"
          >
            {webhookUrl ? "Re-verify webhook" : "Set up webhook"}
          </Button>
        </div>
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setShowSweepDetails((v) => !v)}
            className="w-full text-left flex items-center justify-between gap-2 hover:opacity-80 cursor-pointer"
            disabled={!lastSweep}
          >
            <Text size="xs" variant="secondary">
              {sweepSecs !== null && sweepSecs < 3 && (
                <span className="inline-block size-1.5 rounded-full bg-kumo-success mr-1.5 animate-pulse" />
              )}
              Sweep: <span className="text-kumo-default">{sweepLabel}</span>
              {lastSweep && ` · paged ${lastSweep.fired}/${lastSweep.checked}`}
            </Text>
            {lastSweep && (
              <Text size="xs" variant="secondary">
                {showSweepDetails ? "▾" : "▸"}
              </Text>
            )}
          </button>
          {showSweepDetails && lastSweep && (
            <Surface className="rounded-md ring ring-kumo-line p-2 space-y-1">
              {lastSweep.busyTitle && (
                <Text size="xs" variant="secondary">
                  📅 during: {lastSweep.busyTitle}
                </Text>
              )}
              {lastSweep.perService.length === 0 ? (
                <Text size="xs" variant="secondary">
                  No services to check.
                </Text>
              ) : (
                lastSweep.perService.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-baseline justify-between gap-2"
                  >
                    <Text size="xs">
                      <span className="mr-1">{outcomeIcon(r.outcome)}</span>
                      <span className="text-kumo-default">{r.name}</span>
                      {r.detail && (
                        <span className="text-kumo-subtle"> · {r.detail}</span>
                      )}
                    </Text>
                    <Text size="xs" variant="secondary">
                      {r.outcome}
                    </Text>
                  </div>
                ))
              )}
            </Surface>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={onRunSweep}
            className="w-full"
          >
            Run sweep now
          </Button>
          <div className="text-center">
            <Text size="xs" variant="secondary">
              auto-sweeps every 15s
            </Text>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toasts = useKumoToastManager();

  const agent = useAgent<ChatAgent, ChatAgentState>({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "scheduled-task") {
            toasts.add({
              title: "Scheduled task completed",
              description: data.description,
              timeout: 0
            });
          } else if (data.type === "cadence-sweep-paged") {
            const names = (data.firedNames as string[]).join(", ");
            toasts.add({
              title: `Sweep paged ${data.firedNames.length}`,
              description: `Overdue: ${names}. Check your phone.`,
              timeout: 6000
            });
          } else if (data.type === "cadence-sweep-deferred") {
            const names = (data.deferredNames as string[]).join(", ");
            const busy = data.busyTitle ? ` (busy: ${data.busyTitle})` : "";
            toasts.add({
              title: `📅 Deferred ${data.deferredNames.length}`,
              description: `${names} — paused while you're in meetings${busy}.`,
              timeout: 5000
            });
          } else if (data.type === "pd-incident-triggered") {
            toasts.add({
              title: `Incident: ${data.serviceName}`,
              description: "PagerDuty just paged you. Check your phone.",
              timeout: 5000
            });
          } else if (data.type === "pd-incident-acked") {
            toasts.add({
              title: `Acknowledged: ${data.serviceName}`,
              description: "You're on it. Mark fulfilled when done.",
              timeout: 4000
            });
          } else if (data.type === "pd-incident-resolved") {
            toasts.add({
              title: `Resolved: ${data.serviceName}`,
              description: "Back to green. SLO clock reset.",
              timeout: 4000
            });
          } else if (data.type === "pd-sync-changes") {
            const updates = data.updates as Array<{
              name: string;
              transition: string;
            }>;
            const resolved = updates.filter((u) =>
              u.transition.endsWith("resolved")
            );
            if (resolved.length > 0) {
              toasts.add({
                title: `Synced ${resolved.length} from PagerDuty`,
                description: `${resolved.map((u) => u.name).join(", ")} resolved while you were away — marked fulfilled.`,
                timeout: 5000
              });
            }
          }
        } catch {
          // Not JSON or not our event
        }
      },
      [toasts]
    )
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    onToolCall: async (event) => {
      if (
        "addToolOutput" in event &&
        event.toolCall.toolName === "getUserTimezone"
      ) {
        event.addToolOutput({
          toolCallId: event.toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Re-focus the input after streaming ends
  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setAttachments((prev) => [...prev, ...images.map(createAttachment)]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att) URL.revokeObjectURL(att.preview);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles]
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isStreaming) return;
    setInput("");

    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; mediaType: string; url: string }
    > = [];
    if (text) parts.push({ type: "text", text });

    for (const att of attachments) {
      const dataUri = await fileToDataUri(att.file);
      parts.push({ type: "file", mediaType: att.mediaType, url: dataUri });
    }

    for (const att of attachments) URL.revokeObjectURL(att.preview);
    setAttachments([]);

    sendMessage({ role: "user", parts });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, attachments, isStreaming, sendMessage]);

  const services = agent.state?.services ?? [];

  const hasUnurledDeployment = services.some(
    (s) => s.pdServiceId && !s.pdServiceUrl
  );
  useEffect(() => {
    if (hasUnurledDeployment && connected) {
      agent.stub.backfillPdUrls().catch((e) => console.error(e));
    }
  }, [hasUnurledDeployment, connected, agent]);

  // Sync incident state with PagerDuty whenever the tab regains focus.
  // Catches cases where the user resolved/acked on the PD mobile app while
  // the tab was backgrounded and webhooks didn't reach us.
  const hasOpenIncidents = services.some((s) => s.activeDedupKey);
  useEffect(() => {
    if (!connected) return;
    const sync = () => {
      if (document.hidden) return;
      if (!hasOpenIncidents) return;
      agent.stub.syncOpenIncidents().catch((e) => console.error(e));
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [connected, hasOpenIncidents, agent]);

  return (
    <div className="flex h-screen bg-kumo-elevated">
      <LifeOpsSidebar
        services={services}
        lastSweep={agent.state?.lastSweep}
        webhookUrl={agent.state?.pdWebhookUrl}
        calendarStatus={agent.state?.calendarStatus}
        googleConnected={Boolean(agent.state?.googleAccessToken)}
        onDelete={async (s) => {
          try {
            await agent.stub.removeLifeService(s.id);
            toasts.add({
              title: `Removed: ${s.name}`,
              description: s.pdServiceId
                ? "Local card + PagerDuty service deleted."
                : "Removed from list.",
              timeout: 3000
            });
          } catch (e) {
            toasts.add({
              title: "Delete failed",
              description: e instanceof Error ? e.message : String(e),
              timeout: 6000
            });
          }
        }}
        onTogglePriority={async (s) => {
          try {
            const res = await agent.stub.toggleServicePriority(s.id);
            toasts.add({
              title:
                res.priority === "high"
                  ? `🔥 ${s.name}: high priority`
                  : `${s.name}: default priority`,
              description:
                res.priority === "high"
                  ? "Will page through busy calendar windows."
                  : "Will defer when you're in a meeting.",
              timeout: 3500
            });
          } catch (e) {
            toasts.add({
              title: "Priority toggle failed",
              description: e instanceof Error ? e.message : String(e),
              timeout: 5000
            });
          }
        }}
        onForceDue={async (s) => {
          try {
            const res = await agent.stub.demoForceDueAndSweep(s.id);
            const sweepResult = res?.lastSweep;
            const myResult = sweepResult?.perService.find(
              (r) => r.id === s.id
            );
            if (myResult?.outcome === "deferred") {
              toasts.add({
                title: `📅 ${s.name} deferred`,
                description: `Forced due — calendar gate held the page${myResult.detail ? ` (${myResult.detail})` : ""}.`,
                timeout: 5000
              });
            } else if (myResult?.outcome === "paged") {
              toasts.add({
                title: `🚨 ${s.name} paged`,
                description: "Forced due — calendar was free, page fired.",
                timeout: 5000
              });
            } else {
              toasts.add({
                title: `${s.name}: ${myResult?.outcome ?? "unknown"}`,
                description: myResult?.detail ?? "Sweep ran.",
                timeout: 4000
              });
            }
          } catch (e) {
            toasts.add({
              title: "Force due failed",
              description: e instanceof Error ? e.message : String(e),
              timeout: 6000
            });
          }
        }}
        onConnectGoogle={async (token) => {
          try {
            const res = await agent.stub.setGoogleAccessToken(token);
            if (res.connected) {
              toasts.add({
                title: "📅 Calendar connected",
                description:
                  "Reading today's events. Sweep will defer non-urgent pages during meetings.",
                timeout: 4000
              });
            } else {
              toasts.add({
                title: "Token rejected",
                description:
                  res.error ?? "Google rejected the token. Make sure you copied a fresh one.",
                timeout: 6000
              });
            }
          } catch (e) {
            toasts.add({
              title: "Connect failed",
              description: e instanceof Error ? e.message : String(e),
              timeout: 6000
            });
          }
        }}
        onDisconnectGoogle={async () => {
          await agent.stub.setGoogleAccessToken(null);
          toasts.add({
            title: "Calendar disconnected",
            description: "Sweep will page everything regardless of meetings.",
            timeout: 3000
          });
        }}
        onRefreshCalendar={async () => {
          try {
            const status = await agent.stub.refreshCalendarStatus();
            if (!status) {
              toasts.add({
                title: "Not connected",
                description: "Connect Google Calendar first.",
                timeout: 4000
              });
              return;
            }
            toasts.add({
              title: status.busyNow ? "Busy" : "Free now",
              description: status.busyNow
                ? `${status.busyTitle} until ${
                    status.busyUntil
                      ? new Date(status.busyUntil).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit"
                        })
                      : "?"
                  }`
                : "No meeting blocking pages right now.",
              timeout: 4000
            });
          } catch (e) {
            toasts.add({
              title: "Calendar refresh failed",
              description: e instanceof Error ? e.message : String(e),
              timeout: 6000
            });
          }
        }}
        onVerifyWebhook={async () => {
          try {
            const res = await agent.stub.verifyAndEnsurePdWebhook(
              window.location.origin
            );
            if (res.status === "ok") {
              toasts.add({
                title: "Webhook ✓",
                description: "Subscription is live in PagerDuty.",
                timeout: 3000
              });
            } else if (res.status === "re-enabled") {
              toasts.add({
                title: "Webhook re-enabled",
                description:
                  "PagerDuty had disabled it after delivery failures. Back online.",
                timeout: 5000
              });
            } else if (res.status === "created") {
              toasts.add({
                title: "Webhook created",
                description: `Now subscribed: ${res.url}`,
                timeout: 4000
              });
            } else if (res.status === "unsupported-origin") {
              toasts.add({
                title: "Deploy first",
                description: res.message,
                timeout: 0
              });
            } else {
              toasts.add({
                title: "Webhook setup failed",
                description: res.message ?? "Unknown error",
                timeout: 6000
              });
            }
          } catch (e) {
            toasts.add({
              title: "Webhook setup failed",
              description: e instanceof Error ? e.message : String(e),
              timeout: 6000
            });
          }
        }}
        onRunSweep={async () => {
          try {
            const res = await agent.stub.runCadenceSweep();
            if (res && res.fired > 0) {
              toasts.add({
                title: `Sweep paged ${res.fired}`,
                description: `Overdue: ${res.firedNames.join(", ")}`,
                timeout: 5000
              });
            } else {
              toasts.add({
                title: "Sweep clean",
                description: `Checked ${res?.checked ?? 0} services. Nothing overdue.`,
                timeout: 3000
              });
            }
          } catch (e) {
            toasts.add({
              title: "Sweep failed",
              description: e instanceof Error ? e.message : String(e),
              timeout: 6000
            });
          }
        }}
        onDeploy={(s) => {
          sendMessage({
            role: "user",
            parts: [
              {
                type: "text",
                text: `Deploy "${s.name}" to PagerDuty. Generate the witty escalation policy yourself — it always defaults to paging only me.`
              }
            ]
          });
        }}
      />
      <div
        className="flex-1 flex flex-col relative min-w-0"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-kumo-elevated/80 backdrop-blur-sm border-2 border-dashed border-kumo-brand rounded-xl m-2 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-kumo-brand">
            <ImageIcon size={40} />
            <Text variant="heading3">Drop images here</Text>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/logo.svg"
              alt="Life Ops"
              className="h-8 w-8 shrink-0"
            />
            <div className="flex flex-col">
              <h1 className="text-lg font-semibold text-kumo-default leading-tight">
                Life Ops
              </h1>
              <Text size="xs" variant="secondary">
                SRE for the people you care about
              </Text>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Tell me who and what matters"
              contents={
                <div className="flex flex-wrap justify-center gap-2">
                  {[
                    "Mom in Slovenia, dentist every 6 months, plants twice a week",
                    "Help me set up Life Ops",
                    "What should I track?"
                  ].map((prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      size="sm"
                      disabled={isStreaming}
                      onClick={() => {
                        sendMessage({
                          role: "user",
                          parts: [{ type: "text", text: prompt }]
                        });
                      }}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {/* Tool parts */}
                {message.parts.filter(isToolUIPart).map((part) => (
                  <ToolPartView
                    key={part.toolCallId}
                    part={part}
                    addToolApprovalResponse={addToolApprovalResponse}
                  />
                ))}

                {/* Reasoning parts */}
                {message.parts
                  .filter(
                    (part) =>
                      part.type === "reasoning" &&
                      (part as { text?: string }).text?.trim()
                  )
                  .map((part, i) => {
                    const reasoning = part as {
                      type: "reasoning";
                      text: string;
                      state?: "streaming" | "done";
                    };
                    const isDone = reasoning.state === "done" || !isStreaming;
                    return (
                      <div key={i} className="flex justify-start">
                        <details className="max-w-[85%] w-full" open={!isDone}>
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                            <BrainIcon size={14} className="text-purple-400" />
                            <span className="font-medium text-kumo-default">
                              Reasoning
                            </span>
                            {isDone ? (
                              <span className="text-xs text-kumo-success">
                                Complete
                              </span>
                            ) : (
                              <span className="text-xs text-kumo-brand">
                                Thinking...
                              </span>
                            )}
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-inactive"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                            {reasoning.text}
                          </pre>
                        </details>
                      </div>
                    );
                  })}

                {/* Image parts */}
                {message.parts
                  .filter(
                    (part): part is Extract<typeof part, { type: "file" }> =>
                      part.type === "file" &&
                      (part as { mediaType?: string }).mediaType?.startsWith(
                        "image/"
                      ) === true
                  )
                  .map((part, i) => (
                    <div
                      key={`file-${i}`}
                      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                    >
                      <img
                        src={part.url}
                        alt="Attachment"
                        className="max-h-64 rounded-xl border border-kumo-line object-contain"
                      />
                    </div>
                  ))}

                {/* Text parts */}
                {message.parts
                  .filter((part) => part.type === "text")
                  .map((part, i) => {
                    const text = (part as { type: "text"; text: string }).text;
                    if (!text) return null;

                    if (isUser) {
                      return (
                        <div key={i} className="flex justify-end">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                            {text}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={i} className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <Streamdown
                            className="sd-theme rounded-2xl rounded-bl-md p-3"
                            plugins={{ code }}
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {attachments.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="relative group rounded-lg border border-kumo-line bg-kumo-control overflow-hidden"
                >
                  <img
                    src={att.preview}
                    alt={att.file.name}
                    className="h-16 w-16 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="absolute top-0.5 right-0.5 rounded-full bg-kumo-contrast/80 text-kumo-inverse p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={`Remove ${att.file.name}`}
                  >
                    <XIcon size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <Button
              type="button"
              variant="ghost"
              shape="square"
              aria-label="Attach images"
              icon={<PaperclipIcon size={18} />}
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || isStreaming}
              className="mb-0.5"
            />
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              onPaste={handlePaste}
              placeholder={
                attachments.length > 0
                  ? "Add a message or send images..."
                  : "Send a message..."
              }
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={
                  (!input.trim() && attachments.length === 0) || !connected
                }
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
      </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
