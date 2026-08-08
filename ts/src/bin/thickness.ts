#!/usr/bin/env node
/** Entry point for the thin-area survey. See `src/bin/README.md`. */
import { main } from "../thickness.ts";
process.exit(await main());
