// The migration files are imported as strings with Vite's `?raw` suffix (see migrate.ts). Vite's own client types
// declare this too, but the main process is type-checked without them.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
