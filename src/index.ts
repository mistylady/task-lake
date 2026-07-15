#!/usr/bin/env bun

import { text } from "node:stream/consumers";
import { runCli } from "./cli.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
  readStdin: async () => await text(process.stdin),
  stdoutIsTTY: process.stdout.isTTY === true,
  now: () => new Date(),
  storage: { env: process.env },
});
