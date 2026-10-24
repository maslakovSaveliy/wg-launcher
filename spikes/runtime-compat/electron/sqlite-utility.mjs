// THROWAWAY spike (runtime-compat). H10 in a utilityProcess: runs the same steps as the main process.
import { runSqliteAndZstd } from "./sqlite-steps.mjs";

process.parentPort.once("message", async (event) => {
  try {
    const result = await runSqliteAndZstd(event.data.dbPath);
    process.parentPort.postMessage({ ...result, processType: process.type ?? null, pid: process.pid });
  } catch (error) {
    process.parentPort.postMessage({ ok: false, error: String(error?.stack ?? error) });
  }
});
