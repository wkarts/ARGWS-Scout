import { readFileSync } from "node:fs";

/** Version shipped with the API image, independent of stale .env values. */
export const buildVersion = (JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }).version;
