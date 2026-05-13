/**
 * WebSocket hub — owns the live `ws` clients connected at /ws and
 * broadcasts pet state / pet-switch messages.
 *
 * Each new client immediately receives a {type:"state"} snapshot so
 * floaters don't have to wait for the next event to render correctly.
 *
 * The hub doesn't care about HTTP routing — main.ts upgrades the
 * appropriate path and passes the socket here.
 */

import type { WebSocket, WebSocketServer } from "ws";
import { type Logger, NullLogger } from "./logger.js";
import type { Broadcaster } from "./http.js";
import type { Clock } from "./clock.js";
import type { PetState, WsOutMessage } from "./types.js";

export interface WsHubDeps {
  /** State source — used to send initial snapshot to new clients. */
  getCurrentState(): { state: PetState; ts: number };
  /** Active pet slug, sent on connect if non-null. */
  getCurrentPet(): string | null;
  clock: Clock;
  logger?: Logger;
}

export class WsHub implements Broadcaster {
  private readonly clients = new Set<WebSocket>();
  private readonly deps: WsHubDeps;
  private readonly log: Logger;

  constructor(deps: WsHubDeps) {
    this.deps = deps;
    this.log = deps.logger ?? NullLogger;
  }

  /** Wire a `ws` server's connections into this hub. */
  attach(server: WebSocketServer): void {
    server.on("connection", (ws) => this.register(ws));
  }

  /** Register a new socket. Sends initial state + (optional) pet snapshot. */
  register(ws: WebSocket): void {
    this.clients.add(ws);
    this.log.debug("ws_client_connected", { clients: this.clients.size });

    ws.on("close", () => {
      this.clients.delete(ws);
      this.log.debug("ws_client_disconnected", { clients: this.clients.size });
    });
    ws.on("error", (err: Error) => {
      this.log.warn("ws_client_error", { message: err.message });
    });

    const cur = this.deps.getCurrentState();
    this.send(ws, { type: "state", state: cur.state, ts: cur.ts });

    const pet = this.deps.getCurrentPet();
    if (pet) {
      this.send(ws, { type: "pet", slug: pet });
    }
  }

  /**
   * Broadcast a state change. Optional fields:
   *  - bubble                — legacy compact pill text
   *  - title/subtitle/loading— v0.4 task-card fields
   *  - activeSessionCount    — v0.4.2 collapsed-state badge counter
   *  - bubbleTtlMs           — shared by both; undefined = sticky
   */
  broadcastState(
    state: PetState,
    ts: number,
    opts?: {
      bubble?: string;
      title?: string;
      subtitle?: string;
      loading?: boolean;
      waiting?: boolean;
      bubbleTtlMs?: number;
      activeSessionCount?: number;
    },
  ): void {
    const msg: WsOutMessage = { type: "state", state, ts };
    if (opts?.bubble) msg.bubble = opts.bubble;
    if (opts?.title) msg.title = opts.title;
    if (opts?.subtitle) msg.subtitle = opts.subtitle;
    if (typeof opts?.loading === "boolean") msg.loading = opts.loading;
    if (typeof opts?.waiting === "boolean") msg.waiting = opts.waiting;
    if (typeof opts?.bubbleTtlMs === "number") msg.bubbleTtlMs = opts.bubbleTtlMs;
    if (typeof opts?.activeSessionCount === "number") {
      msg.activeSessionCount = opts.activeSessionCount;
    }
    this.broadcast(msg);
  }

  broadcastPet(slug: string): void {
    this.broadcast({ type: "pet", slug });
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Close every socket. */
  closeAll(): void {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  private broadcast(msg: WsOutMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        // ws.OPEN === 1
        if ((ws as { readyState?: number }).readyState === 1) {
          ws.send(payload);
        }
      } catch (err) {
        this.log.warn("ws_send_failed", { message: (err as Error).message });
      }
    }
  }

  private send(ws: WebSocket, msg: WsOutMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn("ws_send_failed", { message: (err as Error).message });
    }
  }
}
