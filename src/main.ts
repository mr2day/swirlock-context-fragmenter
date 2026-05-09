import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { randomUUID } from "crypto";
import type { IncomingMessage, Server as HttpServer } from "http";
import { WebSocketServer } from "ws";
import "reflect-metadata";
import { AppModule } from "./app.module";
import { SERVICE_CONFIG } from "./config/config";
import type { ServiceConfig } from "./config/config";
import { FragmenterStreamHandler } from "./fragmenter/fragmenter-stream.handler";

const STREAM_PATH = "/v5/fragmenter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const cfg = app.get<ServiceConfig>(SERVICE_CONFIG);
  const streamHandler = app.get(FragmenterStreamHandler);

  await app.listen(cfg.port, cfg.host);

  attachStreamServer(app.getHttpServer() as HttpServer, cfg, streamHandler);

  Logger.log(
    `Context Fragmenter listening on http://${cfg.host}:${cfg.port}`,
    "Bootstrap",
  );
  Logger.log(
    `Stream WS path: ws://${cfg.host}:${cfg.port}${STREAM_PATH}`,
    "Bootstrap",
  );
}

function attachStreamServer(
  httpServer: HttpServer,
  cfg: ServiceConfig,
  handler: FragmenterStreamHandler,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const log = new Logger("FragmenterStream");

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0];
    if (pathOnly !== STREAM_PATH) {
      socket.destroy();
      return;
    }

    const token = extractBearerToken(req);
    if (!token || token !== cfg.bearerToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const incomingCorrelation = req.headers["x-correlation-id"];
    const correlationId =
      typeof incomingCorrelation === "string" && incomingCorrelation.length > 0
        ? incomingCorrelation
        : Array.isArray(incomingCorrelation) && incomingCorrelation[0]
          ? incomingCorrelation[0]
          : randomUUID();

    wss.handleUpgrade(req, socket, head, (ws) => {
      void handler.handle(ws, { correlationId }).catch((err: Error) => {
        log.error(`stream handler crashed: ${err.message}`, err.stack);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
    });
  });
}

/**
 * Extracts a bearer token from an HTTP/WebSocket-upgrade request.
 *
 * Supports three transports, in order:
 *  1. `Authorization: Bearer <token>` — standard, used by all non-browser clients.
 *  2. `?token=<token>` query parameter — for browsers, since
 *     `new WebSocket(url)` cannot set custom headers.
 *  3. `Sec-WebSocket-Protocol: bearer, <token>` — also browser-friendly via
 *     `new WebSocket(url, ['bearer', '<token>'])`.
 */
function extractBearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice("Bearer ".length).trim();
    if (t.length > 0) return t;
  }

  if (req.url) {
    const qIdx = req.url.indexOf("?");
    if (qIdx >= 0) {
      const params = new URLSearchParams(req.url.slice(qIdx + 1));
      const t = params.get("token");
      if (t && t.length > 0) return t;
    }
  }

  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string") {
    const parts = proto
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const idx = parts.indexOf("bearer");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  }

  return undefined;
}

void bootstrap();
