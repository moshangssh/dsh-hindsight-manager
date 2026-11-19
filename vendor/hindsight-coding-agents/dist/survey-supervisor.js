#!/usr/bin/env node

// src/core/survey-lease.ts
import { spawn as realSpawn } from "child_process";
import { randomUUID } from "crypto";
import {
  mkdirSync as mkdirSync2,
  mkdtempSync,
  readdirSync,
  renameSync as renameSync2,
  rmdirSync,
  rmSync,
  statSync as statSync2,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "fs";
import { join as join2 } from "path";

// src/core/log.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
function logsDir() {
  return join(homedir(), ".hindsight", "coding-agents-logs");
}
var LOG_MAX_BYTES = 10 * 1024 * 1024;
function appendLogLine(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 448 });
  try {
    if (statSync(file).size >= LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
  }
  appendFileSync(file, text, { mode: 384 });
}
var WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };
var current = ["debug", "info", "warn", "error"].find(
  (l) => l === process.env.HINDSIGHT_LOG_LEVEL
) ?? "info";
function logFilePath() {
  return process.env.HINDSIGHT_LOG_FILE || join(logsDir(), "plugin.log");
}
function write(level, scope, msg, extra) {
  if (WEIGHT[level] < WEIGHT[current]) return;
  try {
    appendLogLine(
      logFilePath(),
      `${(/* @__PURE__ */ new Date()).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}` + (extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "") + "\n"
    );
  } catch {
  }
}
var log = {
  debug: (scope, msg, extra) => write("debug", scope, msg, extra),
  info: (scope, msg, extra) => write("info", scope, msg, extra),
  warn: (scope, msg, extra) => write("warn", scope, msg, extra),
  error: (scope, msg, extra) => write("error", scope, msg, extra)
};
function describeError(value, maxChars = 200) {
  const parts = [];
  const seen = /* @__PURE__ */ new Set();
  let current2 = value;
  while (current2 && !seen.has(current2)) {
    seen.add(current2);
    const error = current2;
    const text = typeof error.message === "string" ? error.message : String(current2);
    const withCode = error.code ? `${text} (${String(error.code)})` : text;
    if (withCode && parts.at(-1) !== withCode) parts.push(withCode);
    current2 = error.cause;
  }
  return (parts.join(": ") || String(value)).slice(0, maxChars);
}

// src/core/survey-lease.ts
var LEASE_HEARTBEAT_MS = 5e3;
var SURVEY_SPEC_ENV = "HINDSIGHT_SURVEY_SPEC";
function releaseLease(lease) {
  try {
    unlinkSync(join2(lease.directory, lease.owner));
  } catch {
    return;
  }
  try {
    rmdirSync(lease.directory);
  } catch {
  }
}
function heartbeatLease(lease) {
  try {
    const now = /* @__PURE__ */ new Date();
    utimesSync(join2(lease.directory, lease.owner), now, now);
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}
function superviseSurvey(spec2, spawnFn = realSpawn) {
  let stop = () => {
  };
  const done = new Promise((resolve) => {
    if (!heartbeatLease(spec2.lease)) return resolve();
    let child;
    try {
      child = spawnFn(spec2.bin, spec2.args, { stdio: "ignore", windowsHide: true });
    } catch (e) {
      log.warn("survey", `${spec2.bin} failed to launch: ${describeError(e)}`);
      releaseLease(spec2.lease);
      return resolve();
    }
    let finished = false;
    const finish = (release) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (release) releaseLease(spec2.lease);
      resolve();
    };
    const timer = setInterval(() => {
      if (heartbeatLease(spec2.lease)) return;
      child.kill();
      finish(false);
    }, spec2.heartbeatMs ?? LEASE_HEARTBEAT_MS);
    child.on("error", (e) => {
      log.warn("survey", `${spec2.bin} failed to launch: ${describeError(e)}`);
      finish(true);
    });
    child.once("exit", (code, signal) => {
      if (code !== 0 && !finished)
        log.warn("survey", `${spec2.bin} exited with ${code === null ? signal : `code ${code}`}`);
      finish(true);
    });
    stop = () => {
      child.kill();
      finish(true);
    };
  });
  return { done, stop: () => stop() };
}

// src/survey-supervisor.ts
var spec = JSON.parse(process.env[SURVEY_SPEC_ENV] ?? "");
delete process.env[SURVEY_SPEC_ENV];
var run = superviseSurvey(spec);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, run.stop);
void run.done;
