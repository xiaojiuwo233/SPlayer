import axios from "axios";
import crypto from "node:crypto";
import zlib from "node:zlib";

type NcmScrobbleContext = {
  app: {
    id: string;
    urs: string;
    pid: string;
    nsm: string;
    cid: string;
    channel: string;
    version: string;
    versionCode: string;
    buildCode: string;
    buildType: string;
    packageId: string;
  };
  device: {
    id: string;
    ti: string;
    sign: string;
    model: string;
    nnid: string;
    nuid: string;
    csrf: string;
    systemType: string;
    systemVersion: string;
  };
  auth: {
    id: string;
    token: string;
    sessionId: string;
    vipType: string;
  };
  startTime: number;
  processId: number;
};

type NcmScrobbleSong = {
  id: number;
  name: string;
  artist: string;
  bitrate: number;
  level: string;
  vip: boolean;
  time: number;
};

type NcmScrobbleSource = {
  id: string;
  type: string;
  name: string;
};

type NcmScrobbleRequest = {
  id: string;
  sourceid: string;
  source: string;
  time: number;
  total: number;
  name: string;
  artist: string;
  bitrate: number;
  level: string;
  cookie: string;
};

type NcmScrobbleResponse = {
  status: number;
  body: unknown;
};

type ParsedCookie = Record<string, string>;

type UploadResult = {
  success: boolean;
  fileName: string;
  payload: Buffer;
  respBody: any;
};

type ZlibWithZstd = typeof zlib & {
  zstdCompressSync?: (buffer: Buffer) => Buffer;
};

const CLIENTLOG_UPLOAD_URL =
  "https://clientlog3.music.163.com/api/clientlog/encrypt/upload?multiupload=true";
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const;
const RSA_N =
  0xfd90bd466ff9bc8a3fec2fbcf263b90d5c564879fa5d7aab89b31c1d5cb4139dn;
const RSA_E = 65537n;
const MAGIC = Buffer.from("NCBL", "ascii");
const NCBL_VERSION = 3;
const HEADER_FIXED_LEN = 70;
const META_BLOCK_TYPE = 0x4343;
const DEFAULT_MAX_FRAME = 0x8000;
const FIELD_SEP = "\x01";

const rotl = (value: number, shift: number): number => ((value << shift) | (value >>> (32 - shift))) >>> 0;

const quarterRound = (
  state: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
): void => {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] ^= state[a];
  state[d] = rotl(state[d], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] ^= state[c];
  state[b] = rotl(state[b], 12);
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] ^= state[a];
  state[d] = rotl(state[d], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] ^= state[c];
  state[b] = rotl(state[b], 7);
};

const chachaBlock = (key: Buffer, counter: number, nonce: Buffer): Buffer => {
  const state = new Uint32Array(16);
  state[0] = SIGMA[0];
  state[1] = SIGMA[1];
  state[2] = SIGMA[2];
  state[3] = SIGMA[3];
  for (let index = 0; index < 8; index += 1) {
    state[4 + index] = key.readUInt32LE(index * 4);
  }
  state[12] = counter >>> 0;
  state[13] = nonce.readUInt32LE(0);
  state[14] = nonce.readUInt32LE(4);
  state[15] = nonce.readUInt32LE(8);

  const work = state.slice();
  for (let index = 0; index < 10; index += 1) {
    quarterRound(work, 0, 4, 8, 12);
    quarterRound(work, 1, 5, 9, 13);
    quarterRound(work, 2, 6, 10, 14);
    quarterRound(work, 3, 7, 11, 15);
    quarterRound(work, 0, 5, 10, 15);
    quarterRound(work, 1, 6, 11, 12);
    quarterRound(work, 2, 7, 8, 13);
    quarterRound(work, 3, 4, 9, 14);
  }

  const output = Buffer.allocUnsafe(64);
  for (let index = 0; index < 16; index += 1) {
    output.writeUInt32LE((work[index] + state[index]) >>> 0, index * 4);
  }
  return output;
};

const chacha20 = (key: Buffer, counter: number, nonce: Buffer, data: Buffer): Buffer => {
  const output = Buffer.allocUnsafe(data.length);
  for (let offset = 0; offset < data.length; offset += 64) {
    const keyStream = chachaBlock(key, (counter + (offset >>> 6)) >>> 0, nonce);
    const end = Math.min(offset + 64, data.length);
    for (let index = offset; index < end; index += 1) {
      output[index] = data[index] ^ keyStream[index - offset];
    }
  }
  return output;
};

const beToBig = (buffer: Buffer): bigint => {
  let result = 0n;
  for (const item of buffer) {
    result = (result << 8n) | BigInt(item);
  }
  return result;
};

const bigToBe = (value: bigint, length: number): Buffer => {
  const output = Buffer.alloc(length);
  let current = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return output;
};

const modPow = (base: bigint, exponent: bigint, mod: bigint): bigint => {
  let result = 1n;
  let currentBase = base % mod;
  let currentExponent = exponent;
  while (currentExponent > 0n) {
    if (currentExponent & 1n) {
      result = (result * currentBase) % mod;
    }
    currentBase = (currentBase * currentBase) % mod;
    currentExponent >>= 1n;
  }
  return result;
};

const rsaWrap = (keyA: Buffer): Buffer => bigToBe(modPow(beToBig(keyA), RSA_E, RSA_N), 32);

const getCompress = (): { compress: (buffer: Buffer) => Buffer } => {
  const currentZlib = zlib as ZlibWithZstd;
  if (typeof currentZlib.zstdCompressSync === "function") {
    return { compress: (buffer) => currentZlib.zstdCompressSync!(buffer) };
  }
  return { compress: (buffer) => zlib.gzipSync(buffer) };
};

const encryptNCBL = (meta: string | Buffer, body: string | Buffer, maxFrame: number = DEFAULT_MAX_FRAME): Buffer => {
  const metaBuffer = Buffer.isBuffer(meta) ? meta : Buffer.from(meta, "utf8");
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const keyA = crypto.randomBytes(32);
  if (keyA[0] >= 0xa3) keyA[0] = 0xa2;

  const keyB = rsaWrap(keyA);
  const uuid = crypto.randomBytes(16);
  uuid[6] = (uuid[6] & 0x0f) | 0x40;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;

  const nonce = uuid.subarray(0, 12);
  const counter = uuid.readUInt32LE(12) >>> 2;
  const baseSeq = crypto.randomBytes(2).readUInt16LE(0);
  const metaCipher = chacha20(keyB, counter, nonce, metaBuffer);
  const metaHeader = Buffer.allocUnsafe(4);
  metaHeader.writeUInt16LE(META_BLOCK_TYPE, 0);
  metaHeader.writeUInt16LE(metaCipher.length, 2);
  const metaBlock = Buffer.concat([metaHeader, metaCipher]);
  const headerLength = HEADER_FIXED_LEN + metaBlock.length;

  const { compress } = getCompress();
  const compressed = compress(bodyBuffer);
  const frames: Buffer[] = [];
  let sequence = baseSeq;
  for (let offset = 0; offset < compressed.length || offset === 0; offset += maxFrame) {
    const slice = compressed.subarray(offset, offset + maxFrame);
    const cipher = chacha20(keyA, counter, nonce, slice);
    const frameHeader = Buffer.allocUnsafe(6);
    frameHeader.writeUInt16LE(cipher.length, 0);
    frameHeader.writeUInt32LE(sequence >>> 0, 2);
    frames.push(frameHeader, cipher);
    sequence += 1;
    if (compressed.length === 0) break;
  }

  const trailing = Buffer.concat(frames);
  const frameCount = sequence - baseSeq;
  const header = Buffer.alloc(HEADER_FIXED_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(NCBL_VERSION, 4);
  header.writeUInt16LE(headerLength, 8);
  uuid.copy(header, 10);
  keyB.copy(header, 26);
  header.writeUInt32LE(baseSeq >>> 0, 58);
  header.writeUInt32LE((baseSeq + frameCount - 1) >>> 0, 62);
  header.writeUInt32LE(trailing.length, 66);

  return Buffer.concat([header, metaBlock, trailing]);
};

const buildRecord = (record: { time: number; action: string; data: unknown }): string => {
  const payload = typeof record.data === "string" ? record.data : JSON.stringify(record.data);
  return [record.time, record.action, payload].join(FIELD_SEP);
};

const buildRecords = (records: Array<{ time: number; action: string; data: unknown }>): string =>
  records.map(buildRecord).join("");

const buildPlv = (
  context: NcmScrobbleContext,
  song: NcmScrobbleSong,
  source: NcmScrobbleSource,
): Record<string, unknown> => {
  const now = Date.now();
  const addRefer = `[F:63][${now}#933#${context.app.version}#${context.app.versionCode}#c9156c3][e][2][23][cell_pc_songlist_song:2|page_pc_songlist_songflow|page_mine_like_music][${song.id}:song:x:x|:::|${source.id}:list::]`;
  const multiRefers = [
    "[F:26][s][18][_ai]",
    "[F:26][s][12][_ai]",
    `[F:63][${now}#933#${context.app.version}#${context.app.versionCode}#c9156c3][e][2][8][cell_pc_main_tab_entrance:6|page_pc_main_tab][我喜欢的音乐:spm::|:::]`,
    "[F:26][s][5][_ai]",
    "[F:26][s][0][_ai]",
  ];

  return {
    mode: "circulation",
    download: 0,
    alg: "",
    status: "front",
    id: String(song.id),
    bitrate: song.bitrate,
    type: "song",
    is_listentogether: 0,
    source: source.name,
    is_heart: 0,
    resource_ratio: "",
    resource_time: song.time,
    musiceffect_id: "",
    app_mode: 2,
    bitrate_level: song.level,
    _addrefer: addRefer,
    _multirefers: multiRefers,
    vipType: context.auth.vipType,
    fee: 1,
    file: 4,
    rightSource: 0,
    sourceId: source.id,
    sourcetype: source.type,
    libra_abt: "",
    channel: context.app.channel,
    curStartChannel: "",
  };
};

const buildPld = (
  context: NcmScrobbleContext,
  song: NcmScrobbleSong,
  source: NcmScrobbleSource,
  played: number,
): Record<string, unknown> => {
  const now = Date.now();
  const addRefer = `[F:63][${now}#616#${context.app.version}#${context.app.versionCode}#c9156c3][e][2][92][btn_pc_cover_play|cell_pc_songlist_song:6|page_pc_songlist_songflow|page_mine_like_music][:::|${song.id}:song:x:x|:::|${source.id}:list::]`;
  const multiRefers = [
    "[F:26][s][87][_ai]",
    "[F:26][s][81][_ai]",
    "[F:26][s][75][_ai]",
    "[F:26][s][69][_ai]",
    "[F:26][s][63][_ai]",
  ];

  return {
    mode: "circulation",
    download: 0,
    alg: "",
    status: "front",
    id: String(song.id),
    time: played,
    type: "song",
    is_listentogether: 0,
    source: source.name,
    is_heart: 0,
    realtime: played,
    resource_ratio: "",
    resource_time: song.time,
    musiceffect_id: "1001",
    app_mode: 1,
    lyriceffect: "default",
    displayMode: "classic",
    bitrate: song.bitrate,
    bitrate_level: song.level,
    _addrefer: addRefer,
    _multirefers: multiRefers,
    vipType: context.auth.vipType,
    fee: 8,
    file: 4,
    rightSource: 0,
    sourceId: source.id,
    sourcetype: source.type,
    end: "interrupt",
    libra_abt: "",
    channel: context.app.channel,
    curStartChannel: "",
  };
};

const parseCookie = (cookie: unknown): ParsedCookie => {
  if (typeof cookie === "object" && cookie !== null) {
    return Object.fromEntries(
      Object.entries(cookie as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "")]),
    );
  }

  if (typeof cookie === "string") {
    const result: ParsedCookie = {};
    cookie.split(";").forEach((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return;
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (key) result[key] = value;
    });
    return result;
  }

  return {};
};

const extractContext = (cookie: ParsedCookie): NcmScrobbleContext => ({
  app: {
    id: cookie.appid || "",
    urs: "",
    pid: "",
    nsm: cookie.WEVNSM || "1.0.0",
    cid: cookie.WNMCID || `${crypto.randomBytes(3).toString("hex")}.${Date.now()}.01.0`,
    channel: cookie.channel || "netease",
    version: cookie.appver || "3.1.35",
    versionCode: cookie.versioncode || "205293",
    buildCode: cookie.buildver || "",
    buildType: "release",
    packageId: "",
  },
  device: {
    id: cookie.deviceId || cookie.sDeviceId || "",
    ti: cookie.NMTID || "",
    sign: cookie.clientSign || "",
    model: cookie.mode || cookie.mobilename || "",
    nnid: cookie._ntes_nnid || ",",
    nuid: cookie._ntes_nuid || "",
    csrf: cookie.__csrf || "",
    systemType: cookie.os || "pc",
    systemVersion: cookie.osver || "Microsoft-Windows-10-Professional-build-19045-64bit",
  },
  auth: {
    id: cookie.uid || "",
    token: cookie.MUSIC_U || "",
    sessionId: cookie["JSESSIONID-WYYY"] || "",
    vipType: cookie.vipType || "",
  },
  startTime: Date.now(),
  processId: Math.floor(Math.random() * 90000) + 10000,
});

const randomUUID = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

const buildMultipart = (payload: Buffer): { boundary: string; fileName: string; multipartBody: Buffer } => {
  const boundary = randomUUID();
  const fileName = `op_${Math.floor(Math.random() * 90000) + 10000}_0_${Math.floor(Math.random() * 4294967295) + 1}`;
  const crlf = "\r\n";
  const headerLines = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    "Content-Type: multipart/form-data",
    "",
    "",
  ].join(crlf);
  const footer = `${crlf}--${boundary}--${crlf}`;

  return {
    boundary,
    fileName,
    multipartBody: Buffer.concat([
      Buffer.from(headerLines, "utf8"),
      payload,
      Buffer.from(footer, "utf8"),
    ]),
  };
};

const buildCookieStr = (context: NcmScrobbleContext): string =>
  [
    `JSESSIONID-WYYY=${context.auth.sessionId}`,
    `MUSIC_U=${context.auth.token}`,
    `NMTID=${context.device.ti}`,
    `WEVNSM=${context.app.nsm}`,
    `WNMCID=${context.app.cid}`,
    `__csrf=${context.device.csrf}`,
    "__remember_me=true",
    "_iuqxldmzr_=33",
    `_ntes_nnid=${context.device.nnid}`,
    `_ntes_nuid=${context.device.nuid}`,
    `appver=${context.app.version}.${context.app.versionCode}`,
    `channel=${context.app.channel}`,
    `clientSign=${context.device.sign}`,
    `deviceId=${context.device.id}`,
    `mode=${context.device.model}`,
    "ntes_kaola_ad=1",
    `os=${context.device.systemType}`,
    `osver=${context.device.systemVersion}`,
  ].join("; ");

const buildMetaJson = (context: NcmScrobbleContext): string =>
  JSON.stringify({
    "JSESSIONID-WYYY": context.auth.sessionId,
    MUSIC_U: context.auth.token,
    NMTID: context.device.ti,
    WEVNSM: context.app.nsm,
    WNMCID: context.app.cid,
    __csrf: context.device.csrf,
    _iuqxldmzr_: "33",
    _ntes_nnid: context.device.nnid,
    _ntes_nuid: context.device.nuid,
    appver: `${context.app.version}.${context.app.versionCode}`,
    channel: context.app.channel,
    clientSign: context.device.sign,
    deviceId: context.device.id,
    mode: context.device.model,
    ntes_kaola_ad: "1",
    os: context.device.systemType,
    osver: context.device.systemVersion,
  });

const doUpload = async (
  context: NcmScrobbleContext,
  metaJson: string,
  body: string,
  cookieStr: string,
): Promise<UploadResult> => {
  const payload = encryptNCBL(metaJson, body);
  const { boundary, fileName, multipartBody } = buildMultipart(payload);

  const response = await axios({
    method: "POST",
    url: CLIENTLOG_UPLOAD_URL,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Referer: "https://music.163.com/di",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/${context.app.version}`,
      "Accept-Encoding": "gzip,deflate",
      "Accept-Language": "zh-CN,zh;q=0.8",
      Cookie: cookieStr,
    },
    data: multipartBody,
    maxBodyLength: 10 * 1024 * 1024,
    timeout: 15000,
    validateStatus: () => true,
  });

  const responseBody = response.data;
  const success =
    responseBody?.code === 200 && responseBody?.data?.successfiles?.includes?.(fileName);

  return {
    success,
    fileName,
    payload,
    respBody: responseBody,
  };
};

export const submitNcmScrobbleV1 = async (
  request: NcmScrobbleRequest,
): Promise<NcmScrobbleResponse> => {
  const rawCookie = request.cookie || "";
  const cookie = parseCookie(rawCookie);
  cookie.os = "pc";
  const context = extractContext(cookie);

  if (!context.auth.token && rawCookie) {
    context.auth.token = parseCookie(rawCookie).MUSIC_U || "";
  }

  if (!context.auth.token) {
    return { status: 401, body: { code: 401, msg: "缺少 MUSIC_U 鉴权令牌" } };
  }

  const song: NcmScrobbleSong = {
    id: Number(request.id),
    name: request.name || "",
    artist: request.artist || "",
    bitrate: Number(request.bitrate) || 320,
    level: request.level || "exhigh",
    vip: false,
    time: Number(request.total) || Number(request.time),
  };
  const source: NcmScrobbleSource = {
    id: request.sourceid || request.id,
    type: "track",
    name: request.source || "list",
  };

  const metaJson = buildMetaJson(context);
  const cookieStr = buildCookieStr(context);
  const currentTime = Math.floor(Date.now() / 1000);
  const played = Math.min(Number(request.time), Number(request.total) || Number(request.time));
  const plvBody = buildRecords([
    { time: currentTime, action: "_plv", data: buildPlv(context, song, source) },
  ]);
  const pldBody = buildRecords([
    { time: currentTime, action: "_pld", data: buildPld(context, song, source, played) },
  ]);

  try {
    const plv = await doUpload(context, metaJson, plvBody, cookieStr);
    if (!plv.success) {
      const rate = plv.respBody?.data?.rate;
      return {
        status: 200,
        body: {
          code: plv.respBody?.code || -1,
          msg: rate != null ? `PLV 上报失败 (rate=${rate})` : "PLV 上报失败",
          details: plv.respBody,
        },
      };
    }

    const pld = await doUpload(context, metaJson, pldBody, cookieStr);
    if (!pld.success) {
      return {
        status: 200,
        body: {
          code: pld.respBody?.code || -1,
          msg: "PLV 成功但 PLD 失败",
          details: { plv: plv.respBody, pld: pld.respBody },
        },
      };
    }

    return {
      status: 200,
      body: {
        code: 200,
        data: "scrobble_v1 上报成功",
        details: {
          plv: { fileName: plv.fileName, payloadSize: plv.payload.length },
          pld: { fileName: pld.fileName, payloadSize: pld.payload.length },
        },
      },
    };
  } catch (error) {
    return {
      status: 502,
      body: { code: 502, msg: `请求异常: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
};
