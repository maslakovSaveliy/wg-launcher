// The adapters bundled with the app, validated when this module loads (save-transfer.md section 8).
import progressLab from "./progress-lab.json" with { type: "json" };
import { type Adapter, parseAdapter } from "./schema.js";

export const ADAPTERS: readonly Adapter[] = [parseAdapter(progressLab)];
