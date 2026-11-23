import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  startObservation,
  type LangfuseSpan,
  type LangfuseAgent,
  type LangfuseGeneration,
  type LangfuseTool,
} from "@langfuse/tracing";
import { LangfuseOtelSpanAttributes } from "@langfuse/core";
import { LitefuseExporter } from "./litefuse-exporter.js";
import type { LitefusePluginConfig } from "./litefuse-exporter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeClone<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

const MAX_ATTR_LENGTH = 3_200_000;

function truncateAttr(value: string): string {
  return value.length > MAX_ATTR_LENGTH
    ? value.substring(0, MAX_ATTR_LENGTH)
    : value;
}

function toSpecParts(content: any): any[] {
  if (content === undefined || content === null) return [];

  if (typeof content === "string") {
    return [{ type: "text", content }];
  }

  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") {
        return { type: "text", content: item };
      }
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, any>;
        if (obj.type === "toolCall" || obj.type === "tool_call" || obj.type === "function_call") {
          return {
            type: "tool_call",
            id: obj.id || obj.toolCallId || null,
            name: obj.name || obj.toolName || "",
            arguments: obj.arguments || obj.input || obj.params || null,
          };
        }
        if (obj.type === "toolResult" || obj.type === "tool_result" || obj.type === "tool_call_response") {
          const resp = obj.response ?? obj.result ?? obj.content ?? "";
          return {
            type: "tool_call_response",
            id: obj.id || obj.toolCallId || null,
            response: typeof resp === "string" ? resp : JSON.stringify(resp),
          };
        }
        if (obj.type === "text") {
          return { type: "text", content: String(obj.content ?? obj.text ?? "") };
        }
        if (obj.type === "thinking" || obj.type === "reasoning") {
          return { type: "reasoning", content: String(obj.content ?? obj.thinking ?? "") };
        }
        if (obj.type) return obj;
        return { type: "text", content: JSON.stringify(item) };
      }
      return { type: "text", content: String(item) };
    });
  }

  return [{ type: "text", content: JSON.stringify(content) }];
}

const ROLE_MAP: Record<string, string> = {
  toolResult: "tool",
  tool_result: "tool",
  function: "tool",
};

function buildInputMessages(historyMessages: any[], userPrompt?: string, systemPrompt?: string): any[] {
  const result: any[] = [];
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }
  for (const msg of historyMessages) {
    const role = ROLE_MAP[msg.role] || msg.role;
    const parts = toSpecParts(msg.content);
    const textParts = parts.filter((p) => p.type === "text" || p.type === "reasoning");
    const content = textParts.length
      ? textParts.map((p) => p.content || "").join("\n")
      : JSON.stringify(parts);
    result.push({ role, content });
  }
  if (userPrompt) {
    result.push({ role: "user", content: userPrompt });
  }
  return result;
}

function buildOutputMessages(assistantTexts: string[], finishReason = "stop"): any[] {
  return assistantTexts.map((text) => ({
    role: "assistant",
    content: text,
    finish_reason: finishReason,
  }));
}

function normalizeChannelId(input: string): string {
  if (!input || input === "unknown") return "system/unknown";
  if (input.includes("/")) return input;
  if (/^agent[_:]/.test(input)) return `agent/${input.slice(6)}`;
  return `system/${input}`;
}

function resolveChannelId(ctx?: Record<string, any>, eventFrom?: string): string {
  const safeCtx = ctx || {};
  const raw =
    safeCtx.sessionKey ||
    safeCtx.channelId ||
    safeCtx.conversationId ||
    safeCtx.sessionId ||
    eventFrom ||
    "unknown";
  return normalizeChannelId(raw);
}

function resolveSessionKey(ctx?: Record<string, any>, event?: Record<string, any>): string | undefined {
  const raw = ctx?.sessionKey ?? event?.sessionKey;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function resolveExplicitSessionId(
  ctx?: Record<string, any>,
  event?: Record<string, any>
): string | undefined {
  const raw = event?.sessionId ?? ctx?.sessionId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Per-turn state
// ---------------------------------------------------------------------------

interface TurnContext {
  runId: string;
  turnId: string;
  channelId: string;
  originalChannelId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  userInput?: any;
  lastOutput?: any;

  // The root span carries trace-level attributes (TRACE_NAME, TRACE_USER_ID,
  // TRACE_INPUT, etc.) and is the parent of all per-turn observations.
  rootSpan?: LangfuseSpan;
  rootSpanStartTime?: number;

  // The agent span (when an agent runs) — parent of tool/generation spans
  // produced during that agent's invocation.
  agentSpan?: LangfuseAgent;
  agentStartTime?: number;

  // Currently-open generation (linked to the pending llm_input/llm_output).
  // Per-runId state lives in llmObsByRunId for late-arriving llm_output.
  llmSpan?: LangfuseGeneration;
  llmStartTime?: number;
}

interface PendingToolCall {
  toolCallId?: string;
  toolName: string;
  toolSpan: LangfuseTool;
  toolStartTime: number;
  toolInput: any;
  turnCtx: TurnContext;
  channelId: string;
}

interface LlmRunState {
  generation: LangfuseGeneration;
  startTime: number;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function activate(api: OpenClawPluginApi): void {
  const pluginConfig = (api.pluginConfig || {}) as Record<string, any>;

  if (!pluginConfig.targets && !pluginConfig.publicKey) {
    api.logger.error("[Litefuse] Missing required configuration: 'publicKey' or 'targets' must be provided");
    return;
  }
  if (!pluginConfig.targets && !pluginConfig.secretKey) {
    api.logger.error("[Litefuse] Missing required configuration: 'secretKey' or 'targets' must be provided");
    return;
  }

  const config: LitefusePluginConfig = {
    publicKey: pluginConfig.publicKey,
    secretKey: pluginConfig.secretKey,
    baseUrl: pluginConfig.baseUrl,
    debug: pluginConfig.debug || false,
    enabledHooks: pluginConfig.enabledHooks,
    targets: pluginConfig.targets,
    tags: pluginConfig.tags,
    environment: pluginConfig.environment,
    userId: pluginConfig.userId,
  };

  const exporter = new LitefuseExporter(api, config);
  const tags = config.tags || ["openclaw"];

  // -- Per-turn and per-session state --------------------------------------
  const contextByChannelId = new Map<string, TurnContext>();
  const contextByRunId = new Map<string, TurnContext>();
  const llmObsByRunId = new Map<string, LlmRunState>();
  // Persists sessionKey -> sessionId across turns within a session because
  // session_start only fires once per session while agent_end clears per-turn state.
  const sessionIdByKey = new Map<string, string>();
  const pendingToolCallsById = new Map<string, PendingToolCall>();

  let lastUserChannelId: string | undefined;
  let lastUserTurnContext: TurnContext | undefined;
  let pendingToolCall: PendingToolCall | undefined;

  const openclawVersion =
    (api.config as any)?.meta?.lastTouchedVersion || (api as any).runtime?.version || "unknown";

  const shouldHookEnabled = (hookName: string): boolean => {
    if (!config.enabledHooks) return true;
    return config.enabledHooks.includes(hookName);
  };

  // -- Session helpers -----------------------------------------------------
  const getEffectiveSessionId = (ctx: TurnContext): string | undefined => {
    if (ctx.sessionId) return ctx.sessionId;
    if (ctx.sessionKey) {
      const mapped = sessionIdByKey.get(ctx.sessionKey);
      if (mapped) {
        ctx.sessionId = mapped;
        return mapped;
      }
      return ctx.sessionKey;
    }
    return undefined;
  };

  const applySessionAttributes = (
    span: LangfuseSpan | LangfuseAgent | LangfuseGeneration | LangfuseTool,
    sessionId: string,
    sessionKey?: string
  ): void => {
    span.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, sessionId);
    span.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_COMPAT_SESSION_ID, sessionId);
    span.otelSpan.setAttribute("openclaw.session.id", sessionId);
    if (sessionKey) {
      span.otelSpan.setAttribute("openclaw.session.key", sessionKey);
    }
  };

  const syncSessionInfo = (
    ctx: TurnContext,
    hookCtx?: Record<string, any>,
    event?: Record<string, any>,
    options: { updateRootSpan?: boolean } = {}
  ): string | undefined => {
    const sessionKey = resolveSessionKey(hookCtx, event);
    if (sessionKey) {
      ctx.sessionKey = sessionKey;
    }

    const explicitSessionId = resolveExplicitSessionId(hookCtx, event);
    if (explicitSessionId) {
      ctx.sessionId = explicitSessionId;
      if (ctx.sessionKey) {
        sessionIdByKey.set(ctx.sessionKey, explicitSessionId);
      }
    }

    const effectiveSessionId = getEffectiveSessionId(ctx);
    if (effectiveSessionId && options.updateRootSpan !== false) {
      if (ctx.rootSpan) {
        applySessionAttributes(ctx.rootSpan, effectiveSessionId, ctx.sessionKey);
      }
      if (ctx.agentSpan) {
        applySessionAttributes(ctx.agentSpan, effectiveSessionId, ctx.sessionKey);
      }
      if (lastUserTurnContext && lastUserTurnContext !== ctx) {
        if (!lastUserTurnContext.sessionKey && ctx.sessionKey) {
          lastUserTurnContext.sessionKey = ctx.sessionKey;
        }
        if (explicitSessionId || (!lastUserTurnContext.sessionId && ctx.sessionId)) {
          lastUserTurnContext.sessionId = explicitSessionId || ctx.sessionId;
        }
        if (lastUserTurnContext.rootSpan) {
          applySessionAttributes(
            lastUserTurnContext.rootSpan,
            effectiveSessionId,
            lastUserTurnContext.sessionKey || ctx.sessionKey
          );
        }
        if (lastUserTurnContext.agentSpan) {
          applySessionAttributes(
            lastUserTurnContext.agentSpan,
            effectiveSessionId,
            lastUserTurnContext.sessionKey || ctx.sessionKey
          );
        }
      }
    }

    return effectiveSessionId;
  };

  // -- Context lookup / linking --------------------------------------------
  const getContextByChannel = (channelId: string) => contextByChannelId.get(channelId);
  const getContextByRun = (runId: string) => contextByRunId.get(runId);
  const getOriginalChannelId = (runId: string): string | undefined => {
    const ctx = contextByRunId.get(runId);
    return ctx?.originalChannelId || ctx?.channelId;
  };

  const startTurn = (runId: string, channelId: string, originalChannelId?: string): TurnContext => {
    const ctx: TurnContext = {
      runId,
      turnId: runId,
      channelId,
      originalChannelId: originalChannelId || channelId,
    };
    contextByChannelId.set(channelId, ctx);
    contextByRunId.set(runId, ctx);
    return ctx;
  };

  const endTurn = (channelId: string): void => {
    const ctx = contextByChannelId.get(channelId);
    if (ctx) {
      contextByChannelId.delete(channelId);
      contextByRunId.delete(ctx.runId);
      for (const [mappedRunId, mappedCtx] of contextByRunId.entries()) {
        if (mappedCtx === ctx) {
          contextByRunId.delete(mappedRunId);
        }
      }
    }
  };

  const getOrCreateContext = (
    rawChannelId: string,
    runId?: string,
    hookName?: string
  ): { ctx: TurnContext; channelId: string; isNew: boolean } => {
    let channelId = rawChannelId;
    let activeCtx: TurnContext | undefined;

    const existingChannelCtx = getContextByChannel(rawChannelId);
    const effectiveRunId = runId || existingChannelCtx?.runId || `run-${Date.now()}`;

    // For agent events, prefer lastUserTurnContext (most recent user message)
    // unless rawChannelId already owns a distinct active turn with its own rootSpan.
    if (
      rawChannelId.startsWith("agent/") &&
      lastUserTurnContext &&
      (!existingChannelCtx || !existingChannelCtx.rootSpan || existingChannelCtx === lastUserTurnContext)
    ) {
      activeCtx = lastUserTurnContext;
      channelId = lastUserChannelId || channelId;
      if (existingChannelCtx && existingChannelCtx !== activeCtx) {
        if (!activeCtx.sessionKey && existingChannelCtx.sessionKey) {
          activeCtx.sessionKey = existingChannelCtx.sessionKey;
        }
        if (!activeCtx.sessionId && existingChannelCtx.sessionId) {
          activeCtx.sessionId = existingChannelCtx.sessionId;
        }
      }
      contextByChannelId.set(rawChannelId, activeCtx);
      contextByRunId.set(effectiveRunId, activeCtx);

      if (config.debug) {
        api.logger.info(
          `[Litefuse] LINKING agent to user context: hook=${hookName}, agentChannel=${rawChannelId}, userChannel=${channelId}`
        );
      }
    }

    if (!activeCtx) {
      activeCtx = existingChannelCtx;
    }

    if (rawChannelId.startsWith("agent/") && !activeCtx && effectiveRunId) {
      const originalChannelId = getOriginalChannelId(effectiveRunId);
      if (originalChannelId) {
        channelId = originalChannelId;
        activeCtx = getContextByChannel(originalChannelId) || activeCtx;
      }
    }

    if (!activeCtx) {
      activeCtx = getContextByRun(effectiveRunId);
    }

    // Fallback: link to last user trace for processing hooks. Handles
    // platforms (e.g. TUI) where hookCtx resolves to a different channelId
    // than message_received used.
    if (
      !activeCtx &&
      lastUserTurnContext &&
      hookName &&
      hookName !== "message_received" &&
      hookName !== "gateway_start"
    ) {
      activeCtx = lastUserTurnContext;
      channelId = lastUserChannelId || channelId;
      contextByChannelId.set(rawChannelId, activeCtx);
      contextByRunId.set(effectiveRunId, activeCtx);

      if (config.debug) {
        api.logger.info(
          `[Litefuse] FALLBACK LINKING to user context: hook=${hookName}, rawChannel=${rawChannelId}, userChannel=${channelId}`
        );
      }
    }

    let isNew = false;
    if (!activeCtx) {
      activeCtx = startTurn(effectiveRunId, channelId, rawChannelId !== channelId ? rawChannelId : undefined);
      isNew = true;

      if (config.debug) {
        api.logger.info(
          `[Litefuse] NEW TurnContext: hook=${hookName}, channelId=${channelId}, runId=${effectiveRunId}`
        );
      }
    } else {
      if (runId) {
        contextByRunId.set(runId, activeCtx);
      }
      if (config.debug) {
        api.logger.info(
          `[Litefuse] REUSING TurnContext: hook=${hookName}, channelId=${channelId}`
        );
      }
    }

    return { ctx: activeCtx, channelId, isNew };
  };

  // -- Root & agent span helpers -------------------------------------------
  const ensureRootSpan = (ctx: TurnContext, channelId: string, options: Record<string, any> = {}): void => {
    if (ctx.rootSpan) return;

    const now = Date.now();
    ctx.rootSpanStartTime = now;

    // Use the user message content as the initial trace-level input. Other
    // identity fields (TRACE_NAME, TRACE_USER_ID, TRACE_SESSION_ID) are set
    // immediately after creation since they depend on the generated traceId.
    const span = startObservation(
      "enter_openclaw_system",
      {
        input: ctx.userInput,
        environment: config.environment,
      },
      { startTime: new Date(now) }
    );

    const userId = options.userId ?? "unknown";
    const rawUserId = options.rawUserId;
    const traceUserId = config.userId && rawUserId
      ? `${config.userId}/${rawUserId}`
      : config.userId || rawUserId || userId;
    const effectiveSessionId = getEffectiveSessionId(ctx);

    span.otelSpan.setAttribute(LangfuseOtelSpanAttributes.AS_ROOT, true);
    span.otelSpan.setAttribute(
      LangfuseOtelSpanAttributes.TRACE_NAME,
      `openclaw-${span.traceId.slice(0, 8)}`
    );
    if (traceUserId) {
      span.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, String(traceUserId));
    }
    if (effectiveSessionId) {
      applySessionAttributes(span, effectiveSessionId, ctx.sessionKey);
    }
    if (tags.length) {
      span.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, tags);
    }
    span.otelSpan.setAttributes({
      "gen_ai.operation.name": "enter",
      "gen_ai.user.id": String(userId),
      "openclaw.session.id": effectiveSessionId || channelId,
      "openclaw.run.id": ctx.runId,
      "openclaw.turn.id": ctx.turnId,
      "openclaw.message.role": options.role || "unknown",
      "openclaw.message.from": options.from || "unknown",
      "openclaw.version": openclawVersion,
      "openclaw.channel.id": channelId,
    });
    if (ctx.sessionKey) {
      span.otelSpan.setAttribute("openclaw.session.key", ctx.sessionKey);
    }

    ctx.rootSpan = span;

    if (config.debug) {
      api.logger.info(`[Litefuse] Started root span: traceId=${span.traceId}, spanId=${span.id}`);
    }
  };

  const ensureAgentSpan = (
    ctx: TurnContext,
    channelId: string,
    agentId: string,
    startTime = Date.now()
  ): LangfuseAgent => {
    // Only first agent start per turn gets a real agent span; subsequent fires
    // (e.g. before_model_resolve + before_prompt_build, or nested agents)
    // reuse the existing one to preserve one agent observation per turn.
    if (ctx.agentSpan) return ctx.agentSpan;

    ctx.agentId = agentId;
    ctx.agentStartTime = startTime;

    const agentInput = ctx.userInput || lastUserTurnContext?.userInput;
    const parent = ctx.rootSpan;
    const effectiveSessionId = getEffectiveSessionId(ctx);
    const agentAttrs: any = {
      input: agentInput,
      environment: config.environment,
    };
    const agentOpts = { asType: "agent" as const, startTime: new Date(startTime) };
    const agentSpan = parent
      ? parent.startObservation(`invoke_agent ${agentId}`, agentAttrs, agentOpts)
      : startObservation(`invoke_agent ${agentId}`, agentAttrs, agentOpts);

    agentSpan.otelSpan.setAttributes({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "openclaw",
      "gen_ai.agent.id": agentId,
      "gen_ai.agent.name": agentId,
      "openclaw.session.id": effectiveSessionId || channelId,
      "openclaw.run.id": ctx.runId,
      "openclaw.turn.id": ctx.turnId,
      "openclaw.channel.id": channelId,
      "openclaw.version": openclawVersion,
    });
    if (ctx.sessionKey) {
      agentSpan.otelSpan.setAttribute("openclaw.session.key", ctx.sessionKey);
    }
    if (effectiveSessionId) {
      applySessionAttributes(agentSpan, effectiveSessionId, ctx.sessionKey);
    }

    ctx.agentSpan = agentSpan;

    if (config.debug) {
      api.logger.info(`[Litefuse] Started agent span: ${agentId}, spanId=${agentSpan.id}`);
    }
    return agentSpan;
  };

  const handleAgentStart = (event: any, hookCtx: any, hookName: string): void => {
    const safeEvent = event || {};
    const safeCtx = hookCtx || {};
    const rawChannelId = resolveChannelId(safeCtx, safeEvent.sessionId);
    const agentId = safeCtx.agentId || safeEvent.agentId || "openclaw";
    const runId = safeCtx.runId || safeEvent.runId;
    const { ctx, channelId } = getOrCreateContext(rawChannelId, runId, hookName);

    syncSessionInfo(ctx, safeCtx, safeEvent);

    if (!ctx.userInput && typeof safeEvent.prompt === "string" && safeEvent.prompt) {
      ctx.userInput = safeEvent.prompt;
    }

    const rawUserId = safeCtx.senderId || safeEvent.from || safeCtx.trigger || undefined;
    ensureRootSpan(ctx, channelId, {
      userId: rawUserId || "system",
      rawUserId,
      role: safeCtx.trigger || "system",
      from: safeEvent.from || agentId,
    });

    if (ctx.rootSpan && ctx.userInput !== undefined) {
      ctx.rootSpan.update({ input: ctx.userInput });
    }

    ensureAgentSpan(ctx, channelId, agentId);
  };

  const parentForChildren = (ctx: TurnContext): LangfuseSpan | LangfuseAgent | undefined => {
    return ctx.agentSpan || ctx.rootSpan;
  };

  // -- Hooks --------------------------------------------------------------

  api.on("gateway_stop", async () => {
    await exporter.forceFlush();
    await exporter.shutdown();
  });

  if (shouldHookEnabled("gateway_start")) {
    api.on("gateway_start", async (event: any) => {
      // One-shot event with no parent context — emit as an isolated span.
      const span = startObservation(
        "gateway_start",
        {
          metadata: { "gateway.port": event.port || 0 },
          environment: config.environment,
        },
        { asType: "event" }
      );
      span.otelSpan.setAttribute(LangfuseOtelSpanAttributes.AS_ROOT, true);
      span.otelSpan.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_NAME,
        `gateway-${span.traceId.slice(0, 8)}`
      );
      if (tags.length) {
        span.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, tags);
      }
      span.otelSpan.setAttribute("openclaw.version", openclawVersion);
      span.end();
    });
  }

  if (shouldHookEnabled("session_start")) {
    api.on("session_start", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      const rawChannelId = resolveChannelId(safeCtx, safeEvent.sessionId);
      const { ctx, isNew } = getOrCreateContext(rawChannelId, safeCtx.runId || safeEvent.runId, "session_start");

      // Same rationale as v3: persist sessionId on the trace only when reusing
      // an existing user context, to avoid ghost traces with sessionId but no
      // userId. Always record sessionKey -> sessionId for subsequent turns.
      const effectiveSessionId = syncSessionInfo(ctx, safeCtx, safeEvent, {
        updateRootSpan: !isNew,
      });

      const parent = parentForChildren(ctx);
      const metadata: Record<string, any> = { "event.type": "session_start" };
      if (safeEvent.reason) metadata["session.reason"] = safeEvent.reason;
      if (safeEvent.resumedFrom) metadata["session.resumed_from"] = safeEvent.resumedFrom;

      const evtAttrs: any = {
        metadata,
        environment: config.environment,
      };
      const opts = { asType: "event" as const };
      const evt = parent
        ? parent.startObservation("session_start", evtAttrs, opts)
        : startObservation("session_start", evtAttrs, opts);
      if (effectiveSessionId) {
        evt.otelSpan.setAttribute("openclaw.session.id", effectiveSessionId);
      }
      if (ctx.sessionKey) {
        evt.otelSpan.setAttribute("openclaw.session.key", ctx.sessionKey);
      }
      evt.end();
    });
  }

  if (shouldHookEnabled("session_end")) {
    api.on("session_end", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      const rawChannelId = resolveChannelId(safeCtx, safeEvent.sessionId);
      const { ctx, channelId, isNew } = getOrCreateContext(
        rawChannelId,
        safeCtx.runId || safeEvent.runId,
        "session_end"
      );

      const effectiveSessionId = syncSessionInfo(ctx, safeCtx, safeEvent, {
        updateRootSpan: !isNew,
      });

      const parent = parentForChildren(ctx);
      const metadata: Record<string, any> = {
        "session.duration_ms": safeEvent.durationMs || 0,
        "session.message_count": safeEvent.messageCount || 0,
      };
      if (safeEvent.reason) metadata["session.reason"] = safeEvent.reason;

      const evtAttrs: any = {
        metadata,
        output: {
          messageCount: safeEvent.messageCount,
          durationMs: safeEvent.durationMs,
          ...(safeEvent.reason ? { reason: safeEvent.reason } : {}),
        },
        environment: config.environment,
      };
      const opts = { asType: "event" as const };
      const evt = parent
        ? parent.startObservation("session_end", evtAttrs, opts)
        : startObservation("session_end", evtAttrs, opts);
      if (effectiveSessionId) {
        evt.otelSpan.setAttribute("openclaw.session.id", effectiveSessionId);
      }
      if (ctx.sessionKey) {
        evt.otelSpan.setAttribute("openclaw.session.key", ctx.sessionKey);
      }
      evt.end();

      const endedSessionKey = resolveSessionKey(safeCtx, safeEvent) || ctx.sessionKey;
      if (endedSessionKey) {
        sessionIdByKey.delete(endedSessionKey);
      }
      endTurn(channelId);
    });
  }

  if (shouldHookEnabled("message_received")) {
    api.on("message_received", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      const rawChannelId = resolveChannelId(safeCtx, safeEvent.from || safeEvent.metadata?.senderId);
      const { ctx, channelId } = getOrCreateContext(
        rawChannelId,
        safeCtx.runId || safeEvent.runId,
        "message_received"
      );

      syncSessionInfo(ctx, safeCtx, safeEvent);

      let role = safeEvent.role;
      if (!role && safeEvent.from) role = "user";

      const isUserMessage = !rawChannelId.startsWith("agent/");

      if (isUserMessage) {
        if (!role) role = "user";
        lastUserChannelId = channelId;
        lastUserTurnContext = ctx;
        ctx.userInput = safeEvent.content;

        const rawUserId = safeEvent.from || safeEvent.metadata?.senderId;
        ensureRootSpan(ctx, channelId, {
          userId: rawUserId || "unknown",
          rawUserId,
          role,
          from: safeEvent.from,
        });

        if (ctx.rootSpan) {
          ctx.rootSpan.update({ input: safeEvent.content });
        }
      }
    });
  }

  if (shouldHookEnabled("message_sending")) {
    api.on("message_sending", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      if (lastUserTurnContext) {
        lastUserTurnContext.lastOutput = safeEvent.content;
        syncSessionInfo(lastUserTurnContext, safeCtx, safeEvent);
      } else {
        const rawChannelId = resolveChannelId(safeCtx, safeEvent.to);
        const { ctx } = getOrCreateContext(rawChannelId, safeCtx.runId, "message_sending");
        ctx.lastOutput = safeEvent.content;
        syncSessionInfo(ctx, safeCtx, safeEvent);
      }
    });
  }

  if (shouldHookEnabled("message_sent")) {
    api.on("message_sent", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      if (safeEvent.content && safeEvent.success) {
        if (lastUserTurnContext) {
          lastUserTurnContext.lastOutput = safeEvent.content;
          syncSessionInfo(lastUserTurnContext, safeCtx, safeEvent);
        } else {
          const rawChannelId = resolveChannelId(safeCtx, safeEvent.to);
          const { ctx } = getOrCreateContext(rawChannelId, safeCtx.runId, "message_sent");
          ctx.lastOutput = safeEvent.content;
          syncSessionInfo(ctx, safeCtx, safeEvent);
        }
      }
    });
  }

  if (shouldHookEnabled("llm_input")) {
    api.on("llm_input", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      const rawChannelId = resolveChannelId(safeCtx, safeEvent.sessionId);
      const runId = safeEvent.runId || safeCtx.runId;
      const { ctx, channelId } = getOrCreateContext(rawChannelId, runId, "llm_input");

      const effectiveSessionId = syncSessionInfo(ctx, safeCtx, safeEvent);

      if (!ctx.userInput && safeEvent.prompt) {
        ctx.userInput = safeEvent.prompt;
      }

      // Ensure root & agent spans exist even if earlier lifecycle hooks did not
      // fire (e.g., OpenClaw 2.0 Web/Control UI turns when pre-prompt hooks are
      // skipped or restricted).
      const rawLlmUserId =
        safeCtx.senderId || safeCtx.trigger || safeEvent.from || safeEvent.metadata?.senderId || undefined;
      if (!ctx.rootSpan) {
        ensureRootSpan(ctx, channelId, {
          userId: rawLlmUserId || "system",
          rawUserId: rawLlmUserId,
          role: safeCtx.trigger || "user",
          from: safeEvent.from || safeCtx.agentId || "openclaw",
        });
      } else {
        // Trace-level userId from llm context, in case message_received didn't
        // set it (e.g., agent-only invocations).
        const userId = config.userId && rawLlmUserId
          ? `${config.userId}/${rawLlmUserId}`
          : config.userId || rawLlmUserId;
        if (userId) {
          ctx.rootSpan.otelSpan.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_USER_ID,
            String(userId)
          );
        }
      }

      const agentId = safeCtx.agentId || safeEvent.agentId || ctx.agentId || "openclaw";
      if (!ctx.agentSpan) {
        ensureAgentSpan(ctx, channelId, agentId);
      }

      const now = Date.now();
      const historyMsgs = safeEvent.historyMessages?.length
        ? safeEvent.historyMessages.map((msg: any) => safeClone(msg))
        : [];
      const inputMessages = buildInputMessages(historyMsgs, safeEvent.prompt, safeEvent.systemPrompt);

      // Truncate via the LangfuseOtelSpanAttributes path — the SDK
      // JSON.stringifies whatever we hand it, so pre-serialize and clamp.
      const serializedInput = truncateAttr(JSON.stringify(inputMessages));

      const parent = parentForChildren(ctx);
      const genName = `chat ${safeEvent.model || "unknown"}`;
      const genAttrs = {
        model: safeEvent.model || "unknown",
        input: inputMessages,
        environment: config.environment,
      } as const;
      const genOpts = { asType: "generation" as const, startTime: new Date(now) };

      const generation = parent
        ? parent.startObservation(genName, genAttrs, genOpts)
        : startObservation(genName, genAttrs, genOpts);

      generation.otelSpan.setAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": safeEvent.provider,
        "gen_ai.request.model": safeEvent.model,
        "gen_ai.response.model": safeEvent.model,
        "openclaw.session.id": effectiveSessionId || channelId,
        "openclaw.run.id": ctx.runId,
        "openclaw.turn.id": ctx.turnId,
        "openclaw.channel.id": channelId,
        "openclaw.version": openclawVersion,
      });
      if (effectiveSessionId) {
        applySessionAttributes(generation, effectiveSessionId, ctx.sessionKey);
      } else if (ctx.sessionKey) {
        generation.otelSpan.setAttribute("openclaw.session.key", ctx.sessionKey);
      }
      if (safeEvent.systemPrompt) {
        generation.otelSpan.setAttribute(
          "gen_ai.system_instructions",
          truncateAttr(JSON.stringify([{ type: "text", content: safeEvent.systemPrompt }]))
        );
      }
      generation.otelSpan.setAttribute("gen_ai.input.messages", serializedInput);

      ctx.llmSpan = generation;
      ctx.llmStartTime = now;
      if (runId) {
        llmObsByRunId.set(runId, { generation, startTime: now });
      }

      if (config.debug) {
        api.logger.info(
          `[Litefuse] LLM input started: ${safeEvent.provider}/${safeEvent.model}, runId=${runId}, spanId=${generation.id}`
        );
      }
    });
  }

  if (shouldHookEnabled("llm_output")) {
    api.on("llm_output", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      const rawChannelId = resolveChannelId(safeCtx, safeEvent.sessionId);
      const runId = safeEvent.runId || safeCtx.runId;
      const { ctx } = getOrCreateContext(rawChannelId, runId, "llm_output");

      const effectiveSessionId = syncSessionInfo(ctx, safeCtx, safeEvent);

      const now = Date.now();

      // Resolve the generation: ctx → per-runId map. If neither exists
      // (llm_output without prior llm_input) we silently skip — there's
      // no anchor to end against.
      const runState = runId ? llmObsByRunId.get(runId) : undefined;
      const generation = ctx.llmSpan || runState?.generation;
      if (!generation) {
        if (config.debug) {
          api.logger.warn(`[Litefuse] llm_output with no matching llm_input: runId=${runId}`);
        }
        return;
      }

      if (effectiveSessionId) {
        applySessionAttributes(generation, effectiveSessionId, ctx.sessionKey);
      }

      // Output text: prefer assistantTexts, fall back to lastAssistant.content
      let outputTexts: string[] = [];
      if (safeEvent.assistantTexts?.length) {
        outputTexts = safeEvent.assistantTexts;
      } else if (safeEvent.lastAssistant?.content) {
        for (const part of safeEvent.lastAssistant.content) {
          if (part.type === "text" && part.text) {
            const text = part.text.replace(/^\[\[reply_to_current\]\]\s*/, "");
            if (text) outputTexts.push(text);
          }
        }
      }

      if (outputTexts.length) {
        const outputText = outputTexts.join("\n");
        ctx.lastOutput = outputText;
        if (lastUserTurnContext) {
          lastUserTurnContext.lastOutput = outputText;
        }
      }

      const lastAssistantUsage = (safeEvent.lastAssistant as any)?.usage;
      const inputTokens = safeEvent.usage?.input ?? lastAssistantUsage?.input ?? 0;
      const outputTokens = safeEvent.usage?.output ?? lastAssistantUsage?.output ?? 0;
      const cacheReadTokens = safeEvent.usage?.cacheRead ?? lastAssistantUsage?.cacheRead ?? 0;
      const cacheCreationTokens = safeEvent.usage?.cacheWrite ?? lastAssistantUsage?.cacheWrite ?? 0;
      const hasUsage =
        inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0;

      const stopReason =
        typeof safeEvent.lastAssistant?.stopReason === "string"
          ? safeEvent.lastAssistant.stopReason
          : undefined;
      const outputMessages = outputTexts.length
        ? buildOutputMessages(outputTexts, stopReason || "stop")
        : undefined;

      const updatePayload: any = {};
      if (outputMessages) {
        updatePayload.output = outputMessages;
      }
      if (hasUsage) {
        // Keys deliberately match Litefuse's default-model-prices.json so the
        // server can compute cost per cache tier.
        updatePayload.usageDetails = {
          input: inputTokens,
          output: outputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheCreationTokens,
        };
      }
      generation.update(updatePayload);

      // Also stamp the OTel semantic-convention attributes that the v3
      // implementation provided — preserves any downstream code that reads
      // them off raw OTel spans.
      generation.otelSpan.setAttributes({
        "gen_ai.usage.input_tokens": inputTokens,
        "gen_ai.usage.output_tokens": outputTokens,
        "gen_ai.usage.total_tokens": inputTokens + outputTokens,
        "gen_ai.usage.cache_read.input_tokens": cacheReadTokens,
        "gen_ai.usage.cache_creation.input_tokens": cacheCreationTokens,
      });
      if (stopReason) {
        generation.otelSpan.setAttribute(
          "gen_ai.response.finish_reasons",
          JSON.stringify([stopReason])
        );
      }
      if (outputMessages) {
        generation.otelSpan.setAttribute(
          "gen_ai.output.messages",
          truncateAttr(JSON.stringify(outputMessages))
        );
      }

      generation.end(new Date(now));

      // Clear pointers
      const startedAt = runState?.startTime || ctx.llmStartTime || now;
      if (ctx.llmSpan === generation) {
        ctx.llmSpan = undefined;
        ctx.llmStartTime = undefined;
      }
      if (runId) llmObsByRunId.delete(runId);

      if (config.debug) {
        api.logger.info(
          `[Litefuse] Exported LLM generation: ${safeEvent.provider}/${safeEvent.model}, duration=${now - startedAt}ms`
        );
      }
    });
  }

  if (shouldHookEnabled("before_tool_call")) {
    api.on("before_tool_call", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      const rawChannelId = resolveChannelId(safeCtx, safeEvent.sessionId);
      const runId = safeEvent.runId || safeCtx.runId;
      const { ctx, channelId } = getOrCreateContext(rawChannelId, runId, "before_tool_call");

      const effectiveSessionId = syncSessionInfo(ctx, safeCtx, safeEvent);
      if (!ctx.rootSpan) {
        const rawToolUserId = safeCtx.senderId || safeCtx.trigger || undefined;
        ensureRootSpan(ctx, channelId, {
          userId: rawToolUserId || "system",
          rawUserId: rawToolUserId,
          role: safeCtx.trigger || "system",
          from: safeCtx.agentId || "openclaw",
        });
      }

      const now = Date.now();
      const parent = parentForChildren(ctx);
      const toolAttrs: any = {
        input: safeEvent.params,
        environment: config.environment,
      };
      const toolOpts = { asType: "tool" as const, startTime: new Date(now) };
      const toolSpan = parent
        ? parent.startObservation(`execute_tool ${safeEvent.toolName}`, toolAttrs, toolOpts)
        : startObservation(`execute_tool ${safeEvent.toolName}`, toolAttrs, toolOpts);

      toolSpan.otelSpan.setAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": safeEvent.toolName,
        "gen_ai.tool.type": "function",
        "openclaw.session.id": effectiveSessionId || channelId,
        "openclaw.run.id": ctx.runId,
        "openclaw.turn.id": ctx.turnId,
        "openclaw.channel.id": channelId,
        "openclaw.version": openclawVersion,
      });
      if (effectiveSessionId) {
        applySessionAttributes(toolSpan, effectiveSessionId, ctx.sessionKey);
      } else if (ctx.sessionKey) {
        toolSpan.otelSpan.setAttribute("openclaw.session.key", ctx.sessionKey);
      }
      if (safeEvent.params !== undefined) {
        toolSpan.otelSpan.setAttribute(
          "gen_ai.tool.call.arguments",
          truncateAttr(
            typeof safeEvent.params === "string"
              ? safeEvent.params
              : JSON.stringify(safeEvent.params)
          )
        );
      }

      const toolCallId =
        typeof safeEvent.toolCallId === "string" && safeEvent.toolCallId
          ? safeEvent.toolCallId
          : undefined;
      const entry: PendingToolCall = {
        toolCallId,
        toolName: safeEvent.toolName,
        toolSpan,
        toolStartTime: now,
        toolInput: safeEvent.params,
        turnCtx: ctx,
        channelId,
      };
      if (toolCallId) {
        pendingToolCallsById.set(toolCallId, entry);
      }
      pendingToolCall = entry;

      if (config.debug) {
        api.logger.info(`[Litefuse] Tool call started: ${safeEvent.toolName}, spanId=${toolSpan.id}`);
      }
    });
  }

  if (shouldHookEnabled("after_tool_call")) {
    api.on("after_tool_call", async (event: any, _hookCtx: any) => {
      const safeEvent = event || {};
      const toolCallId =
        typeof safeEvent.toolCallId === "string" && safeEvent.toolCallId
          ? safeEvent.toolCallId
          : undefined;

      let matched: PendingToolCall | undefined;
      if (toolCallId) {
        matched = pendingToolCallsById.get(toolCallId);
        if (matched) {
          pendingToolCallsById.delete(toolCallId);
          if (pendingToolCall === matched) {
            pendingToolCall = undefined;
          }
        }
      }
      if (!matched && pendingToolCall && pendingToolCall.toolName === safeEvent.toolName) {
        matched = pendingToolCall;
        pendingToolCall = undefined;
        if (matched.toolCallId) {
          pendingToolCallsById.delete(matched.toolCallId);
        }
      }
      if (!matched) {
        return;
      }

      const { toolName, toolSpan, toolStartTime } = matched;

      const now = Date.now();
      const durationMs = safeEvent.durationMs ?? now - toolStartTime;

      const updatePayload: any = {};
      if (safeEvent.error) {
        updatePayload.level = "ERROR";
        updatePayload.statusMessage = String(safeEvent.error);
      } else if (safeEvent.result !== undefined) {
        updatePayload.output = safeEvent.result;
      }
      toolSpan.update(updatePayload);

      toolSpan.otelSpan.setAttribute("tool.duration_ms", durationMs);
      if (safeEvent.error) {
        toolSpan.otelSpan.setAttribute("error.type", String(safeEvent.error));
      } else if (safeEvent.result !== undefined) {
        toolSpan.otelSpan.setAttribute(
          "gen_ai.tool.call.result",
          truncateAttr(
            typeof safeEvent.result === "string"
              ? safeEvent.result
              : JSON.stringify(safeEvent.result)
          )
        );
      }

      toolSpan.end(new Date(now));

      if (config.debug) {
        api.logger.info(`[Litefuse] Exported tool span: ${toolName}, duration=${durationMs}ms`);
      }
    });
  }

  // OpenClaw 2.0 splits the legacy before_agent_start lifecycle into
  // before_model_resolve (pre-session) and before_prompt_build (post-session).
  // Registering all three as observation-only (void) handlers ensures root and
  // agent spans are created consistently across OpenClaw 1.x and 2.0.
  if (shouldHookEnabled("before_model_resolve")) {
    api.on("before_model_resolve", async (event: any, hookCtx: any) => {
      handleAgentStart(event, hookCtx, "before_model_resolve");
    });
  }

  if (shouldHookEnabled("before_prompt_build")) {
    api.on("before_prompt_build", async (event: any, hookCtx: any) => {
      handleAgentStart(event, hookCtx, "before_prompt_build");
    });
  }

  if (shouldHookEnabled("before_agent_start")) {
    api.on("before_agent_start", async (event: any, hookCtx: any) => {
      handleAgentStart(event, hookCtx, "before_agent_start");
    });
  }

  if (shouldHookEnabled("agent_end")) {
    api.on("agent_end", async (event: any, hookCtx: any) => {
      const safeEvent = event || {};
      const safeCtx = hookCtx || {};
      const rawChannelId = resolveChannelId(safeCtx, safeEvent.sessionId);
      const { ctx, channelId } = getOrCreateContext(
        rawChannelId,
        safeEvent.runId || safeCtx.runId,
        "agent_end"
      );

      syncSessionInfo(ctx, safeCtx, safeEvent);

      const pendingAgentSpan = ctx.agentSpan;
      ctx.agentSpan = undefined;
      ctx.agentStartTime = undefined;

      const agentEndAttrs: Record<string, any> | undefined = pendingAgentSpan
        ? {
            "agent.duration_ms": safeEvent.durationMs || 0,
            "agent.message_count": Array.isArray(safeEvent.messages) ? safeEvent.messages.length : 0,
            "agent.success": safeEvent.success ?? true,
            ...(safeEvent.error ? { "agent.error": safeEvent.error } : {}),
          }
        : undefined;

      // Snapshot — do NOT clear lastUserTurnContext yet. llm_output may fire
      // after agent_end and needs to find the user context.
      const savedLastUserTurn = lastUserTurnContext;
      const savedLastUserChannelId = lastUserChannelId;
      const originalChannelId = ctx.originalChannelId || savedLastUserChannelId || channelId;
      const rootCtx = ctx.rootSpan ? ctx : (savedLastUserTurn || ctx);

      if (rootCtx.rootSpan || pendingAgentSpan) {
        const root = rootCtx.rootSpan;
        const initialSessionId = getEffectiveSessionId(ctx) || getEffectiveSessionId(rootCtx);
        const userInput = rootCtx.userInput ?? ctx.userInput;

        // Defer agent/root end so late llm_output / message_sent events can
        // still write to the trace before it's flushed.
        const finalizeTurn = async (): Promise<void> => {
          const finalOutput = ctx.lastOutput || rootCtx.lastOutput;
          const finalSessionId =
            getEffectiveSessionId(ctx) || getEffectiveSessionId(rootCtx) || initialSessionId;
          const finalSessionKey = ctx.sessionKey || rootCtx.sessionKey;

          if (pendingAgentSpan) {
            const agentUpdate: any = {};
            if (userInput !== undefined) agentUpdate.input = userInput;
            if (finalOutput !== undefined) agentUpdate.output = finalOutput;
            pendingAgentSpan.update(agentUpdate);
            if (finalSessionId) {
              applySessionAttributes(pendingAgentSpan, finalSessionId, finalSessionKey);
            }
            if (agentEndAttrs) {
              pendingAgentSpan.otelSpan.setAttributes(agentEndAttrs);
              if (userInput !== undefined) {
                pendingAgentSpan.otelSpan.setAttribute(
                  "gen_ai.input.messages",
                  truncateAttr(JSON.stringify([{ role: "user", content: String(userInput) }]))
                );
              }
              if (finalOutput !== undefined) {
                pendingAgentSpan.otelSpan.setAttribute(
                  "gen_ai.output.messages",
                  truncateAttr(JSON.stringify(buildOutputMessages([
                    typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput),
                  ])))
                );
              }
            }
            pendingAgentSpan.end();
            if (config.debug) {
              api.logger.info(
                `[Litefuse] Ended agent span: spanId=${pendingAgentSpan.id}, duration=${safeEvent.durationMs}ms`
              );
            }
          }

          if (root && rootCtx.rootSpanStartTime) {
            const endTime = Date.now();
            const rootStartTime = rootCtx.rootSpanStartTime;
            // Final trace-level attributes on the root span. In OTel each
            // span is shipped once on end(), so set everything here.
            const rootUpdate: any = {};
            if (userInput !== undefined) rootUpdate.input = userInput;
            if (finalOutput !== undefined) rootUpdate.output = finalOutput;
            root.update(rootUpdate);

            if (userInput !== undefined) {
              root.otelSpan.setAttribute(
                LangfuseOtelSpanAttributes.TRACE_INPUT,
                truncateAttr(JSON.stringify(userInput))
              );
            }
            if (finalOutput !== undefined) {
              root.otelSpan.setAttribute(
                LangfuseOtelSpanAttributes.TRACE_OUTPUT,
                truncateAttr(JSON.stringify(finalOutput))
              );
              root.otelSpan.setAttribute(
                "gen_ai.output.messages",
                truncateAttr(JSON.stringify(buildOutputMessages([
                  typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput),
                ])))
              );
            }
            if (userInput !== undefined) {
              root.otelSpan.setAttribute(
                "gen_ai.input.messages",
                truncateAttr(JSON.stringify([{ role: "user", content: String(userInput) }]))
              );
            }
            if (finalSessionId) {
              applySessionAttributes(root, finalSessionId, finalSessionKey);
            }
            root.otelSpan.setAttribute(
              "request.duration_ms",
              endTime - rootStartTime
            );

            root.end(new Date(endTime));
            rootCtx.rootSpan = undefined;
            rootCtx.rootSpanStartTime = undefined;

            if (config.debug) {
              api.logger.info(
                `[Litefuse] Ended root span: spanId=${root.id}, duration=${endTime - rootStartTime}ms, traceId=${root.traceId}`
              );
            }
          }

          // Clear global pointers only if they still point to this turn
          if (lastUserTurnContext === rootCtx || lastUserTurnContext === ctx) {
            lastUserChannelId = undefined;
            lastUserTurnContext = undefined;
          }

          if (savedLastUserChannelId && (savedLastUserTurn === rootCtx || savedLastUserTurn === ctx)) {
            endTurn(savedLastUserChannelId);
          }
          if (originalChannelId && originalChannelId !== savedLastUserChannelId) {
            endTurn(originalChannelId);
          }
          if (rawChannelId !== originalChannelId && rawChannelId !== savedLastUserChannelId) {
            endTurn(rawChannelId);
          }

          // Let the OTel BatchSpanProcessor drain its in-memory queue before
          // forcing a flush. Mirrors the v3 500ms wait before flushAsync.
          await new Promise((r) => setTimeout(r, 500));
          await exporter.forceFlush();
        };
        setTimeout(() => {
          void finalizeTurn().catch((error) => exporter.logFailure("Trace finalization", error));
        }, 200);
      } else {
        if (lastUserTurnContext === rootCtx || lastUserTurnContext === ctx) {
          lastUserChannelId = undefined;
          lastUserTurnContext = undefined;
        }
        if (savedLastUserChannelId && (savedLastUserTurn === rootCtx || savedLastUserTurn === ctx)) {
          endTurn(savedLastUserChannelId);
        }
        if (originalChannelId && originalChannelId !== savedLastUserChannelId) {
          endTurn(originalChannelId);
        }
        if (rawChannelId !== originalChannelId && rawChannelId !== savedLastUserChannelId) {
          endTurn(rawChannelId);
        }
        await exporter.forceFlush();
      }
    });
  }

  api.logger.info(
    `[Litefuse] Plugin activated (baseUrl: ${config.baseUrl || "litefuse.cloud"})`
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = {
  id: "openclaw-litefuse-plugin",
  name: "OpenClaw Litefuse Plugin",
  version: "0.4.0",
  description: "Report OpenClaw AI agent execution traces to Litefuse (OTel-based)",

  configSchema: {
    type: "object",
    properties: {
      publicKey: {
        type: "string",
        default: "",
        description: "Litefuse public key (single target mode)",
      },
      secretKey: {
        type: "string",
        default: "",
        description: "Litefuse secret key (single target mode)",
      },
      baseUrl: {
        type: "string",
        default: "https://litefuse.cloud",
        description: "Litefuse server URL (use self-hosted URL for on-premise)",
      },
      targets: {
        type: "array",
        description: "Multiple Litefuse targets (overrides publicKey/secretKey)",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Target display name" },
            publicKey: { type: "string" },
            secretKey: { type: "string" },
            baseUrl: { type: "string" },
          },
          required: ["publicKey", "secretKey"],
        },
      },
      tags: {
        type: "array",
        items: { type: "string" },
        default: ["openclaw"],
        description: "Tags to attach to all Litefuse traces (e.g. instance name, team)",
      },
      environment: {
        type: "string",
        default: "default",
        description: "Litefuse environment label (e.g. production, staging, development)",
      },
      userId: {
        type: "string",
        description: "userId prefix on traces (e.g. 'alice' → 'alice/openclaw-tui')",
      },
      debug: {
        type: "boolean",
        default: false,
        description: "Enable debug logging",
      },
      enabledHooks: {
        type: "array",
        items: { type: "string" },
        description: "List of hooks to enable (if not set, all hooks are enabled)",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    activate(api);
  },
};

export default plugin;
