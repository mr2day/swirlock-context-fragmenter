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

export interface SearchRunResult {
  url: string;
  title: string;
  highlight: string;
  publishedAt: string | null;
  relevanceScore: number | null;
}

export interface SearchRunDiagnostics {
  extractLimit: number;
  resultCount: number;
  durationMs: number;
  providerRequestId: string | null;
}

export interface SearchRunResponse {
  queryText: string;
  results: SearchRunResult[];
  diagnostics: SearchRunDiagnostics;
}

interface PendingSearch {
  timer: NodeJS.Timeout;
  resolve: (result: SearchRunResponse) => void;
  reject: (error: Error) => void;
}

interface RawEnvelope {
  type?: unknown;
  correlationId?: unknown;
  payload?: unknown;
  error?: { code?: string; message?: string };
}

/**
 * Persistent WebSocket client to the RAG Engine at /v5/retrieval.
 *
 * The fragmenter's only consumer is the reality-drift audit; per the
 * Q1 decision recorded in REALITY_DRIFT.md, the fragmenter never opens
 * its own Exa client. It dispatches `search.run` over this socket and
 * waits for the single `search.completed` reply.
 */
@Injectable()
export class RagEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RagEngineService.name);
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private closing = false;
  private readonly pending = new Map<string, PendingSearch>();

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  onModuleInit(): void {
    void this.connect().catch((err: Error) => {
      this.log.warn(
        `RAG Engine persistent socket unavailable at startup: ${err.message}`,
      );
    });
  }

  onModuleDestroy(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.failAll(new Error("RAG Engine persistent socket closed"));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  async searchRun(args: {
    correlationId: string;
    queryText: string;
    extractLimit: number;
  }): Promise<SearchRunResponse> {
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ServiceUnavailableException(
        "RAG Engine persistent socket unavailable",
      );
    }

    return new Promise<SearchRunResponse>((resolve, reject) => {
      if (this.pending.has(args.correlationId)) {
        reject(
          new ServiceUnavailableException(
            `RAG Engine request ${args.correlationId} is already pending`,
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        this.rejectPending(
          args.correlationId,
          new ServiceUnavailableException("RAG Engine search.run timeout"),
        );
      }, this.cfg.ragEngine.timeoutMs);

      this.pending.set(args.correlationId, { timer, resolve, reject });

      try {
        ws.send(
          JSON.stringify({
            type: "search.run",
            correlationId: args.correlationId,
            payload: {
              request: {
                requestContext: {
                  callerService: this.cfg.ragEngine.callerService,
                  priority: "maintenance",
                  requestedAt: new Date().toISOString(),
                  timeoutMs: this.cfg.ragEngine.timeoutMs,
                },
                query: {
                  queryText: args.queryText,
                  extractLimit: args.extractLimit,
                  freshness: "medium",
                },
              },
            },
          }),
        );
      } catch (error) {
        this.rejectPending(
          args.correlationId,
          error instanceof Error
            ? error
            : new Error("RAG Engine send failed"),
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
          reject(new Error("RAG Engine persistent socket connect timeout"));
        });
      }, this.cfg.ragEngine.timeoutMs);

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
          reject(new Error("RAG Engine persistent socket closed")),
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
      this.log.error(`RAG Engine persistent WS error: ${err.message}`);
    });

    ws.on("close", () => {
      if (this.ws === ws) this.ws = undefined;
      this.failAll(new Error("RAG Engine persistent socket closed"));
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let envelope: RawEnvelope;
    try {
      envelope = JSON.parse(rawToString(raw)) as RawEnvelope;
    } catch {
      this.log.warn("RAG Engine emitted non-JSON message");
      return;
    }

    const correlationId =
      typeof envelope.correlationId === "string" ? envelope.correlationId : "";
    if (!correlationId) return;

    if (envelope.type === "search.completed") {
      const payload = isRecord(envelope.payload) ? envelope.payload : {};
      const data = isRecord(payload.data) ? payload.data : null;
      if (!data) {
        this.rejectPending(
          correlationId,
          new ServiceUnavailableException(
            "RAG Engine search.completed missing data",
          ),
        );
        return;
      }
      this.resolvePending(correlationId, normalizeSearchResponse(data));
      return;
    }

    if (envelope.type === "error") {
      this.rejectPending(
        correlationId,
        new ServiceUnavailableException(
          envelope.error?.message ?? "RAG Engine search.run failed",
        ),
      );
      return;
    }

    // heartbeat / health / unknown — ignore.
  }

  private resolvePending(
    correlationId: string,
    result: SearchRunResponse,
  ): void {
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    this.pending.delete(correlationId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private rejectPending(correlationId: string, error: Error): void {
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    this.pending.delete(correlationId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [correlationId, pending] of this.pending) {
      this.pending.delete(correlationId);
      clearTimeout(pending.timer);
      pending.reject(new ServiceUnavailableException(error.message));
      void correlationId;
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((err: Error) => {
        this.log.warn(
          `RAG Engine persistent socket reconnect failed: ${err.message}`,
        );
        this.scheduleReconnect();
      });
    }, 1000);
  }

  private streamUrl(): string {
    return (
      this.cfg.ragEngine.baseUrl
        .replace(/^http:/i, "ws:")
        .replace(/^https:/i, "wss:")
        .replace(/\/$/, "") + "/v5/retrieval"
    );
  }
}

function normalizeSearchResponse(data: Record<string, unknown>): SearchRunResponse {
  const queryText = typeof data.queryText === "string" ? data.queryText : "";
  const rawResults = Array.isArray(data.results) ? data.results : [];
  const results: SearchRunResult[] = rawResults
    .map((r) => (isRecord(r) ? r : null))
    .filter((r): r is Record<string, unknown> => r !== null)
    .map((r) => ({
      url: typeof r.url === "string" ? r.url : "",
      title: typeof r.title === "string" ? r.title : "",
      highlight: typeof r.highlight === "string" ? r.highlight : "",
      publishedAt:
        typeof r.publishedAt === "string" ? r.publishedAt : null,
      relevanceScore:
        typeof r.relevanceScore === "number" ? r.relevanceScore : null,
    }));

  const rawDiag = isRecord(data.diagnostics) ? data.diagnostics : {};
  const diagnostics: SearchRunDiagnostics = {
    extractLimit:
      typeof rawDiag.extractLimit === "number" ? rawDiag.extractLimit : 0,
    resultCount:
      typeof rawDiag.resultCount === "number"
        ? rawDiag.resultCount
        : results.length,
    durationMs:
      typeof rawDiag.durationMs === "number" ? rawDiag.durationMs : 0,
    providerRequestId:
      typeof rawDiag.providerRequestId === "string"
        ? rawDiag.providerRequestId
        : null,
  };

  return { queryText, results, diagnostics };
}
