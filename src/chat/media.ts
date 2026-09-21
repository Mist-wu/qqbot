export type Describe = (dataUrl: string) => Promise<string>;

export function sniffMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

export async function downloadImage(url: string, maxBytes: number): Promise<{ bytes: Buffer; mime: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`太大 ${bytes.length}`);
  const mime = sniffMime(bytes);
  if (!mime) throw new Error("不是可识别的图片");
  return { bytes, mime };
}

export function dataUrl(image: { bytes: Buffer; mime: string }): string {
  return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
}

// Vision output often notes the absence of text ("（图中无文字）"), which is noise in chat context.
export function cleanDescription(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[（(][^（）()]*(?:无|没有)[^（）()]*文字[^（）()]*[）)]/g, "")
    .replace(/(?:图片|图中|图上|图内|画面)?(?:中|上|里)?(?:没有|无)(?:任何)?文字[，,、；;。]?/g, "")
    .replace(/^[，,、；;\s]+/, "")
    .trim();
}
