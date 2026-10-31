import { z } from "zod";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import {
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_IMAGES,
  SUPPORTED_OUTBOUND_FORMATS,
  loadOutboundImage,
  type OutboundImageCollector,
} from "./outbound.js";

export const ATTACHMENTS_NAMESPACE = "boop-attachments";

const MAX_MB = MAX_OUTBOUND_IMAGE_BYTES / (1024 * 1024);

export const IMAGE_ATTACHMENTS_PROMPT = `

Sending images to the user:
- If you produce or find an image the user should actually see (a chart, a screenshot, a generated image, a photo), call attach_image with its absolute local file path or its http(s) URL. It's delivered as a real iMessage attachment alongside the final reply.
- Supported: ${SUPPORTED_OUTBOUND_FORMATS}. Max ${MAX_MB} MB each, up to ${MAX_OUTBOUND_IMAGES} per reply. Save charts/screenshots to a file first (PNG is safest), then attach the path.
- If attach_image returns an error, fix it (e.g. re-save as PNG or smaller) or tell the user in one sentence that the image couldn't be sent.
- Don't paste the file path or image URL into your answer for images you attached; just mention the image naturally ("chart attached").`;

export function createImageAttachmentTools(collector: OutboundImageCollector): RuntimeTool[] {
  return [
    defineRuntimeTool(
      ATTACHMENTS_NAMESPACE,
      "attach_image",
      `Attach an image to the reply the user receives over iMessage. Pass an absolute local file path or an http(s) URL. Supported formats: ${SUPPORTED_OUTBOUND_FORMATS}; max ${MAX_MB} MB; up to ${MAX_OUTBOUND_IMAGES} images per reply.`,
      {
        source: z
          .string()
          .describe("Absolute local file path (e.g. /tmp/chart.png) or http(s) URL of the image."),
      },
      async (args) => {
        const source = args.source.trim();
        if (collector.has(source)) return runtimeText(`Already attached: ${source}`);
        const loaded = await loadOutboundImage(source);
        if (!loaded.ok) {
          return runtimeText(`Couldn't attach ${source}: ${loaded.reason}`, false);
        }
        if (!collector.add(loaded.image)) {
          return runtimeText(
            `Couldn't attach ${source}: limit of ${MAX_OUTBOUND_IMAGES} images per reply reached.`,
            false,
          );
        }
        return runtimeText(
          `Attached ${loaded.image.filename} (${loaded.image.mediaType}, ${loaded.image.bytes.byteLength} bytes). It will be sent with the reply.`,
        );
      },
    ),
  ];
}
