/**
 * The tick (RW-3): which versions did npm publish since the last one seen.
 * Versions skip numbers and several arrive a day, so "last seen + 1" is wrong:
 * the registry's `time` list is walked instead.
 */

export type Platform = "claude-code" | "codex";

export interface RegistryDoc {
  name?: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
}

export interface TickResult {
  platform: Platform;
  latest: string | null;
  /** Claude Code only: recorded, never a trigger. */
  stable: string | null;
  since: string;
  versions: string[];
}

const PLAIN = /^\d+\.\d+\.\d+$/;

/** Codex publishes every platform build as its own version and many alphas: only plain x.y.z is a release. */
export const isStableCodex = (v: string): boolean => PLAIN.test(v);
const isStableClaude = (v: string): boolean => PLAIN.test(v);

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
  const pb = b.split(/[.-]/).map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export class BlindTick extends Error {}

/** Every stable version published after `since`, oldest first. */
export function newVersions(platform: Platform, doc: RegistryDoc, since: string): TickResult {
  const time = doc.time;
  if (!time || typeof time !== "object" || Object.keys(time).length === 0) {
    throw new BlindTick("the registry document has no time list");
  }
  const stable = platform === "codex" ? isStableCodex : isStableClaude;
  const all = Object.keys(time).filter((k) => k !== "created" && k !== "modified" && stable(k));
  let versions: string[];
  if (time[since]) {
    versions = all.filter((v) => time[v] > time[since]).sort((a, b) => (time[a] < time[b] ? -1 : time[a] > time[b] ? 1 : 0));
  } else {
    versions = all.filter((v) => compareVersions(v, since) > 0).sort(compareVersions);
  }
  const tags = doc["dist-tags"] ?? {};
  return { platform, latest: tags.latest ?? null, stable: platform === "claude-code" ? tags.stable ?? null : null, since, versions };
}

/** 0 on no change, 10 on new versions. */
export const tickExitCode = (versions: string[]): number => (versions.length ? 10 : 0);
