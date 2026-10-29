import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BRIDGE_CHANNELS, BRIDGE_VERSION } from "./bridge.js";
import {
  IPC_CHANNELS,
  IPC_CONTRACT,
  type IpcChannel,
  MAX_IPC_PAYLOAD_BYTES,
  taskProgressEventSchema,
} from "./ipc.js";

const ID = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";

/** One valid request per channel (architecture.md section 6). */
const VALID: { [C in IpcChannel]: Record<string, unknown> } = {
  "library:list": {},
  "library:add": { url: "https://example.com/", title: "Example" },
  "library:update": { gameId: ID, title: "New", cover: "pick" },
  "library:remove": { gameId: ID },
  "library:orphans": {},
  "library:deleteOrphanData": { gameId: ID },
  "game:launch": { gameId: ID },
  "game:focus": { gameId: ID },
  "game:clearCache": { gameId: ID },
  "game:deleteSaves": { gameId: ID },
  "shortcut:create": { gameId: ID },
  "snapshot:export": {
    gameId: ID,
    frameKeys: [{ origin: "http://127.0.0.1:4317", topLevelSite: "http://localhost" }],
  },
  "snapshot:import": {
    gameId: ID,
    source: { revisionId: ID },
    mapping: [{ from: "http://localhost:4317", to: "http://127.0.0.1:4317" }],
  },
  "snapshot:verify": { gameId: ID, revisionId: ID },
  "snapshot:recover": { gameId: ID },
  "snapshot:list": { gameId: ID },
  "snapshot:saveAs": { gameId: ID, revisionId: ID },
  "settings:get": {},
  "settings:set": {},
};

const request = (channel: IpcChannel) => IPC_CONTRACT[channel].request as z.ZodType;

/** Every object schema reachable from `schema`, so nested objects are checked too. */
function objectsIn(schema: z.ZodType): z.ZodObject[] {
  if (schema instanceof z.ZodObject) {
    return [schema, ...Object.values(schema.shape).flatMap((s) => objectsIn(s as z.ZodType))];
  }
  if (schema instanceof z.ZodArray) return objectsIn(schema.element as z.ZodType);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return objectsIn(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodUnion) return schema.options.flatMap((s) => objectsIn(s as z.ZodType));
  return [];
}

describe("IPC contract (architecture.md section 6)", () => {
  it("has exactly the channels in scope, and the bridge has one function per channel", () => {
    expect([...IPC_CHANNELS].sort()).toEqual(Object.keys(VALID).sort());
    expect(Object.values(BRIDGE_CHANNELS).sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it.each(IPC_CHANNELS)(
    "%s: every request and response object is a z.strictObject (M7)",
    (channel) => {
      const { request: req, response } = IPC_CONTRACT[channel];
      const objects = [...objectsIn(req as z.ZodType), ...objectsIn(response as z.ZodType)];
      expect(objects.length).toBeGreaterThan(0);
      for (const object of objects) {
        expect(object.def.catchall?._zod.def.type).toBe("never");
      }
    },
  );

  it.each(IPC_CHANNELS)("%s: the valid sample parses and an unknown key is rejected", (channel) => {
    expect(request(channel).safeParse(VALID[channel]).success).toBe(true);
    expect(request(channel).safeParse({ ...VALID[channel], extra: 1 }).success).toBe(false);
    expect(request(channel).safeParse(null).success).toBe(false);
    expect(request(channel).safeParse([]).success).toBe(false);
  });

  it.each([
    ["upper case", ID.toUpperCase()],
    ["UUIDv4", "0190a5b2-7c3d-4e4f-8a1b-2c3d4e5f6a7b"],
    ["wrong variant", "0190a5b2-7c3d-7e4f-ca1b-2c3d4e5f6a7b"],
    ["surrounding space", ` ${ID}`],
    ["not a string", 42],
  ])("rejects an id that is not a lowercase UUIDv7: %s", (_name, gameId) => {
    for (const channel of [
      "library:remove",
      "game:launch",
      "game:focus",
      "shortcut:create",
    ] as const) {
      expect(request(channel).safeParse({ gameId }).success).toBe(false);
    }
  });

  it("titles are 1 to 200 characters after trimming and are returned trimmed", () => {
    const add = IPC_CONTRACT["library:add"].request;
    expect(add.parse({ url: "https://a.example/", title: "  Lab  " }).title).toBe("Lab");
    expect(add.safeParse({ url: "https://a.example/", title: "   " }).success).toBe(false);
    expect(add.safeParse({ url: "https://a.example/", title: "x".repeat(200) }).success).toBe(true);
    expect(add.safeParse({ url: "https://a.example/", title: "x".repeat(201) }).success).toBe(
      false,
    );
    // Characters, not UTF-16 code units: 200 emoji are 400 code units.
    expect(add.safeParse({ url: "https://a.example/", title: "🎮".repeat(200) }).success).toBe(
      true,
    );
    expect(add.parse({ url: "https://a.example/" }).title).toBeUndefined();
  });

  it("library:update needs a title or a cover action, and only pick or remove", () => {
    const update = IPC_CONTRACT["library:update"].request;
    expect(update.safeParse({ gameId: ID }).success).toBe(false);
    expect(update.safeParse({ gameId: ID, cover: "remove" }).success).toBe(true);
    expect(update.safeParse({ gameId: ID, cover: "/etc/passwd" }).success).toBe(false);
    expect(update.safeParse({ gameId: ID, title: "T" }).success).toBe(true);
  });

  it("settings have no allowlisted key yet, so any key is refused", () => {
    expect(IPC_CONTRACT["settings:set"].request.safeParse({ theme: "dark" }).success).toBe(false);
  });

  it("the payload limit is 64 KiB", () => {
    expect(MAX_IPC_PAYLOAD_BYTES).toBe(65_536);
  });
});

describe("snapshot channels and task progress (architecture.md section 6)", () => {
  const exportRequest = request("snapshot:export");

  it("bumps the bridge version for the restore, verify, recovery and delete functions", () => {
    expect(BRIDGE_VERSION).toBe(5);
  });

  it("snapshot:import takes a stored revision or a file chosen in main, and up to 32 origin mappings", () => {
    const importRequest = request("snapshot:import");
    const map = { from: "http://a.test", to: "http://b.test" };
    expect(importRequest.safeParse({ gameId: ID, source: "file" }).success).toBe(true);
    expect(
      importRequest.safeParse({
        gameId: ID,
        source: { revisionId: ID },
        mapping: Array(32).fill(map),
      }).success,
    ).toBe(true);
    expect(
      importRequest.safeParse({ gameId: ID, source: "file", mapping: Array(33).fill(map) }).success,
    ).toBe(false);
    // No path ever crosses IPC.
    expect(importRequest.safeParse({ gameId: ID, source: { path: "/x.wgsnap" } }).success).toBe(
      false,
    );
    expect(
      importRequest.safeParse({ gameId: ID, source: "file", mapping: [{ ...map, via: "x" }] })
        .success,
    ).toBe(false);
  });

  it("snapshot:export takes up to 32 frame keys, each an origin and a top-level site or null", () => {
    const key = { origin: "https://a.example", topLevelSite: null };
    expect(exportRequest.safeParse({ gameId: ID }).success).toBe(true);
    expect(exportRequest.safeParse({ gameId: ID, frameKeys: Array(32).fill(key) }).success).toBe(
      true,
    );
    expect(exportRequest.safeParse({ gameId: ID, frameKeys: Array(33).fill(key) }).success).toBe(
      false,
    );
    expect(
      exportRequest.safeParse({ gameId: ID, frameKeys: [{ ...key, path: "/x" }] }).success,
    ).toBe(false);
    expect(exportRequest.safeParse({ gameId: ID, frameKeys: [{ origin: "x" }] }).success).toBe(
      false,
    );
  });

  it("snapshot rows carry no file path", () => {
    const row = IPC_CONTRACT["snapshot:list"].response.shape.snapshots.element;
    expect(Object.keys(row.shape)).not.toContain("path");
  });

  it("task progress has real steps and measured bytes only, and a code with a failure", () => {
    const base = { taskId: ID, gameId: ID, kind: "export", step: "read", status: "running" };
    expect(taskProgressEventSchema.safeParse({ ...base, bytesDone: 10 }).success).toBe(true);
    expect(taskProgressEventSchema.safeParse({ ...base, percent: 50 }).success).toBe(false);
    expect(taskProgressEventSchema.safeParse({ ...base, bytesDone: -1 }).success).toBe(false);
    expect(
      taskProgressEventSchema.safeParse({
        ...base,
        status: "failed",
        code: "SNAP_TOTAL_TOO_LARGE",
        message: "The save data is above a snapshot limit.",
      }).success,
    ).toBe(true);
    expect(
      taskProgressEventSchema.safeParse({ ...base, status: "failed", code: "NOPE" }).success,
    ).toBe(false);
  });
});
