#!/usr/bin/env node
/** Entry point for the batch exporter. See `src/bin/README.md`. */
import { main } from "../cli.ts";
process.exit(await main());
