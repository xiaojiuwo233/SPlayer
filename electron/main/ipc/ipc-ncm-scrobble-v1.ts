import { ipcMain, session } from "electron";
import os from "node:os";
import { ipcLog } from "../logger";
import { useStore } from "../store";
import { port } from "../utils/config";
import {
  generateRandomDeviceId,
  generateWithCustomDeviceId,
  getMacAddress,
} from "../utils/ncm-client-sign";
import { submitNcmScrobbleV1 } from "../utils/ncm-scrobble-v1";

type NcmScrobbleV1Request = {
  id?: unknown;
  sourceid?: unknown;
  source?: unknown;
  time?: unknown;
  total?: unknown;
  name?: unknown;
  artist?: unknown;
  bitrate?: unknown;
  level?: unknown;
};

type NcmScrobbleV1Result = {
  status: number;
  data: unknown;
};

const COOKIE_URLS = Object.freeze([
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  "http://localhost:14558",
  "http://127.0.0.1:14558",
]);

const randomHex = (bytes: number): string => {
  const chars = "0123456789ABCDEF";
  let output = "";
  for (let index = 0; index < bytes * 2; index += 1) {
    output += chars[Math.floor(Math.random() * chars.length)];
  }
  return output;
};

const createQrDeviceId = (): string => randomHex(26);

const createWnmcid = (): string => `${randomHex(3).toLowerCase()}.${Date.now()}.01.0`;

const resolveDesktopOsver = (): string => {
  const arch = os.arch() === "x64" ? "64bit" : os.arch();
  if (process.platform === "darwin") {
    return `macOS-${os.release()}-${arch}`;
  }
  if (process.platform === "win32") {
    return `Microsoft-Windows-${os.release()}-${arch}`;
  }
  return `${os.platform()}-${os.release()}-${arch}`;
};

const parseCookieString = (cookie: string): Map<string, string> => {
  const cookieMap = new Map<string, string>();
  cookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return;
      const name = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1);
      if (name) cookieMap.set(name, value);
    });
  return cookieMap;
};

const serializeCookieMap = (cookieMap: Map<string, string>): string =>
  Array.from(cookieMap.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

const getSessionCookieString = async (): Promise<string> => {
  const cookieMap = new Map<string, string>();
  for (const url of COOKIE_URLS) {
    try {
      const cookies = await session.defaultSession.cookies.get({ url });
      cookies.forEach(({ name, value }) => {
        if (name && value !== undefined && value !== null) cookieMap.set(name, value);
      });
    } catch (error) {
      ipcLog.warn("读取网易云 Cookie 失败:", error);
    }
  }
  return serializeCookieMap(cookieMap);
};

const ensureClientContext = () => {
  const store = useStore();
  const current = store.get("ncmClient");

  const deviceId = current.deviceId || generateRandomDeviceId();
  const macAddress = getMacAddress();
  const clientSign = current.clientSign || generateWithCustomDeviceId(macAddress, deviceId, "");
  const next = {
    sDeviceId: current.sDeviceId || createQrDeviceId(),
    deviceId,
    clientSign,
    appver: current.appver || "3.1.35",
    versioncode: current.versioncode || "205293",
    buildver: current.buildver || "",
    channel: current.channel || "netease",
    mode: current.mode || "SPlayer",
    osver: current.osver || resolveDesktopOsver(),
    WEVNSM: current.WEVNSM || "1.0.0",
    WNMCID: current.WNMCID || createWnmcid(),
  };

  store.set("ncmClient", next);
  return next;
};

const buildCookieString = async (requestCookie: unknown): Promise<string> => {
  const cookieMap = parseCookieString(await getSessionCookieString());
  if (typeof requestCookie === "string") {
    parseCookieString(requestCookie).forEach((value, key) => cookieMap.set(key, value));
  }

  const context = ensureClientContext();
  cookieMap.set("os", "pc");
  cookieMap.set("osver", context.osver);
  cookieMap.set("appver", context.appver);
  cookieMap.set("versioncode", context.versioncode);
  cookieMap.set("buildver", context.buildver);
  cookieMap.set("channel", context.channel);
  cookieMap.set("mode", context.mode);
  cookieMap.set("WEVNSM", context.WEVNSM);
  cookieMap.set("WNMCID", context.WNMCID);
  cookieMap.set("sDeviceId", context.sDeviceId);
  cookieMap.set("deviceId", context.deviceId);
  if (context.clientSign) cookieMap.set("clientSign", context.clientSign);

  return serializeCookieMap(cookieMap);
};

const normalizePositiveIntegerString = (value: unknown): string => {
  const text = String(value ?? "").trim();
  return /^[1-9]\d*$/.test(text) ? text : "";
};

const normalizePositiveInteger = (value: unknown): number => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return 0;
  return Math.round(numberValue);
};

const normalizeText = (value: unknown): string => String(value ?? "").trim();

const submitScrobbleV1 = async (request: NcmScrobbleV1Request): Promise<NcmScrobbleV1Result> => {
  const id = normalizePositiveIntegerString(request.id);
  const time = normalizePositiveInteger(request.time);
  const total = normalizePositiveInteger(request.total) || time;
  if (!id || !time) {
    return {
      status: 400,
      data: { code: 400, msg: "invalid-ncm-scrobble-v1-request" },
    };
  }

  const cookie = await buildCookieString((request as Record<string, unknown>).cookie);
  if (!parseCookieString(cookie).has("MUSIC_U")) {
    return {
      status: 401,
      data: { code: 401, msg: "ncm-login-cookie-required" },
    };
  }

  try {
    const response = await submitNcmScrobbleV1({
      id,
      sourceid: normalizePositiveIntegerString(request.sourceid) || id,
      source: normalizeText(request.source) || "list",
      time,
      total,
      name: normalizeText(request.name),
      artist: normalizeText(request.artist),
      bitrate: normalizePositiveInteger(request.bitrate) || 320,
      level: normalizeText(request.level) || "exhigh",
      cookie,
    });

    return {
      status: Number(response?.status) || 500,
      data: response?.body,
    };
  } catch (error) {
    ipcLog.warn("网易云听歌统计上报失败:", error);
    return {
      status: 502,
      data: { code: 502, msg: String(error || "ncm-scrobble-v1-submit-failed") },
    };
  }
};

/**
 * 初始化网易云 PLV / PLD 上报 IPC
 */
const initNcmScrobbleV1Ipc = (): void => {
  ipcMain.removeHandler("ncm-scrobble-v1-submit");
  ipcMain.handle("ncm-scrobble-v1-submit", async (_event, request: NcmScrobbleV1Request = {}) =>
    submitScrobbleV1(request),
  );
};

export default initNcmScrobbleV1Ipc;
