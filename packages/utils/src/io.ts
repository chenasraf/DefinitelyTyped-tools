import "./types/fstream";
import {
  readFile as readFileWithEncoding,
  readFileSync as readFileWithEncodingSync,
  stat,
  writeFile as writeFileWithEncoding,
  writeJson as writeJsonRaw,
  createWriteStream,
} from "fs-extra";
import { Pack } from "tar";
import tarStream from "tar-stream";
import https, { Agent, request } from "https";
import { resolve, sep } from "path";
import zlib from "zlib";
import { request as httpRequest } from "http";
import { Readable as ReadableStream } from "stream";
import { StringDecoder } from "string_decoder";
import { parseJson, withoutStart, sleep, tryParseJson, isObject } from "./miscellany";
import { FS, Dir, InMemoryFS } from "./fs";
import { assertDefined } from "./assertions";
import { LoggerWithErrors } from "./logging";
import { Stats } from "fs";

export async function readFile(path: string): Promise<string> {
  const res = await readFileWithEncoding(path, { encoding: "utf8" });
  if (res.includes("�")) {
    throw new Error(`Bad character in ${path}`);
  }
  return res;
}

export function readFileSync(path: string): string {
  const res = readFileWithEncodingSync(path, { encoding: "utf8" });
  if (res.includes("�")) {
    throw new Error(`Bad character in ${path}`);
  }
  return res;
}

/** If a file doesn't exist, warn and tell the step it should have been generated by. */
export async function readFileAndWarn(generatedBy: string, filePath: string): Promise<object> {
  try {
    return await readJson(filePath, isObject);
  } catch (e) {
    console.error(`Run ${generatedBy} first!`);
    throw e;
  }
}

export function readJsonSync(path: string): unknown;
export function readJsonSync<T>(path: string, predicate: (parsed: unknown) => parsed is T): T;
export function readJsonSync<T>(path: string, predicate?: (parsed: unknown) => parsed is T) {
  return parseJson(readFileSync(path), predicate);
}

export async function readJson(path: string): Promise<unknown>;
export async function readJson<T>(path: string, predicate: (parsed: unknown) => parsed is T): Promise<T>;
export async function readJson<T>(path: string, predicate?: (parsed: unknown) => parsed is T) {
  return parseJson(await readFile(path), predicate);
}

export async function tryReadJson(path: string): Promise<unknown>;
export async function tryReadJson<T>(path: string, predicate: (parsed: unknown) => parsed is T): Promise<T | undefined>;
export async function tryReadJson<T>(path: string, predicate?: (parsed: unknown) => parsed is T) {
  return tryParseJson(await readFile(path), predicate!);
}

export function writeFile(path: string, content: string): Promise<void> {
  return writeFileWithEncoding(path, content, { encoding: "utf8" });
}

export function writeJson(path: string, content: unknown, formatted = true): Promise<void> {
  return writeJsonRaw(path, content, { spaces: formatted ? 4 : 0 });
}

export function streamOfString(text: string): NodeJS.ReadableStream {
  const s = new ReadableStream();
  s.push(text);
  s.push(null); // tslint:disable-line no-null-keyword
  return s;
}

export function stringOfStream(stream: NodeJS.ReadableStream, description: string): Promise<string> {
  const decoder = new StringDecoder("utf8");
  let body = "";
  stream.on("data", (data: Buffer) => {
    body += decoder.write(data);
  });
  return new Promise<string>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("end", () => {
      body += decoder.end();
      if (body.includes("�")) {
        reject(`Bad character decode in ${description}`);
      } else {
        resolve(body);
      }
    });
  });
}

export function streamDone(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.on("error", reject).on("finish", resolve);
  });
}

type FetchOptions = https.RequestOptions & {
  readonly retries?: boolean | number;
  readonly body?: string;
};
export class Fetcher {
  private readonly agent = new Agent({ keepAlive: true });

  async fetchJson(options: FetchOptions): Promise<unknown> {
    const text = await this.fetch(options);
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new Error(`Bad response from server:\noptions: ${JSON.stringify(options)}\n\n${text}`);
    }
  }

  async fetch(options: FetchOptions): Promise<string> {
    const maxRetries =
      options.retries === false || options.retries === undefined ? 0 : options.retries === true ? 10 : options.retries;
    for (let retries = maxRetries; retries > 1; retries--) {
      try {
        return await doRequest(options, request, this.agent);
      } catch (err) {
        if (!/EAI_AGAIN|ETIMEDOUT|ECONNRESET/.test((err as Error).message)) {
          throw err;
        }
      }
      await sleep(1);
    }
    return doRequest(options, request, this.agent);
  }
}

/** Only used for testing. */
export function makeHttpRequest(options: FetchOptions): Promise<string> {
  return doRequest(options, httpRequest);
}

function doRequest(options: FetchOptions, makeRequest: typeof request, agent?: Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = makeRequest(
      {
        hostname: options.hostname,
        port: options.port,
        path: `/${options.path}`,
        agent,
        method: options.method || "GET",
        headers: options.headers,
        timeout: options.timeout ?? downloadTimeout,
      },
      (res) => {
        let text = "";
        res.on("data", (d: string) => {
          text += d;
        });
        res.on("error", reject);
        res.on("end", () => {
          resolve(text);
        });
      }
    );
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

export async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path)).isDirectory();
}

export const npmInstallFlags =
  "--ignore-scripts --no-shrinkwrap --no-package-lock --no-bin-links --no-save --no-audit --no-fund --legacy-peer-deps";
const downloadTimeout = 1_000_000; // ms
const connectionTimeout = 800_000; // ms

export function downloadAndExtractFile(url: string, log: LoggerWithErrors): Promise<FS> {
  return new Promise<FS>((resolve, reject) => {
    const timeout = setTimeout(reject, downloadTimeout);
    function rejectAndClearTimeout(reason?: any) {
      clearTimeout(timeout);
      return reject(reason);
    }
    const root = new Dir(undefined);
    function insertFile(path: string, content: string): void {
      const components = path.split("/");
      const baseName = assertDefined(components.pop());
      let dir = root;
      for (const component of components) {
        dir = dir.subdir(component);
      }
      dir.set(baseName, content);
    }

    log.info("Requesting " + url);
    https
      .get(url, { timeout: connectionTimeout }, (response) => {
        if (response.statusCode !== 200) {
          return rejectAndClearTimeout(
            new Error(`DefinitelyTyped download failed with status code ${response.statusCode}`)
          );
        }

        log.info("Getting " + url);
        const extract = tarStream.extract();
        interface Header {
          readonly name: string;
          readonly type: "file" | "directory";
        }
        extract.on("entry", (header: Header, stream: NodeJS.ReadableStream, next: () => void) => {
          const name = assertDefined(withoutStart(header.name, "DefinitelyTyped-master/"));
          switch (header.type) {
            case "file":
              stringOfStream(stream, name)
                .then((s) => {
                  insertFile(name, s);
                  next();
                })
                .catch(rejectAndClearTimeout);
              break;
            case "directory":
              next();
              break;
            default:
              throw new Error(`Unexpected file system entry kind ${header.type}`);
          }
        });
        extract.on("error", rejectAndClearTimeout);
        extract.on("finish", () => {
          log.info("Done receiving " + url);
          clearTimeout(timeout);
          resolve(new InMemoryFS(root.finish(), "/"));
        });

        response.pipe(zlib.createGunzip()).pipe(extract);
      })
      .on("error", rejectAndClearTimeout);
  });
}

export function gzip(input: NodeJS.ReadableStream): NodeJS.ReadableStream {
  return input.pipe(zlib.createGzip());
}

export function unGzip(input: NodeJS.ReadableStream): NodeJS.ReadableStream {
  const output = zlib.createGunzip();
  input.pipe(output);
  return output;
}

export function writeTgz(inputDirectory: string, outFileName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    resolve(streamDone(createTgz(inputDirectory, reject).pipe(createWriteStream(outFileName))));
  });
}

// To output this for testing:
// `require("./dist/io").createTgz("./src", err => { throw err }).pipe(fs.createWriteStream("foo.tgz"))`
export function createTgz(dir: string, onError: (error: Error) => void): NodeJS.ReadableStream {
  return gzip(createTar(dir, onError));
}

function createTar(dir: string, onError: (error: Error) => void): NodeJS.ReadableStream {
  const dirSegments = resolve(dir).split(sep);
  const parentDir = dirSegments.slice(0, dirSegments.length - 1).join(sep);
  const entryToAdd = dirSegments[dirSegments.length - 1];
  const packer = new Pack({ cwd: parentDir, filter: addDirectoryExecutablePermission });
  packer.on("error", onError);
  const stream = packer.add(entryToAdd);
  packer.end();

  return stream;
}

/**
 * Work around a bug where directories bundled on Windows do not have executable permission when extracted on Linux.
 * https://github.com/npm/node-tar/issues/7#issuecomment-17572926
 */
function addDirectoryExecutablePermission(_: string, stat: Stats): boolean {
  if (stat.isDirectory()) {
    stat.mode = addExecutePermissionsFromReadPermissions(stat.mode);
  }
  return true;
}

function addExecutePermissionsFromReadPermissions(mode: number): number {
  // Constant that gives execute permissions to owner, group, and others. "+x"
  const allExecutePermissions = 0o111;
  // Moves the bits for read permissions into the place for execute permissions.
  // In other words, a component will have execute permissions if it has read permissions.
  const readPermissionsAsExecutePermissions = (mode >>> 2) & allExecutePermissions; // tslint:disable-line no-bitwise
  // Add these additional execute permissions to the mode.
  return mode | readPermissionsAsExecutePermissions; // tslint:disable-line no-bitwise
}
