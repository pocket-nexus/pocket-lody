// pocket-lody/app/format.ts — values as a person reads them.
import type { SessionRow, SessionState } from "../protocol.ts";

/** How long ago, in the shortest form a list has room for: "now", "5m", "3h", "2d", "4w". */
export function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** "42s", "3m 05s", "1h 12m" */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export const STATE_LABEL: Record<SessionState, string> = { idle: "Idle", starting: "Starting", running: "Working", waiting: "Needs you", failed: "Failed" };

export type Tone = "plain" | "accent" | "good" | "warn" | "bad" | "note" | "muted";
export const STATE_TONE: Record<SessionState, Tone> = { idle: "muted", starting: "accent", running: "accent", waiting: "warn", failed: "bad" };

export interface SessionGroup {
  id: string;
  title: string;
  rows: SessionRow[];
}

/** The list as Lody's Status view orders it: what needs a person first, then what is working, what just changed and was not read, then the rest by recency. Child tabs follow their parent. */
export function groupSessions(rows: readonly SessionRow[], filter: string): SessionGroup[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (row: SessionRow) => words.every((word) => `${row.title} ${row.project ?? ""} ${row.branch ?? ""} ${row.agent ?? ""}`.toLowerCase().includes(word));
  const shown = rows.filter((row) => !row.archived && !row.parentId && (words.length === 0 || matches(row)));
  const byRecent = (a: SessionRow, b: SessionRow) => b.updatedAt - a.updatedAt;
  const groups: SessionGroup[] = [
    { id: "waiting", title: "Needs you", rows: shown.filter((row) => row.state === "waiting" || row.state === "failed").sort(byRecent) },
    { id: "running", title: "Working", rows: shown.filter((row) => row.state === "running" || row.state === "starting").sort(byRecent) },
    { id: "unread", title: "Unread", rows: shown.filter((row) => row.state === "idle" && row.unread).sort(byRecent) },
    { id: "recent", title: "Recent", rows: shown.filter((row) => row.state === "idle" && !row.unread).sort(byRecent) },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

/** The one line under a session's title. */
export function sessionDetail(row: SessionRow): string {
  const parts: string[] = [];
  if (row.project) parts.push(row.project.includes("/") ? row.project.slice(row.project.indexOf("/") + 1) : row.project);
  if (row.agent) parts.push(row.agent);
  return parts.join(" - ");
}
