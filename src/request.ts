export const MAX_IMAGE_COUNT = 32;
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_REQUEST_BODY_BYTES = 29 * 1024 * 1024;

export interface ImageAttachment {
  mimeType: string;
  data: string;
  name?: string;
  size: number;
}

const IMAGE_SIGNATURES: Record<string, (data: Buffer) => boolean> = {
  "image/png": (data) => data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  "image/webp": (data) => data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP",
  "image/gif": (data) => data.length >= 6 &&
    (data.toString("ascii", 0, 6) === "GIF87a" || data.toString("ascii", 0, 6) === "GIF89a"),
};

function parseImages(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Image attachments must be an array.");
  if (value.length > MAX_IMAGE_COUNT) throw new Error(`Attach no more than ${MAX_IMAGE_COUNT} images.`);

  let totalSize = 0;
  return value.map((item): ImageAttachment => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Image attachment is invalid.");
    }
    const attachment = item as Record<string, unknown>;
    if (typeof attachment.mimeType !== "string") throw new Error("Unsupported image type.");
    const mimeType = attachment.mimeType === "image/jpg" ? "image/jpeg" : attachment.mimeType;
    const signature = IMAGE_SIGNATURES[mimeType];
    if (!signature) throw new Error("Unsupported image type.");
    if (typeof attachment.data !== "string" || !attachment.data) {
      throw new Error("Image data is malformed.");
    }
    if (attachment.data.length > Math.ceil(MAX_IMAGE_SIZE_BYTES * 4 / 3) + 4) {
      throw new Error("Image is too large.");
    }
    if (attachment.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data)) {
      throw new Error("Image data is malformed.");
    }

    const padding = attachment.data.endsWith("==") ? 2 : attachment.data.endsWith("=") ? 1 : 0;
    const size = attachment.data.length * 3 / 4 - padding;
    if (size <= 0) throw new Error("Image data is malformed.");
    if (size > MAX_IMAGE_SIZE_BYTES) throw new Error("Image is too large.");
    totalSize += size;
    if (totalSize > MAX_TOTAL_IMAGE_SIZE_BYTES) throw new Error("Total attachment size exceeds the limit.");

    const data = Buffer.from(attachment.data, "base64");
    if (data.toString("base64") !== attachment.data || !signature(data)) {
      throw new Error("Image data does not match its MIME type.");
    }

    const name = typeof attachment.name === "string" && attachment.name.length > 0
      ? attachment.name.slice(0, 255)
      : undefined;
    return { mimeType, data: attachment.data, ...(name ? { name } : {}), size };
  });
}

export function parsePrompt(value: unknown): { message: string; images: ImageAttachment[] } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Enter a message to send to Pi.");
  }

  const body = value as Record<string, unknown>;
  if (body.message !== undefined && typeof body.message !== "string") {
    throw new Error("Enter a message to send to Pi.");
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length > 100_000) {
    throw new Error("Messages must be 100,000 characters or fewer.");
  }
  const images = parseImages(body.images);
  if (!message && images.length === 0) {
    throw new Error("Enter a message to send to Pi.");
  }

  return { message, images };
}
