import fs from "node:fs";
import { selftest } from "../lib/selftest.mjs";

const data = await selftest();
fs.writeFileSync(new URL("../scores.json", import.meta.url), JSON.stringify(data, null, 1) + "\n", "utf8");
console.log("scores.json updated successfully");
