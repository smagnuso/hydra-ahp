export interface PatchedFile {
  path: string;
  created: boolean;
  oldText: string;
  newText: string;
}

type Json = Record<string, unknown>;

function bag(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

// The before and after text of a unified diff's hunks. Hunks are concatenated, so unchanged lines between them are absent.
export function unfoldPatch(patch: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) {
      continue;
    }
    const text = line.slice(1);
    if (line.startsWith("-")) {
      oldLines.push(text);
    } else if (line.startsWith("+")) {
      newLines.push(text);
    } else if (line.startsWith(" ")) {
      oldLines.push(text);
      newLines.push(text);
    }
  }
  return {
    oldText: oldLines.length > 0 ? `${oldLines.join("\n")}\n` : "",
    newText: newLines.length > 0 ? `${newLines.join("\n")}\n` : "",
  };
}

// Multi-file patch tools (opencode's apply_patch) carry no diff blocks, only a unified diff per file in
// rawOutput.metadata.files[] on the completed update. Files whose patch is not inline text are left out.
export function patchedFiles(update: Json): PatchedFile[] {
  const files = bag(bag(update.rawOutput).metadata).files;
  if (!Array.isArray(files)) {
    return [];
  }
  const out: PatchedFile[] = [];
  for (const raw of files) {
    const file = bag(raw);
    if (typeof file.filePath !== "string" || file.filePath === "" || typeof file.patch !== "string") {
      continue;
    }
    out.push({ path: file.filePath, created: file.type === "add", ...unfoldPatch(file.patch) });
  }
  return out;
}
