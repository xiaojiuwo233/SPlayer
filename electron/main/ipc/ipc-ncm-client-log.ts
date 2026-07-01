import axios, { AxiosError, type AxiosResponse } from "axios";
import { ipcMain, session } from "electron";
import { createRequire } from "node:module";
import { ipcLog } from "../logger";
import { port } from "../utils/config";

type NcmClientLogAction = "startplay" | "play";

type NcmClientLog = {
  action: NcmClientLogAction;
  json: Record<string, unknown>;
};

type NcmClientLogRequest = {
  logs?: unknown;
  cookie?: unknown;
  timeout?: unknown;
};

type NcmClientLogResult = {
  status: number;
  statusText: string;
  data: unknown;
  headers: Record<string, string>;
};

type NcmCrypto = {
  weapi?: (payload: Record<string, string>) => Record<string, string>;
};

const require = createRequire(import.meta.url);
const ncmCrypto = require("@neteasecloudmusicapienhanced/api/util/crypto.js") as NcmCrypto;

const NCM_CLIENT_LOG_ENDPOINT = "https://clientlogusf.music.163.com/weapi/feedback/weblog";
const NCM_REFERER = "https://music.163.com/";
const NCM_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const ALLOWED_ACTIONS = new Set<NcmClientLogAction>(["startplay", "play"]);
const COOKIE_URLS = Object.freeze([
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  "http://localhost:14558",
  "http://127.0.0.1:14558",
]);

const emptyHeaders = {};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeClientLogs = (logs: unknown): NcmClientLog[] => {
  if (!Array.isArray(logs)) return [];

  return logs
    .slice(0, 8)
    .map((log): NcmClientLog | null => {
      if (!isPlainObject(log)) return null;
      const action = typeof log.action === "string" ? log.action.trim() : "";
      const json = isPlainObject(log.json) ? log.json : null;
      if (!ALLOWED_ACTIONS.has(action as NcmClientLogAction) || !json) return null;
      return { action: action as NcmClientLogAction, json };
    })
    .filter((log): log is NcmClientLog => Boolean(log));
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

const mergeCookieStrings = (...cookies: string[]): string => {
  const cookieMap = new Map<string, string>();
  cookies.forEach((cookie) => {
    parseCookieString(cookie).forEach((value, name) => {
      cookieMap.set(name, value);
    });
  });
  return serializeCookieMap(cookieMap);
};

const normalizeTimeout = (value: unknown): number => {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) return 8000;
  return Math.min(Math.max(Math.round(timeout), 1000), 30000);
};

const buildPayload = (logs: NcmClientLog[], csrfToken: string): URLSearchParams => {
  if (typeof ncmCrypto.weapi !== "function") {
    throw new Error("ncm-weapi-encrypt-unavailable");
  }

  return new URLSearchParams(
    ncmCrypto.weapi({
      logs: JSON.stringify(logs),
      csrf_token: csrfToken,
    }),
  );
};

const buildEndpoint = (csrfToken: string): string => {
  if (!csrfToken) return NCM_CLIENT_LOG_ENDPOINT;
  return `${NCM_CLIENT_LOG_ENDPOINT}?csrf_token=${encodeURIComponent(csrfToken)}`;
};

const normalizeHeaders = (headers: AxiosResponse["headers"]): Record<string, string> => {
  const result: Record<string, string> = {};
  Object.entries(headers || {}).forEach(([name, value]) => {
    if (typeof value === "string") {
      result[name] = value;
    } else if (Array.isArray(value)) {
      result[name] = value.join(", ");
    } else if (value !== undefined && value !== null) {
      result[name] = String(value);
    }
  });
  return result;
};

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

const buildErrorResult = (error: unknown): NcmClientLogResult => {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status ?? (axiosError.code === "ECONNABORTED" ? 504 : 502);
    return {
      status,
      statusText: axiosError.response?.statusText ?? (status === 504 ? "Gateway Timeout" : "Bad Gateway"),
      data: axiosError.response?.data ?? {
        code: status,
        msg: axiosError.message || "ncm-client-log-submit-failed",
        ...(axiosError.code ? { errorCode: axiosError.code } : {}),
      },
      headers: normalizeHeaders(axiosError.response?.headers ?? emptyHeaders),
    };
  }

  return {
    status: 500,
    statusText: "Internal Server Error",
    data: { code: 500, msg: String(error || "ncm-client-log-submit-failed") },
    headers: {},
  };
};

const submitClientLog = async (request: NcmClientLogRequest): Promise<NcmClientLogResult> => {
  const logs = normalizeClientLogs(request.logs);
  if (logs.length === 0) {
    return {
      status: 400,
      statusText: "Bad Request",
      data: { code: 400, msg: "empty-ncm-client-log" },
      headers: {},
    };
  }

  const sessionCookieString = await getSessionCookieString();
  const requestCookieString = typeof request.cookie === "string" ? request.cookie : "";
  const cookieString = sessionCookieString
    ? mergeCookieStrings(requestCookieString, sessionCookieString)
    : requestCookieString;
  const cookieMap = parseCookieString(cookieString);
  if (!cookieMap.has("MUSIC_U")) {
    return {
      status: 401,
      statusText: "Unauthorized",
      data: { code: 401, msg: "ncm-login-cookie-required" },
      headers: {},
    };
  }

  const csrfToken = cookieMap.get("__csrf") || "";

  try {
    const response = await axios.post(buildEndpoint(csrfToken), buildPayload(logs, csrfToken).toString(), {
      headers: {
        Cookie: cookieString,
        Origin: NCM_REFERER.replace(/\/$/, ""),
        Referer: NCM_REFERER,
        "User-Agent": NCM_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: normalizeTimeout(request.timeout),
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      ipcLog.warn("网易云客户端日志上报返回异常:", response.status, response.data);
    }

    return {
      status: response.status,
      statusText: response.statusText,
      data: response.data,
      headers: normalizeHeaders(response.headers),
    };
  } catch (error) {
    ipcLog.warn("网易云客户端日志上报失败:", error);
    return buildErrorResult(error);
  }
};

/**
 * 初始化网易云客户端日志 IPC
 */
const initNcmClientLogIpc = (): void => {
  ipcMain.removeHandler("ncm-client-log-submit");
  ipcMain.handle("ncm-client-log-submit", async (_event, request: NcmClientLogRequest = {}) =>
    submitClientLog(request),
  );
};

export default initNcmClientLogIpc;
