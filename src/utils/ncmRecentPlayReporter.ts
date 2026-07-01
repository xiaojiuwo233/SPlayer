/**
 * 网易云最近播放上报
 *
 * 将第三方播放器的听歌记录同步到网易云账号，使官方客户端与其他设备可见
 * 最近播放与听歌报告。
 *
 * 实现要点：
 * - 渲染层只构造日志，不直接请求网易云。
 * - 主进程负责读取 Cookie、weapi 加密，并提交到客户端日志域名。
 * - 播放开始提交 startplay + play，结束或中断再提交带 time/end 的 play。
 */

import { isLogin } from "@/utils/auth";
import { isElectron } from "@/utils/env";
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import type { SongType } from "@/types/main";

type ClientLogAction = "startplay" | "play";

type ClientLogJson = Record<string, string | number>;

type ClientLog = {
  action: ClientLogAction;
  json: ClientLogJson;
};

type SubmitResult = {
  status?: number;
  data?: {
    code?: number;
    msg?: string;
    message?: string;
  };
};

type ActiveSession = {
  songId: string;
  startedAt: number;
  playedMs: number;
  lastResumeMs: number | null;
  duration: number;
  startSubmitted: boolean;
  songName: string;
  artistName: string;
};

const AUTH_COOKIE_KEYS = ["MUSIC_U", "MUSIC_A_T", "MUSIC_R_T", "__csrf", "NMTID"];
const MIN_REPORT_SECONDS = 3;
const IMMEDIATE_PLAY_LOG_DELAY_MS = 400;

const getRawCookie = (key: string): string => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${key}=`);
  if (parts.length === 2) return parts.pop()?.split(";").shift() || "";
  return localStorage.getItem(`cookie-${key}`) || "";
};

const normalizeSongName = (value: unknown): string => String(value ?? "").trim();

const normalizeArtistName = (value: SongType["artists"]): string => {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((artist) => String(artist?.name ?? "").trim())
    .filter(Boolean)
    .join("/");
};

class NcmRecentPlayReporter {
  private activeSession: ActiveSession | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------- 对外生命周期接口 ----------------

  /** 播放 / 恢复播放（对接音频 play 事件） */
  public handlePlay() {
    if (!this.isEnabled()) {
      this.clear();
      return;
    }

    const song = this.getCurrentSong();
    const songId = this.getReportableSongId(song);
    if (!song || !songId) {
      this.finish("interrupt");
      return;
    }

    if (this.activeSession?.songId === songId) {
      if (this.activeSession.lastResumeMs === null) {
        this.activeSession.lastResumeMs = Date.now();
        if (!this.activeSession.startSubmitted) {
          this.scheduleStartReport(songId, this.activeSession.startedAt);
        }
      }
      return;
    }

    this.finish("interrupt");
    this.activeSession = {
      songId,
      startedAt: Date.now(),
      playedMs: 0,
      lastResumeMs: Date.now(),
      duration: this.resolveDurationSeconds(song),
      startSubmitted: false,
      songName: normalizeSongName(song.name),
      artistName: normalizeArtistName(song.artists),
    };
    this.scheduleStartReport(songId, this.activeSession.startedAt);
  }

  /** 暂停播放（对接音频 pause 事件） */
  public handlePause() {
    const session = this.activeSession;
    if (!session) return;
    this.accumulate(session);
    this.clearStartTimer();
  }

  /** 播放结束（对接音频 ended 事件） */
  public handleEnded() {
    this.finish("playend", true);
  }

  /** 中断当前播放（切歌 / 清空列表等） */
  public handleInterrupt() {
    this.finish("interrupt");
  }

  /** 强制结束当前会话 */
  public reset() {
    this.clear();
  }

  // ---------------- 内部实现 ----------------

  /** 安排播放开始日志，避免刚切歌就误报 */
  private scheduleStartReport(songId: string, startedAt: number) {
    this.clearStartTimer();
    this.startTimer = setTimeout(() => {
      const session = this.activeSession;
      if (!session || session.songId !== songId || session.startedAt !== startedAt) return;
      session.startSubmitted = true;
      const logs = this.buildStartLogs(songId);
      void this.submitLogs(logs);
    }, IMMEDIATE_PLAY_LOG_DELAY_MS);
  }

  /** 结束当前会话并按需上报 */
  private finish(end: "interrupt" | "playend", useDurationFallback = false) {
    const session = this.activeSession;
    if (!session) {
      this.clearStartTimer();
      return;
    }

    this.accumulate(session);
    this.clearStartTimer();
    this.activeSession = null;

    const elapsed = this.resolveReportSeconds(session, useDurationFallback);
    if (elapsed < MIN_REPORT_SECONDS) return;

    const logs = [this.buildEndLog(session.songId, elapsed, end)];
    void this.submitLogs(logs);
    void this.submitDesktopScrobble(session, elapsed);
  }

  /** 累计当前播放片段 */
  private accumulate(session: ActiveSession) {
    if (session.lastResumeMs === null) return;
    session.playedMs += Date.now() - session.lastResumeMs;
    session.lastResumeMs = null;
  }

  /** 结束上报秒数 */
  private resolveReportSeconds(session: ActiveSession, useDurationFallback: boolean): number {
    const seekSeconds = this.resolveCurrentPlaybackSeconds();
    const playedSeconds = Math.round(session.playedMs / 1000);
    const elapsed = Math.max(seekSeconds, playedSeconds);
    if (useDurationFallback && session.duration > 0) return Math.max(elapsed, session.duration);
    return elapsed;
  }

  /** 播放开始日志 */
  private buildStartLogs(songId: string): ClientLog[] {
    const content = this.buildOfficialContent();
    const sourceFields = this.buildSourceFields();
    return [
      this.withOfficialFields("startplay", {
        id: songId,
        type: "song",
        content,
      }),
      this.withOfficialFields("play", {
        id: songId,
        type: "song",
        content,
        ...sourceFields,
      }),
    ];
  }

  /** 播放结束日志 */
  private buildEndLog(songId: string, time: number, end: "interrupt" | "playend"): ClientLog {
    const content = this.buildOfficialContent();
    const sourceFields = this.buildSourceFields();
    return this.withOfficialFields("play", {
      id: songId,
      type: "song",
      time,
      end,
      wifi: 0,
      download: 0,
      content,
      ...sourceFields,
    });
  }

  /** 补齐官方客户端字段 */
  private withOfficialFields(action: ClientLogAction, json: ClientLogJson): ClientLog {
    return {
      action,
      json: {
        ...json,
        mainsite: "1",
        mainsiteWeb: "1",
      },
    };
  }

  /** 提交上报（失败仅告警，不影响播放） */
  private async submitLogs(logs: ClientLog[]) {
    if (!this.isEnabled() || !isElectron || logs.length === 0) return;
    if (typeof window.electron?.ipcRenderer?.invoke !== "function") return;

    const cookie = this.buildAuthCookieString();
    if (!cookie) return;

    try {
      const response = (await window.electron.ipcRenderer.invoke("ncm-client-log-submit", {
        logs,
        cookie,
        timeout: 8000,
      })) as SubmitResult | null;

      if (response?.status && (response.status < 200 || response.status >= 300)) {
        console.warn("网易云最近播放上报失败:", response.status, response.data);
      }

      const code = Number(response?.data?.code);
      if (code && code !== 200) {
        console.warn("网易云最近播放上报返回异常:", response?.data);
      }
    } catch (error) {
      console.warn("网易云最近播放上报失败:", error);
    }
  }

  /** 提交桌面客户端格式的 PLV / PLD 统计上报 */
  private async submitDesktopScrobble(session: ActiveSession, time: number) {
    if (!this.isEnabled() || !isElectron) return;
    if (typeof window.electron?.ipcRenderer?.invoke !== "function") return;
    try {
      const response = (await window.electron.ipcRenderer.invoke("ncm-scrobble-v1-submit", {
        id: session.songId,
        sourceid: this.resolveSourceId() || session.songId,
        source: "list",
        time,
        total: session.duration > 0 ? session.duration : time,
        name: session.songName,
        artist: session.artistName,
      })) as SubmitResult | null;

      if (response?.status && (response.status < 200 || response.status >= 300)) {
        console.warn("网易云听歌统计上报失败:", response.status, response.data);
      }

      const code = Number(response?.data?.code);
      if (code && code !== 200) {
        console.warn("网易云听歌统计上报返回异常:", response?.data);
      }
    } catch (error) {
      console.warn("网易云听歌统计上报失败:", error);
    }
  }

  /** 构造登录 Cookie */
  private buildAuthCookieString(): string {
    return AUTH_COOKIE_KEYS.map((key) => {
      const value = getRawCookie(key);
      return value ? `${key}=${value}` : "";
    })
      .filter(Boolean)
      .join("; ");
  }

  /** 清空会话与定时器 */
  private clear() {
    this.clearStartTimer();
    this.activeSession = null;
  }

  private clearStartTimer() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  // ---------------- 工具方法 ----------------

  /** 是否启用上报：需开启同步且为正常 Cookie 登录 */
  private isEnabled(): boolean {
    const settingStore = useSettingStore();
    return settingStore.neteaseScrobbleEnabled && isLogin() === 1;
  }

  private getCurrentSong(): SongType | null {
    const musicStore = useMusicStore();
    return musicStore.playSong ?? null;
  }

  /** 当前播放器进度秒数 */
  private resolveCurrentPlaybackSeconds(): number {
    const statusStore = useStatusStore();
    const ms = Number(statusStore.currentTime);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.round(ms / 1000);
  }

  /**
   * 返回可上报的网易云歌曲 id；不可上报时返回空串。
   * 排除本地文件、流媒体与第三方媒体库，且 id 必须为正整数。
   */
  private getReportableSongId(song: SongType | null): string {
    if (!song) return "";
    if (song.path) return "";
    if (song.type === "streaming" || song.source === "streaming") return "";
    if (song.serverType || song.originalId) return "";
    const text = String(song.id ?? "").trim();
    if (!/^[1-9]\d*$/.test(text)) return "";
    return text;
  }

  /** 歌曲时长（秒）。SPlayer 的 duration 单位为毫秒 */
  private resolveDurationSeconds(song: SongType): number {
    const ms = Number(song.duration);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.round(ms / 1000);
  }

  /** 来源歌单 id */
  private resolveSourceId(): string {
    const musicStore = useMusicStore();
    const playlistId = Number(musicStore.playPlaylistId);
    return Number.isFinite(playlistId) && playlistId > 0 ? String(playlistId) : "";
  }

  /** 来源字段 */
  private buildSourceFields(): ClientLogJson {
    const sourceId = this.resolveSourceId();
    if (!sourceId) return {};
    return {
      source: "list",
      sourceId,
      sourceid: sourceId,
    };
  }

  /** 官方 content 字段 */
  private buildOfficialContent(): string {
    const sourceId = this.resolveSourceId();
    return sourceId ? `id=${sourceId}` : "";
  }
}

const ncmRecentPlayReporter = new NcmRecentPlayReporter();

export default ncmRecentPlayReporter;
