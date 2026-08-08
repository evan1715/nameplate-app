#!/usr/bin/env node
/** Entry point for the app: the API, and the page it serves. See `README.md`. */
import { APP_NAME, FONTS_DIR, SETTINGS_PATH } from "../app.ts";
import { serve } from "../server.ts";

const argv = process.argv.slice(2);
const at = argv.indexOf("--port");
const server = await serve(at >= 0 ? Number(argv[at + 1]) : 8175);
const { port } = server.address() as { port: number };
console.log(APP_NAME);
console.log(`  open http://127.0.0.1:${port}/`);
console.log(`  fonts   ${FONTS_DIR}`);
console.log(`  settings ${SETTINGS_PATH}`);
