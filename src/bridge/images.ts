import { readFileSync, statSync } from "node:fs";

// Past this an image file is linked rather than carried in the chat state every subscriber receives.
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

// An image file's content as base64; undefined when it is missing, not a file or too large to inline.
export type ImageReader = (path: string) => string | undefined;

export function readLocalImage(path: string): string | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_INLINE_IMAGE_BYTES) {
      return undefined;
    }
    return readFileSync(path).toString("base64");
  } catch {
    return undefined;
  }
}
