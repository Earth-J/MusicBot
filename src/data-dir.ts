/**
 * Where the bot keeps its files (setup.json = music rooms, music-history.db = song history).
 *
 * Order: DATA_DIR → the Railway Volume's mount path (Railway sets RAILWAY_VOLUME_MOUNT_PATH itself
 * whenever a Volume is attached to the service) → ./data.
 *
 * Why the Railway fallback: the container's own filesystem is wiped on every deploy / restart. If
 * the Volume is mounted somewhere other than the folder the bot writes to (e.g. Volume at /data,
 * bot writing to /app/data), everything "works" but is silently lost at the next restart. Following
 * the mount path automatically removes that whole class of mistakes.
 */
import path from "node:path";

type Env = Record<string, string | undefined>;

export interface DataDirInfo {
  /** Folder the bot writes to. */
  dir: string;
  /** Mount path of the attached Railway Volume, or null. */
  volume: string | null;
  /** Running on Railway (any RAILWAY_* deployment variable is present). */
  onRailway: boolean;
  /** Something that will make the data vanish on restart — null when everything looks fine. */
  warning: string | null;
}

export function resolveDataDir(env: Env = process.env): string {
  return env.DATA_DIR?.trim() || env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || "data";
}

export function inspectDataDir(env: Env = process.env): DataDirInfo {
  const dir = resolveDataDir(env);
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || null;
  const onRailway = !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);

  let warning: string | null = null;
  if (volume) {
    const rel = path.relative(path.resolve(volume), path.resolve(dir));
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (!inside) {
      warning = `DATA_DIR (${dir}) is not inside the Railway Volume (${volume}) — history and setup will be lost on restart. Remove DATA_DIR or set it to ${volume}.`;
    }
  } else if (onRailway) {
    warning =
      "No Railway Volume is attached to this service — history and setup are wiped on every restart / deploy. " +
      "Add one: right-click the project canvas (or press Ctrl/⌘+K) → Volume → pick the bot service → mount path /app/data.";
  }
  return { dir, volume, onRailway, warning };
}
