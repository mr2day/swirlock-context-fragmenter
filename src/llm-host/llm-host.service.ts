import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import WebSocket from "ws";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmInferOptions {
  responseFormat?: "text" | "json";
  thinking?: boolean;
  ollama?: Record<string, unknown>;
}

export type LlmStreamEvent =
  | { type: "accepted"; payload: Record<string, never> }
  | { type: "queued"; payload: Record<string, unknown> }
  | { type: "started"; payload: Record<string, never> }
  | { type: "thinking"; payload: { text: string } }
  | { type: "chunk"; payload: { text: string } }
  | {
      type: "done";
      payload: {
        finishReason: "stop" | "length" | "error";
        appliedOptions?: LlmInferOptions;
      };
    }
  | {
      type: "error";
      error: { code: string; message: string; retryable: boolean };
    };

export interface LlmStreamResult {
  finishReason: "stop" | "length" | "error";
  text: string;
}

interface RawLlmEnvelope {
  type?: unknown;
  correlationId?: unknown;
  payload?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

interface PendingInferRequest {
  text: string;
  finishReason: "stop" | "length" | "error";
  timer: NodeJS.Timeout;
  onEvent?: (event: LlmStreamEvent) => void;
  resolve: (result: LlmStreamResult) => void;
  reject: (error: Error) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Single persistent WebSocket client to the Fragmenter LLM Host.
 *
 * Per v5 contract, the fragmenter has a 1:1 binding to its Model Host.
 * No URL override, no multi-host map. Reconnects automatically on
 * close.
 */
@Injectable()
export class LlmHostService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LlmHostService.name);
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private closing = false;
  private readonly pending = new Map<string, PendingInferRequest>();

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  onModuleInit(): void {
    void this.connect().catch((err: Error) => {
      this.log.warn(
        `Fragmenter LLM persistent socket unavailable at startup: ${err.message}`,
      );
    });
  }

  onModuleDestroy(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.failAll(new Error("Fragmenter LLM persistent socket closed"));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  /**
   * Sends one inference request and assembles the complete response.
   * Used by the consolidation worker — non-streaming consumers can omit
   * `onEvent`.
   */
  async streamInfer(args: {
    correlationId: string;
    messages: LlmMessage[];
    options?: LlmInferOptions;
    onEvent?: (event: LlmStreamEvent) => void;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<LlmStreamResult> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ServiceUnavailableException(
        "Fragmenter LLM persistent socket unavailable",
      );
    }

    return new Promise<LlmStreamResult>((resolve, reject) => {
      if (this.pending.has(args.correlationId)) {
        reject(
          new ServiceUnavailableException(
            `Fragmenter LLM request ${args.correlationId} is already pending`,
          ),
        );
        return;
      }

      const timeoutMs = args.timeoutMs || this.cfg.llmHost.timeoutMs;
      const timer = setTimeout(() => {
        this.rejectPending(
          args.correlationId,
          new ServiceUnavailableException("Fragmenter LLM stream timeout"),
        );
      }, timeoutMs);

      const onAbort = (): void => {
        this.sendCancel(args.correlationId);
        this.rejectPending(args.correlationId, new Error("aborted"));
      };
      args.abortSignal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(args.correlationId, {
        text: "",
        finishReason: "error",
        timer,
        onEvent: args.onEvent,
        resolve,
        reject,
        abortSignal: args.abortSignal,
        onAbort,
      });

      try {
        ws.send(
          JSON.stringify({
            type: "infer",
            correlationId: args.correlationId,
            payload: {
              request: {
                requestContext: {
                  callerService: this.cfg.llmHost.callerService,
                  priority: "background",
                  requestedAt: new Date().toISOString(),
                  timeoutMs,
                },
                input: { messages: args.messages },
                ...(args.options ? { options: args.options } : {}),
              },
            },
          }),
        );
      } catch (error) {
        this.rejectPending(
          args.correlationId,
          error instanceof Error
            ? error
            : new Error("Fragmenter LLM send failed"),
        );
      }
    });
  }

  private async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.closing = false;
    const wsUrl = this.streamUrl();

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error("Fragmenter LLM persistent socket connect timeout"));
        });
      }, this.cfg.llmHost.timeoutMs);

      ws.on("open", () => {
        this.ws = ws;
        this.attachSocketHandlers(ws);
        settle(resolve);
      });

      ws.on("error", (err: Error) => {
        settle(() => reject(err));
      });

      ws.on("close", () => {
        settle(() =>
          reject(new Error("Fragmenter LLM persistent socket closed")),
        );
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  private attachSocketHandlers(ws: WebSocket): void {
    ws.on("message", (raw: WebSocket.RawData) => {
      this.handleMessage(raw);
    });

    ws.on("error", (err: Error) => {
      this.log.error(`Fragmenter LLM persistent WS error: ${err.message}`);
    });

    ws.on("close", () => {
      if (this.ws === ws) this.ws = undefined;
      this.failAll(new Error("Fragmenter LLM persistent socket closed"));
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let envelope: RawLlmEnvelope;
    try {
      envelope = JSON.parse(rawToString(raw)) as RawLlmEnvelope;
    } catch {
      this.log.warn("Fragmenter LLM emitted non-JSON stream message");
      return;
    }

    const correlationId =
      typeof envelope.correlationId === "string" ? envelope.correlationId : "";
    if (!correlationId) return;

    const pending = this.pending.get(correlationId);
    if (!pending) return;

    const evt = this.normalizeEvent(envelope);
    if (!evt) return;

    try {
      pending.onEvent?.(evt);
    } catch (error) {
      this.log.warn(
        `Fragmenter LLM event handler threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (evt.type === "chunk" && evt.payload.text) {
      pending.text += evt.payload.text;
    }

    if (evt.type === "done") {
      this.resolvePending(correlationId, {
        finishReason: this.normalizeFinishReason(evt.payload.finishReason),
        text: pending.text,
      });
    }

    if (evt.type === "error") {
      this.rejectPending(
        correlationId,
        new ServiceUnavailableException(
          evt.error?.message ?? "Fragmenter LLM stream error",
        ),
      );
    }
  }

  private normalizeEvent(raw: RawLlmEnvelope): LlmStreamEvent | null {
    if (typeof raw.type !== "string") return null;
    const payload = isRecord(raw.payload) ? raw.payload : {};

    switch (raw.type) {
      case "accepted":
      case "started":
        return { type: raw.type, payload: {} };
      case "queued":
        return { type: "queued", payload };
      case "thinking":
      case "chunk":
        return {
          type: raw.type,
          payload: {
            text: typeof payload.text === "string" ? payload.text : "",
          },
        };
      case "done":
        return {
          type: "done",
          payload: {
            finishReason: this.normalizeFinishReason(payload.finishReason),
          },
        };
      case "error":
        return {
          type: "error",
          error: {
            code: raw.error?.code ?? "upstream_unavailable",
            message: raw.error?.message ?? "Fragmenter LLM stream error",
            retryable: raw.error?.retryable !== false,
          },
        };
      default:
        return null;
    }
  }

  private resolvePending(correlationId: string, result: LlmStreamResult): void {
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    this.cleanupPending(correlationId, pending);
    pending.resolve(result);
  }

  private rejectPending(correlationId: string, error: Error): void {
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    this.cleanupPending(correlationId, pending);
    pending.reject(error);
  }

  private cleanupPending(
    correlationId: string,
    pending: PendingInferRequest,
  ): void {
    this.pending.delete(correlationId);
    clearTimeout(pending.timer);
    if (pending.onAbort) {
      pending.abortSignal?.removeEventListener("abort", pending.onAbort);
    }
  }

  private failAll(error: Error): void {
    for (const [correlationId, pending] of this.pending) {
      this.cleanupPending(correlationId, pending);
      pending.reject(new ServiceUnavailableException(error.message));
    }
  }

  private sendCancel(correlationId: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "cancel", correlationId }));
    } catch {
      /* ignore */
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((err: Error) => {
        this.log.warn(
          `Fragmenter LLM persistent socket reconnect failed: ${err.message}`,
        );
        this.scheduleReconnect();
      });
    }, 1000);
  }

  private streamUrl(): string {
    return (
      this.cfg.llmHost.baseUrl
        .replace(/^http:/i, "ws:")
        .replace(/^https:/i, "wss:")
        .replace(/\/$/, "") + "/v5/model"
    );
  }

  private normalizeFinishReason(value: unknown): "stop" | "length" | "error" {
    if (value === "stop" || value === "length" || value === "error") {
      return value;
    }
    return "error";
  }
}
