import { FACE_IDS, faceName } from "./faces.js";
import type { Segment } from "./types.js";

export type RenderContext = {
  selfId?: number;
  botName: string;
  // Description of a sticker segment, when known.
  stickerText?: (segment: Segment) => string | undefined;
  // Display name of an @-mentioned user, when known.
  atName?: (userId: number) => string | undefined;
};

const PLACEHOLDERS: Record<string, string> = {
  dice: "[骰子]",
  rps: "[猜拳]",
  record: "[语音]",
  video: "[视频]",
  file: "[文件]",
  forward: "[合并转发]",
  node: "[合并转发]",
  json: "[卡片]",
  xml: "[卡片]",
  markdown: "[消息]",
  poke: "[戳一戳]",
  contact: "[名片]",
  location: "[位置]",
  music: "[音乐]",
  share: "[链接]",
};

export function toSegments(message: Segment[] | string | undefined): Segment[] {
  if (Array.isArray(message)) return message.filter((seg) => seg && typeof seg.type === "string");
  if (typeof message === "string" && message) return [{ type: "text", data: { text: message } }];
  return [];
}

function asId(value: unknown): number | undefined {
  const id = typeof value === "string" ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

export function renderSegments(segments: Segment[], ctx: RenderContext): string {
  const parts: string[] = [];
  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        parts.push(String(seg.data.text ?? ""));
        break;
      case "at": {
        if (seg.data.qq === "all") {
          parts.push("@全体成员 ");
          break;
        }
        const id = asId(seg.data.qq);
        const name = typeof seg.data.name === "string" && seg.data.name ? seg.data.name : undefined;
        // Never fall back to the raw QQ number: the model would read it out in chat.
        if (id !== undefined && id === ctx.selfId) parts.push(`@${ctx.botName} `);
        else parts.push(`@${name ?? (id !== undefined ? ctx.atName?.(id) : undefined) ?? "某人"} `);
        break;
      }
      case "image":
      case "mface": {
        const sticker = isSticker(seg);
        const description = sticker ? ctx.stickerText?.(seg) : undefined;
        parts.push(description ? `[表情包：${description}]` : sticker ? "[表情包]" : "[图片]");
        break;
      }
      case "face": {
        const name = faceName(Number(seg.data.id));
        parts.push(name ? `[${name}]` : "[表情]");
        break;
      }
      case "reply":
        break;
      default:
        parts.push(PLACEHOLDERS[seg.type] ?? `[${seg.type}]`);
    }
  }
  return parts.join("").replace(/[ \t]+\n/g, "\n").trim();
}

export function isSticker(segment: Segment): boolean {
  if (segment.type === "mface") return true;
  return segment.type === "image" && (Number(segment.data.sub_type) === 1 || segment.data.summary === "[动画表情]");
}

export function isAtSelf(segments: Segment[], selfId: number | undefined): boolean {
  if (selfId === undefined) return false;
  return segments.some((seg) => seg.type === "at" && asId(seg.data.qq) === selfId);
}

export function atTargets(segments: Segment[], selfId: number | undefined): number[] {
  const ids = segments.filter((seg) => seg.type === "at").map((seg) => asId(seg.data.qq));
  return [...new Set(ids.filter((id): id is number => id !== undefined && id !== selfId))];
}

export function replyTargetId(segments: Segment[]): number | undefined {
  const reply = segments.find((seg) => seg.type === "reply");
  return reply ? asId(reply.data.id) : undefined;
}

export function hasText(segments: Segment[]): boolean {
  return segments.some((seg) => seg.type === "text" && String(seg.data.text ?? "").trim().length > 0);
}

export function textSegment(text: string): Segment {
  return { type: "text", data: { text } };
}

// Turns known QQ face names written as [名称] into real face segments; anything else stays text.
export function textToSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\[([^\[\]\s]{1,8})\]/g)) {
    const id = FACE_IDS[match[1]!];
    if (id === undefined) continue;
    if (match.index > cursor) segments.push(textSegment(text.slice(cursor, match.index)));
    segments.push({ type: "face", data: { id: String(id) } });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push(textSegment(text.slice(cursor)));
  return segments;
}

export function replySegment(messageId: number): Segment {
  return { type: "reply", data: { id: String(messageId) } };
}
