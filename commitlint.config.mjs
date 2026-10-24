import conventional from "@commitlint/config-conventional";

const [level, applicable, types] = conventional.rules["type-enum"];

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // `spike` marks throwaway runtime experiments (AGENTS.md, "Workflow"); it is not a standard type.
    "type-enum": [level, applicable, [...types, "spike"]],
  },
};
