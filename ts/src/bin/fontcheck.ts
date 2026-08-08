#!/usr/bin/env node
/** Entry point for the font checker. See `src/bin/README.md`. */
import { main } from "../fontcheck.ts";
process.exit(await main());
