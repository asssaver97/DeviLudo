import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  prepareConversationAttachment,
  sniffConversationAttachmentContentType,
} from "../services/core/src/conversation-attachments";

test("conversation attachment sniffing recognizes PDF and additional raster formats", () => {
  assert.equal(sniffConversationAttachmentContentType(Buffer.from("%PDF-1.7\n", "ascii")), "application/pdf");
  assert.equal(sniffConversationAttachmentContentType(Buffer.from("GIF89a", "ascii")), "image/gif");
  assert.equal(
    sniffConversationAttachmentContentType(Buffer.from([0x49, 0x49, 0x2a, 0x00])),
    "image/tiff",
  );
  assert.equal(
    sniffConversationAttachmentContentType(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])),
    "image/avif",
  );
  assert.equal(
    sniffConversationAttachmentContentType(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])),
    "image/heic",
  );
});

test("additional raster formats are normalized to a bounded PNG for Agent input", async () => {
  const gif = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  }).gif().toBuffer();
  const prepared = await prepareConversationAttachment({
    filename: "reference.gif",
    contentType: "image/gif",
    content: gif,
  });
  assert.equal(prepared.extractedText, "");
  assert.equal(prepared.runtimeImages.length, 1);
  assert.equal(prepared.runtimeImages[0].extension, "png");
  assert.deepEqual(
    prepared.runtimeImages[0].content.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
});
