import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { cwdToUri, uriToCwd } from "../bridge/ids.js";
import type { ClientContext } from "../protocol/backend.js";
import { ErrorCodes, RpcError } from "../rpc/peer.js";
import type { FileLevel } from "../store/tokens.js";
import { completeFiles } from "./completions.js";
import { EditedPaths, PathScopeError, isInside, realpathLoose } from "./scope.js";
import { readFileWindow } from "./window.js";

const NOT_FOUND = -32008;
const PERMISSION_DENIED = -32009;
const ALREADY_EXISTS = -32010;
const CONFLICT = -32011;

const READ_METHODS = new Set(["resourceList", "resourceRead", "resourceResolve", "completions"]);
const WRITE_METHODS = new Set(["resourceWrite", "resourceDelete", "resourceMkdir", "resourceMove", "resourceCopy"]);

export const MAX_SCOPED_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_SCOPED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_UNSCOPED_READ_BYTES = 32 * 1024 * 1024;
const SNIFF_BYTES = 8192;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".json": "application/json",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".pdf": "application/pdf",
};

export interface FileSession {
  id: string;
  cwd: string;
  remote?: string;
}

export interface SessionDirectory {
  fileSessions(): FileSession[];
  sessionForChat(chatUri: string): FileSession | undefined;
}

export interface FileServiceOptions {
  sessions: SessionDirectory;
  edited?: EditedPaths;
  dirRoots: string[];
}

interface Grant {
  real: string;
  dirsOnly: boolean;
}

type Json = Record<string, unknown>;

function objectParams(params: unknown): Json {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new RpcError(ErrorCodes.InvalidParams, "params must be an object");
  }
  return params as Json;
}

function uriParam(params: Json, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") {
    throw new RpcError(ErrorCodes.InvalidParams, `${key} must be a file: URI`);
  }
  return value;
}

function toPath(uri: string): string {
  const path = uriToCwd(uri);
  if (path === undefined || path.includes("\0")) {
    throw new RpcError(ErrorCodes.InvalidParams, "uri must be an absolute file: URI on this host");
  }
  return path;
}

function mimeFor(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()];
}

function isImage(path: string): boolean {
  return mimeFor(path)?.startsWith("image/") === true;
}

function etagOf(info: Stats): string {
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

// Maps filesystem errors onto AHP's resource error codes.
export function fsError(err: unknown): RpcError {
  if (err instanceof RpcError) {
    return err;
  }
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
      return new RpcError(NOT_FOUND, "no such file or directory");
    case "EACCES":
    case "EPERM":
      return new RpcError(PERMISSION_DENIED, "permission denied");
    case "EEXIST":
      return new RpcError(ALREADY_EXISTS, "already exists");
    case "EISDIR":
      return new RpcError(ErrorCodes.InvalidParams, "is a directory");
    case "ENOTEMPTY":
      return new RpcError(ErrorCodes.InvalidParams, "directory is not empty");
    default:
      return new RpcError(ErrorCodes.InternalError, err instanceof Error ? err.message : String(err));
  }
}

async function looksBinary(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

// Serves the resource* commands and @ completions at the connection's token level.
export class FileService {
  readonly edited: EditedPaths;
  private readonly sessions: SessionDirectory;
  private readonly dirRoots: string[];

  constructor(options: FileServiceOptions) {
    this.sessions = options.sessions;
    this.edited = options.edited ?? new EditedPaths();
    this.dirRoots = options.dirRoots;
  }

  handles(method: string): boolean {
    return READ_METHODS.has(method) || WRITE_METHODS.has(method);
  }

  async handle(method: string, rawParams: unknown, client: ClientContext): Promise<unknown> {
    const level = client.token.level;
    if (WRITE_METHODS.has(method) && level !== "full") {
      throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
    const params = objectParams(rawParams);
    try {
      switch (method) {
        case "resourceList":
          return await this.list(level, params);
        case "resourceRead":
          return await this.read(level, params);
        case "resourceResolve":
          return await this.resolve(level, params);
        case "completions":
          return await this.complete(params);
        case "resourceWrite":
          return await this.write(params);
        case "resourceDelete":
          return await this.remove(params);
        case "resourceMkdir":
          return await this.makeDirectory(params);
        case "resourceMove":
          return await this.move(params);
        case "resourceCopy":
          return await this.copy(params);
        default:
          throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
      }
    } catch (err) {
      if (err instanceof PathScopeError) {
        throw new RpcError(PERMISSION_DENIED, err.message);
      }
      throw fsError(err);
    }
  }

  // Decides what the token may do with a path; follow=false keeps a final symlink unresolved.
  private async authorize(level: FileLevel, path: string, follow = true): Promise<Grant> {
    const real = follow ? await realpathLoose(path) : join(await realpathLoose(dirname(path)), basename(path));
    if (level !== "scoped") {
      return { real, dirsOnly: false };
    }
    const sessions = this.sessions.fileSessions();
    const local = sessions.filter((session) => session.remote === undefined);
    for (const session of local) {
      const root = await realpathLoose(session.cwd).catch(() => undefined);
      if (root !== undefined && isInside(root, real)) {
        return { real, dirsOnly: false };
      }
    }
    if (await this.edited.has(real)) {
      return { real, dirsOnly: false };
    }
    for (const configured of this.dirRoots) {
      const root = await realpathLoose(configured).catch(() => undefined);
      if (root !== undefined && isInside(root, real)) {
        return { real, dirsOnly: true };
      }
    }
    for (const session of sessions) {
      if (session.remote === undefined) {
        continue;
      }
      if (isInside(session.cwd, path) || isInside(session.cwd, real)) {
        throw new PathScopeError(`files live on "${session.remote}" and cannot be read from here`);
      }
    }
    throw new PathScopeError("path is outside the files this token may access");
  }

  private async list(level: FileLevel, params: Json): Promise<unknown> {
    const grant = await this.authorize(level, toPath(uriParam(params, "uri")));
    const info = await stat(grant.real);
    if (!info.isDirectory()) {
      throw new RpcError(ErrorCodes.InvalidParams, "not a directory");
    }
    const names = (await readdir(grant.real)).sort((a, b) => a.localeCompare(b));
    const entries: Array<{ name: string; type: "file" | "directory" }> = [];
    for (const name of names) {
      let child: Stats;
      try {
        child = await stat(join(grant.real, name));
      } catch {
        continue;
      }
      if (child.isDirectory()) {
        entries.push({ name, type: "directory" });
      } else if (child.isFile() && !grant.dirsOnly) {
        entries.push({ name, type: "file" });
      }
    }
    return { entries };
  }

  private async resolve(level: FileLevel, params: Json): Promise<unknown> {
    const follow = params.followSymlinks !== false;
    const grant = await this.authorize(level, toPath(uriParam(params, "uri")), follow);
    const info = await (follow ? stat(grant.real) : lstat(grant.real));
    const type = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file";
    if (grant.dirsOnly && type !== "directory") {
      throw new PathScopeError("path is outside the files this token may access");
    }
    const contentType = type === "file" ? mimeFor(grant.real) : undefined;
    return {
      uri: cwdToUri(grant.real),
      type,
      ...(type !== "directory" ? { size: info.size } : {}),
      mtime: info.mtime.toISOString(),
      ...(info.birthtimeMs > 0 ? { ctime: info.birthtime.toISOString() } : {}),
      ...(contentType ? { contentType } : {}),
      etag: etagOf(info),
    };
  }

  private async read(level: FileLevel, params: Json): Promise<unknown> {
    const grant = await this.authorize(level, toPath(uriParam(params, "uri")));
    if (grant.dirsOnly) {
      throw new PathScopeError("path is outside the files this token may access");
    }
    const info = await stat(grant.real);
    if (!info.isFile()) {
      throw new RpcError(ErrorCodes.InvalidParams, "not a file");
    }
    const scoped = level === "scoped";
    const binary = await looksBinary(grant.real);
    const contentType = mimeFor(grant.real);
    if (binary) {
      if (scoped && !isImage(grant.real)) {
        throw new RpcError(ErrorCodes.InvalidParams, "binary file");
      }
      const cap = scoped ? MAX_SCOPED_IMAGE_BYTES : MAX_UNSCOPED_READ_BYTES;
      if (info.size > cap) {
        throw new RpcError(ErrorCodes.InvalidParams, `file too large (${info.size} bytes, limit ${cap})`);
      }
      const data = (await readFile(grant.real)).toString("base64");
      return { data, encoding: "base64", ...(contentType ? { contentType } : {}) };
    }
    const wantsWindow =
      typeof params.fromLine === "number" || typeof params.lineCount === "number" || typeof params.locate === "string";
    if (wantsWindow) {
      const window = await readFileWindow(grant.real, {
        ...(typeof params.fromLine === "number" ? { fromLine: params.fromLine } : {}),
        ...(typeof params.lineCount === "number" ? { lineCount: params.lineCount } : {}),
        ...(typeof params.locate === "string" ? { locate: params.locate } : {}),
      });
      return {
        data: window.content,
        encoding: "utf-8",
        contentType: contentType ?? "text/plain",
        window: { fromLine: window.fromLine, hasMore: window.hasMore, matchedLine: window.matchedLine },
      };
    }
    const cap = scoped ? MAX_SCOPED_TEXT_BYTES : MAX_UNSCOPED_READ_BYTES;
    if (info.size > cap) {
      throw new RpcError(
        ErrorCodes.InvalidParams,
        `file too large (${info.size} bytes, limit ${cap}); request a window with fromLine and lineCount`,
      );
    }
    const bytes = await readFile(grant.real);
    if (params.encoding === "base64") {
      return { data: bytes.toString("base64"), encoding: "base64", contentType: contentType ?? "text/plain" };
    }
    return { data: bytes.toString("utf8"), encoding: "utf-8", contentType: contentType ?? "text/plain" };
  }

  private async complete(params: Json): Promise<unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    const offset = typeof params.offset === "number" ? params.offset : text.length;
    const channel = typeof params.channel === "string" ? params.channel : "";
    if (params.kind !== "userMessage" || offset < 0 || offset > text.length) {
      return { items: [] };
    }
    const session = this.sessions.sessionForChat(channel);
    if (!session || session.remote !== undefined) {
      return { items: [] };
    }
    const root = await realpathLoose(session.cwd).catch(() => undefined);
    if (root === undefined) {
      return { items: [] };
    }
    return { items: await completeFiles(root, text, offset) };
  }

  // Writes below here only run at the full level; the caller has already gated them.
  private async write(params: Json): Promise<unknown> {
    const path = (await this.authorize("full", toPath(uriParam(params, "uri")))).real;
    const data = Buffer.from(
      typeof params.data === "string" ? params.data : "",
      params.encoding === "base64" ? "base64" : "utf8",
    );
    const mode = params.mode === "append" || params.mode === "insert" ? params.mode : "truncate";
    const position = typeof params.position === "number" && params.position > 0 ? Math.floor(params.position) : 0;
    let existing: Stats | undefined;
    try {
      existing = await stat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    if (existing?.isDirectory()) {
      throw new RpcError(ErrorCodes.InvalidParams, "is a directory");
    }
    if (typeof params.ifMatch === "string" && (!existing || etagOf(existing) !== params.ifMatch)) {
      throw new RpcError(CONFLICT, "etag does not match");
    }
    if (params.createOnly === true) {
      await writeFile(path, data, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL });
      return {};
    }
    if (!existing || (mode === "truncate" && position === 0)) {
      await writeFile(path, data);
      return {};
    }
    if (mode === "append" && position === 0) {
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND);
      try {
        await handle.write(data);
      } finally {
        await handle.close();
      }
      return {};
    }
    const current = await readFile(path);
    let result: Buffer;
    if (mode === "truncate") {
      result = Buffer.concat([current.subarray(0, Math.min(position, current.length)), data]);
    } else {
      const at = mode === "append" ? Math.max(0, current.length - position) : Math.min(position, current.length);
      result = Buffer.concat([current.subarray(0, at), data, current.subarray(at)]);
    }
    await writeFile(path, result);
    return {};
  }

  private async remove(params: Json): Promise<unknown> {
    const path = (await this.authorize("full", toPath(uriParam(params, "uri")), false)).real;
    const info = await lstat(path);
    if (info.isDirectory()) {
      if (params.recursive === true) {
        await rm(path, { recursive: true });
      } else {
        await rmdir(path);
      }
      return {};
    }
    await rm(path);
    return {};
  }

  private async makeDirectory(params: Json): Promise<unknown> {
    const path = (await this.authorize("full", toPath(uriParam(params, "uri")))).real;
    try {
      const info = await stat(path);
      if (!info.isDirectory()) {
        throw new RpcError(ALREADY_EXISTS, "already exists and is not a directory");
      }
      return {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    await mkdir(path, { recursive: true });
    return {};
  }

  private async move(params: Json): Promise<unknown> {
    const source = (await this.authorize("full", toPath(uriParam(params, "source")), false)).real;
    const destination = (await this.authorize("full", toPath(uriParam(params, "destination")), false)).real;
    await lstat(source);
    await this.refuseExisting(destination, params.failIfExists === true);
    try {
      await rename(source, destination);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
        throw err;
      }
      await cp(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
      await rm(source, { recursive: true });
    }
    return {};
  }

  private async copy(params: Json): Promise<unknown> {
    const source = (await this.authorize("full", toPath(uriParam(params, "source")))).real;
    const destination = (await this.authorize("full", toPath(uriParam(params, "destination")), false)).real;
    await stat(source);
    await this.refuseExisting(destination, params.failIfExists === true);
    await cp(source, destination, { recursive: true, force: true });
    return {};
  }

  private async refuseExisting(path: string, failIfExists: boolean): Promise<void> {
    if (!failIfExists) {
      return;
    }
    try {
      await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
    throw new RpcError(ALREADY_EXISTS, "destination already exists");
  }
}
