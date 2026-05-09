import { Injectable, Logger } from "@nestjs/common";
import WebSocket from "ws";
import {
  ConsolidationScheduler,
  type ConsolidationUpdatedEvent,
} from "../consolidation/consolidation-scheduler.service";

interface ConnectionContext {
  correlationId: string;
}

interface V5Envelope {
  type: string;
  correlationId: string;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * WS endpoint handler for `/v5/fragmenter`.
 *
 * Per v5 contract `apps/context-fragmenter.md`, this endpoint accepts
 * fire-and-forget notifications from the orchestrator and may emit
 * optional `consolidation.updated` events back. None of the handlers
 * block the orchestrator's user-facing turn.
 */
@Injectable()
export class FragmenterStreamHandler {
  private readonly log = new Logger(FragmenterStreamHandler.name);

  constructor(private readonly scheduler: ConsolidationScheduler) {}

  async handle(ws: WebSocket, ctx: ConnectionContext): Promise<void> {
    const unsubscribe = this.scheduler.onConsolidationUpdated((event) => {
      this.emitConsolidationUpdated(ws, event);
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let envelope: V5Envelope;
      try {
        envelope = this.parseEnvelope(raw);
      } catch (err) {
        this.sendError(
          ws,
          ctx.correlationId,
          "bad_request",
          err instanceof Error ? err.message : "Invalid message",
        );
        return;
      }

      try {
        this.dispatch(ws, envelope);
      } catch (err) {
        this.log.error(
          `dispatch crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.sendError(
          ws,
          envelope.correlationId,
          "internal_error",
          err instanceof Error ? err.message : "Internal error",
        );
      }
    });

    await new Promise<void>((resolve) => {
      ws.once("close", () => {
        unsubscribe();
        resolve();
      });
    });
  }

  private dispatch(ws: WebSocket, envelope: V5Envelope): void {
    switch (envelope.type) {
      case "heartbeat":
        this.send(ws, {
          type: "heartbeat",
          correlationId: envelope.correlationId,
          payload: { receivedAt: new Date().toISOString() },
        });
        return;

      case "health.get":
        this.send(ws, {
          type: "health",
          correlationId: envelope.correlationId,
          payload: {
            status: "ok",
            ready: true,
            checkedAt: new Date().toISOString(),
          },
        });
        return;

      case "session.observed":
        this.handleSessionObserved(envelope);
        return;

      case "session.invalidate":
        this.handleSessionInvalidate(envelope);
        return;

      case "cancel":
        // Nothing to cancel in the MVP — consolidation runs synchronously
        // through the scheduler's own queue and finish quickly. The
        // contract still requires us to accept the message; we simply
        // ignore it here.
        return;

      default:
        this.sendError(
          ws,
          envelope.correlationId,
          "bad_request",
          `Unsupported message type: ${envelope.type}`,
        );
        return;
    }
  }

  private handleSessionObserved(envelope: V5Envelope): void {
    if (!isRecord(envelope.payload)) {
      this.log.warn(
        `session.observed [${envelope.correlationId}] dropped: payload missing`,
      );
      return;
    }

    const sessionId = this.stringField(envelope.payload.sessionId);
    if (!sessionId) {
      this.log.warn(
        `session.observed [${envelope.correlationId}] dropped: sessionId missing`,
      );
      return;
    }

    const lastSeq =
      typeof envelope.payload.lastSeq === "number" &&
      Number.isFinite(envelope.payload.lastSeq)
        ? Math.trunc(envelope.payload.lastSeq)
        : 0;
    const observedAt =
      typeof envelope.payload.observedAt === "string" &&
      envelope.payload.observedAt
        ? envelope.payload.observedAt
        : new Date().toISOString();

    this.scheduler.notifyObserved({ sessionId, lastSeq, observedAt });
  }

  private handleSessionInvalidate(envelope: V5Envelope): void {
    if (!isRecord(envelope.payload)) {
      this.log.warn(
        `session.invalidate [${envelope.correlationId}] dropped: payload missing`,
      );
      return;
    }
    const sessionId = this.stringField(envelope.payload.sessionId);
    if (!sessionId) {
      this.log.warn(
        `session.invalidate [${envelope.correlationId}] dropped: sessionId missing`,
      );
      return;
    }
    this.scheduler.notifyInvalidated(sessionId);
  }

  private emitConsolidationUpdated(
    ws: WebSocket,
    event: ConsolidationUpdatedEvent,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Use a fresh correlationId per emission since this is an unsolicited
    // server-pushed event, not a reply to any specific client request.
    this.send(ws, {
      type: "consolidation.updated",
      correlationId: `cf:notify:${event.sessionId}:${event.occurredAt}`,
      payload: event,
    });
  }

  private parseEnvelope(raw: WebSocket.RawData): V5Envelope {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(raw));
    } catch {
      throw new Error("message must be JSON");
    }
    if (!isRecord(parsed)) {
      throw new Error("message must be an object");
    }
    if (typeof parsed.type !== "string" || !parsed.type.trim()) {
      throw new Error("message.type is required");
    }
    const correlationId =
      typeof parsed.correlationId === "string"
        ? parsed.correlationId.trim()
        : "";
    if (!correlationId) {
      throw new Error("message.correlationId is required");
    }

    return {
      type: parsed.type.trim(),
      correlationId,
      payload: parsed.payload,
    };
  }

  private stringField(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private send(ws: WebSocket, envelope: V5Envelope): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope));
    }
  }

  private sendError(
    ws: WebSocket,
    correlationId: string,
    code: string,
    message: string,
  ): void {
    this.send(ws, {
      type: "error",
      correlationId,
      error: { code, message, retryable: false },
    });
  }
}
