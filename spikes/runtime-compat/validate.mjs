// THROWAWAY spike (runtime-compat). Validates result files against results.schema.json.
//   node validate.mjs results/*.json
// Uses ajv from electron/node_modules (the spike's only lockfile); exits 1 on any invalid file.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve(import.meta.dirname, "electron/package.json"));
const Ajv2020 = require("ajv/dist/2020").default;

export function makeValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "results.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  return (data) => (validate(data) ? null : ajv.errorsText(validate.errors, { separator: "; " }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const check = makeValidator();
  let bad = 0;
  for (const file of process.argv.slice(2)) {
    const error = check(JSON.parse(readFileSync(file, "utf8")));
    if (error) bad++;
    console.log(`${error ? "INVALID" : "valid  "} ${file}${error ? `: ${error}` : ""}`);
  }
  process.exit(bad ? 1 : 0);
}
