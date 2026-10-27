import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type Launched, launchApp } from "./harness.js";

let launched: Launched | undefined;
test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test("the main process opens the library database at schema version 1 without a warning", async () => {
  launched = await launchApp();
  const { app, userData } = launched;

  // The harness gives Chromium its own --user-data-dir (appArgs), so even a crash while the app loads cannot write
  // into the real default profile. This is the regression test for that: the switch is on the command line.
  expect(await app.evaluate(({ app }) => app.commandLine.getSwitchValue("user-data-dir"))).toBe(
    userData,
  );

  const { database, warnings } = await launched.hooks();
  expect(database).toEqual({ readOnly: false, userVersion: 1 });
  expect(existsSync(join(userData, "library.db"))).toBe(true);
  // A fresh library has nothing to back up.
  expect(readdirSync(join(userData, "backups"))).toEqual([]);
  // Electron 45's Node prints no ExperimentalWarning for node:sqlite (plain Node 24.13 does).
  expect(
    warnings.filter((w) => /sqlite|experimental/i.test(`${w.name} ${w.message}`)),
    JSON.stringify(warnings),
  ).toEqual([]);

  // Control: the recorder does see a warning emitted in the main process.
  await app.evaluate(() => process.emitWarning("e2e probe"));
  await expect
    .poll(async () => (await launched?.hooks())?.warnings.some((w) => w.message === "e2e probe"))
    .toBe(true);
});
