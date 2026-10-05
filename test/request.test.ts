import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_COUNT,
  MAX_IMAGE_SIZE_BYTES,
  MAX_TOTAL_IMAGE_SIZE_BYTES,
  parsePrompt,
} from "../src/request.ts";

const signatures: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/webp": [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")],
  "image/gif": [...Buffer.from("GIF89a")],
};

function image(mimeType: string, size = signatures[mimeType]!.length) {
  const bytes = Buffer.alloc(size);
  Buffer.from(signatures[mimeType]!).copy(bytes);
  return { mimeType, data: bytes.toString("base64"), name: "unsafe/path.png" };
}

test("parsePrompt trims and returns a non-empty message", () => {
  assert.deepEqual(parsePrompt({ message: "  hi  " }), { message: "hi", images: [] });
});

test("parsePrompt rejects missing, non-string, and empty messages", () => {
  for (const value of [null, {}, { message: 12 }, { message: " \n " }]) {
    assert.throws(() => parsePrompt(value), /Enter a message/);
  }
  assert.throws(() => parsePrompt({ message: "", images: [] }), /Enter a message/);
});

test("parsePrompt limits message size", () => {
  assert.throws(() => parsePrompt({ message: "x".repeat(100_001) }), /100,000/);
});

test("parsePrompt accepts supported image MIME types using matching image signatures", () => {
  for (const mimeType of Object.keys(signatures)) {
    const parsed = parsePrompt({ message: "describe", images: [image(mimeType)] });
    assert.equal(parsed.message, "describe");
    assert.equal(parsed.images[0]?.mimeType, mimeType);
    assert.equal(parsed.images[0]?.size, signatures[mimeType]!.length);
    assert.equal(parsed.images[0]?.name, "unsafe/path.png");
  }
  assert.equal(parsePrompt({ images: [image("image/png")] }).message, "");
});

test("parsePrompt rejects unsupported, mismatched, and malformed image payloads", () => {
  assert.throws(() => parsePrompt({ message: "x", images: [{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }] }), /Unsupported image type/);
  assert.throws(() => parsePrompt({ message: "x", images: [{ mimeType: "image/png", data: "not base64!" }] }), /malformed/);
  assert.throws(() => parsePrompt({ message: "x", images: [{ mimeType: "image/png", data: Buffer.from("not PNG").toString("base64") }] }), /does not match/);
});

test("parsePrompt enforces individual, combined, and image-count limits", () => {
  const tooLarge = "A".repeat(Math.ceil((MAX_IMAGE_SIZE_BYTES + 1) / 3) * 4);
  assert.throws(() => parsePrompt({ message: "x", images: [{ mimeType: "image/png", data: tooLarge }] }), /Image is too large/);

  const perImageSize = Math.floor(MAX_TOTAL_IMAGE_SIZE_BYTES / 3) + 1;
  const threeLargeImages = Array.from({ length: 3 }, () => image("image/png", perImageSize));
  assert.throws(() => parsePrompt({ message: "x", images: threeLargeImages }), /Total attachment size/);

  const tooMany = Array.from({ length: MAX_IMAGE_COUNT + 1 }, () => image("image/png"));
  assert.throws(() => parsePrompt({ message: "x", images: tooMany }), /no more than/);
});
