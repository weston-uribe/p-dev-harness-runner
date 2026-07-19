#!/usr/bin/env node
import { createProgram } from "./cli/program.js";
import { finalizeCliExit } from "./cli/finalize-exit.js";
import { loadHarnessDotenv } from "./config/load-dotenv.js";

loadHarnessDotenv();

const program = createProgram();
await program.parseAsync(process.argv);
finalizeCliExit(process.exitCode);
