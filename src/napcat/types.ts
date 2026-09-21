export type Segment = {
  type: string;
  data: Record<string, unknown>;
};

export type Sender = {
  user_id: number;
  nickname?: string;
  card?: string;
  role?: string;
};

export type MessageEvent = {
  post_type: "message";
  message_type: "private" | "group";
  sub_type?: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  self_id: number;
  time: number;
  message: Segment[] | string;
  raw_message?: string;
  sender?: Sender;
};

export type OneBotEvent =
  | MessageEvent
  | {
      post_type: string;
      self_id?: number;
      meta_event_type?: string;
      [key: string]: unknown;
    };

export type ActionResponse<T = unknown> = {
  status: "ok" | "failed" | "async";
  retcode: number;
  data: T;
  message?: string;
  msg?: string;
  wording?: string;
  echo?: string;
};

export function isMessageEvent(event: OneBotEvent): event is MessageEvent {
  return (
    event.post_type === "message" &&
    (event.message_type === "private" || event.message_type === "group") &&
    typeof event.message_id === "number"
  );
}
