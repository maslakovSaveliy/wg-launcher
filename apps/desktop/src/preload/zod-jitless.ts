// Imported first by the quiescent preload, before any schema exists. zod 4 compiles object parsers with
// `new Function` and probes `new Function("")` when a schema is built; in the quiescent window every such script
// shows up in the canary as code outside our preload (a 28-character script without a URL), which stops the job.
// Without JIT, zod builds no code at all, so the preload runs only its own file (save-transfer.md section 5, QW-5).
import { z } from "zod";

z.config({ jitless: true });
