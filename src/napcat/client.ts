import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import { config } from "../config.js";
import { logger } from "../logger.js";
import type { ActionResponse, OneBotEvent, Segment } from "./types.js";

type Pending = {
  resolve: (response: ActionResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
};

export type SendTarget = { groupId: number; userId?: undefined } | { userId: number; groupId?: undefined };

export class NapcatClient {
  selfId: number | undefined;

  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = Date.now();
  private shuttingDown = false;
  private sendChain: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;

  constructor(private readonly onEvent: (event: OneBotEvent) => void) {}

  connect(): void {
    if (this.shuttingDown) return;
    const headers: Record<string, string> = {};
    if (config.napcat.token) headers.Authorization = `Bearer ${config.napcat.token}`;

    logger.info(`连接 NapCat: ${config.napcat.url}`);
    const ws = new WebSocket(config.napcat.url, { headers });
    this.ws = ws;

    ws.on("open", () => {
      logger.info("NapCat 已连接");
      this.startHeartbeat();
      void this.refreshSelfId();
    });
    ws.on("message", (data) => this.onRaw(data));
    ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });
    ws.on("close", (code, reason) => {
      logger.warn(`NapCat 连接关闭: ${code} ${reason.toString()}`);
      this.stopHeartbeat();
      this.failPending(new Error(`WebSocket closed: ${code}`));
      this.scheduleReconnect();
    });
    ws.on("error", (error) => {
      logger.error("NapCat WebSocket 错误:", error.message);
    });
  }

  // Resolves on this socket's open. learn-history uses it instead of sleeping.
  whenOpen(timeoutMs = config.napcat.actionTimeoutMs): Promise<void> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("NapCat 未连接"));
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("连接 NapCat 超时"));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("NapCat 连接关闭"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("close", onClose);
      };
      ws.once("open", onOpen);
      ws.once("close", onClose);
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.failPending(new Error("shutdown"));
    this.ws?.close(1000, "shutdown");
    this.ws = null;
  }

  callAction<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<ActionResponse<T>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`NapCat 未连接，无法执行 ${action}`));
    }
    const echo = randomUUID();
    return new Promise<ActionResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`action ${action} 超时`));
      }, config.napcat.actionTimeoutMs);
      this.pending.set(echo, {
        resolve: resolve as (response: ActionResponse) => void,
        reject,
        timer,
        action,
      });
      ws.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      });
    });
  }

  sendMessage(target: SendTarget, message: Segment[], current?: () => boolean): Promise<number | undefined> {
    return this.enqueue(
      () =>
        target.groupId !== undefined
          ? this.callAction<{ message_id: number }>("send_group_msg", { group_id: target.groupId, message })
          : this.callAction<{ message_id: number }>("send_private_msg", { user_id: target.userId, message }),
      current,
    );
  }

  // Merged-forward message made of "node" segments.
  sendForward(target: SendTarget, nodes: Segment[], current?: () => boolean): Promise<number | undefined> {
    return this.enqueue(
      () =>
        target.groupId !== undefined
          ? this.callAction<{ message_id: number }>("send_group_forward_msg", { group_id: target.groupId, messages: nodes })
          : this.callAction<{ message_id: number }>("send_private_forward_msg", { user_id: target.userId, messages: nodes }),
      current,
    );
  }

  // Sends are serialized with a minimum gap so bursts of reply parts do not trip QQ risk control.
  // `current` is checked after that wait and before OneBot. A call already handed to OneBot is not cancelled.
  private enqueue(
    send: () => Promise<ActionResponse<{ message_id: number }>>,
    current?: () => boolean,
  ): Promise<number | undefined> {
    const task = this.sendChain.then(async () => {
      await this.pace();
      if (current && !current()) return undefined;
      this.lastSendAt = Date.now();
      return (await send()).data?.message_id;
    });
    this.sendChain = task.catch(() => undefined);
    return task;
  }

  private pace(): Promise<void> {
    const wait = this.lastSendAt + config.napcat.sendIntervalMs - Date.now();
    if (wait <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, wait);
    });
  }

  private async refreshSelfId(): Promise<void> {
    try {
      const response = await this.callAction<{ user_id: number; nickname: string }>("get_login_info");
      this.selfId = response.data.user_id;
      logger.info(`登录账号: ${response.data.nickname} (${response.data.user_id})`);
    } catch (error) {
      logger.warn("获取登录信息失败:", (error as Error).message);
    }
  }

  private onRaw(data: WebSocket.RawData): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      logger.warn("无法解析 NapCat 消息");
      return;
    }

    if (typeof payload.echo === "string" && this.pending.has(payload.echo)) {
      const pending = this.pending.get(payload.echo)!;
      this.pending.delete(payload.echo);
      clearTimeout(pending.timer);
      const response = payload as unknown as ActionResponse;
      if (response.status === "failed" || (typeof response.retcode === "number" && response.retcode !== 0)) {
        const detail = response.wording || response.message || response.msg || `retcode=${response.retcode}`;
        pending.reject(new Error(`action ${pending.action} 失败: ${detail}`));
      } else {
        pending.resolve(response);
      }
      return;
    }

    if (typeof payload.post_type === "string") {
      const event = payload as OneBotEvent;
      if (typeof event.self_id === "number") this.selfId = event.self_id;
      try {
        this.onEvent(event);
      } catch (error) {
        logger.error("事件处理失败:", error);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    const interval = Math.max(5000, Math.floor(config.napcat.heartbeatTimeoutMs / 3));
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > config.napcat.heartbeatTimeoutMs) {
        logger.warn("NapCat 心跳超时，重连");
        ws.terminate();
        return;
      }
      ws.ping();
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, config.napcat.reconnectMs);
  }

  private failPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(echo);
    }
  }
}
