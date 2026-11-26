import { describe, expect, test } from "bun:test";
import { inspectDataDir, resolveDataDir } from "../src/data-dir.ts";

describe("data dir", () => {
  test("DATA_DIR wins, then the Railway Volume mount, then ./data", () => {
    expect(resolveDataDir({ DATA_DIR: "/x", RAILWAY_VOLUME_MOUNT_PATH: "/vol" })).toBe("/x");
    expect(resolveDataDir({ RAILWAY_VOLUME_MOUNT_PATH: "/vol" })).toBe("/vol");
    expect(resolveDataDir({})).toBe("data");
  });

  test("Volume mounted somewhere else than the bot writes → no warning only when it is inside", () => {
    expect(inspectDataDir({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data" }).warning).toBeNull();
    expect(
      inspectDataDir({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data", DATA_DIR: "/data/bot" })
        .warning,
    ).toBeNull();
    expect(
      inspectDataDir({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data", DATA_DIR: "/app/data" })
        .warning,
    ).toContain("not inside the Railway Volume");
  });

  test("on Railway with no Volume → warns; locally → silent", () => {
    expect(inspectDataDir({ RAILWAY_ENVIRONMENT: "production" }).warning).toContain("No Railway Volume");
    expect(inspectDataDir({}).warning).toBeNull();
  });
});
