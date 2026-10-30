/**
 * The load test.
 *
 * Two questions, answered separately because they fail separately:
 *
 * 1. **HTTP**: how many requests a second the public reads serve, and how long the
 *    slow ones take. Measured against a running server, because a response time
 *    measured in-process is not a response time.
 * 2. **CPU**: how many games a second the simulator plays on this machine, which
 *    is what decides whether a 275 market price fits inside its budget.
 *
 * Every number is measured, never estimated: the percentiles are over the actual
 * latencies, and the throughput is counted requests divided by elapsed seconds.
 *
 * Usage:
 *   npm run loadtest -- --url http://localhost:2567 --seconds 20 --concurrency 50
 */

import { z } from "zod";
import { createLudoGameRunner, seededUniform } from "../src/odds/ludo-sim.js";

const flagsSchema = z.object({
  url: z.string().url().default("http://localhost:2567"),
  seconds: z.coerce.number().int().min(1).max(600).default(10),
  concurrency: z.coerce.number().int().min(1).max(500).default(25),
  matches: z.coerce.number().int().min(0).max(200_000).default(2_000),
  games: z.coerce.number().int().min(0).max(100_000).default(200),
});

type Flags = z.infer<typeof flagsSchema>;

function parseFlags(argv: readonly string[]): Flags {
  const raw: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      raw[name] = "true";
      continue;
    }
    raw[name] = value;
    index += 1;
  }

  const parsed = flagsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`invalid flags:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

/** The value at a percentile of a sorted list, using the nearest-rank method. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

interface Sample {
  readonly label: string;
  readonly status: number;
  readonly durationMs: number;
}

const readPaths = ["/health", "/api/bots", "/api/matches?limit=20", "/api/players?limit=20"];

/** One worker: request, measure, repeat, until the deadline. */
async function worker(
  base: string,
  deadline: number,
  index: number,
  samples: Sample[],
  errors: string[],
): Promise<void> {
  let call = 0;
  while (Date.now() < deadline) {
    const path = readPaths[(index + call) % readPaths.length] ?? "/health";
    const startedAt = performance.now();
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      // The body is drained: an unread body keeps the socket busy and would make
      // the measurement a lie.
      await response.text();
      samples.push({
        label: path,
        status: response.status,
        durationMs: performance.now() - startedAt,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      // A refused connection returns at once: without a pause the run becomes a
      // tight retry loop that measures nothing and says nothing useful.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    call += 1;
  }
}

/** Games a second through the simulator, on one core, from the seed. */
function cpuBenchmark(games: number): {
  readonly gamesPerSecond: number;
  readonly msPerGame: number;
} {
  const runner = createLudoGameRunner({
    policies: { 0: "cautious", 1: "cautious", 2: "cautious", 3: "cautious" },
  });
  const startedAt = performance.now();
  for (let index = 0; index < games; index += 1) {
    runner.play({ random: seededUniform(`loadtest:${String(index)}`) });
  }
  const elapsedMs = performance.now() - startedAt;
  return {
    gamesPerSecond: elapsedMs === 0 ? 0 : Math.round((games / elapsedMs) * 1000),
    msPerGame: Number((elapsedMs / Math.max(1, games)).toFixed(3)),
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const base = flags.url.replace(/\/$/, "");

  console.log(
    `load test: ${base}, ${String(flags.concurrency)} workers for ${String(flags.seconds)}s`,
  );

  const samples: Sample[] = [];
  const errors: string[] = [];
  const startedAt = Date.now();
  const deadline = startedAt + flags.seconds * 1000;

  await Promise.all(
    Array.from({ length: flags.concurrency }, (_, index) =>
      worker(base, deadline, index, samples, errors),
    ),
  );

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const statusCounts = new Map<number, number>();
  for (const sample of samples) {
    statusCounts.set(sample.status, (statusCounts.get(sample.status) ?? 0) + 1);
  }

  console.log("");
  console.log(`requests      ${String(samples.length)} in ${elapsedSeconds.toFixed(1)}s`);
  console.log(`throughput    ${(samples.length / elapsedSeconds).toFixed(1)} req/s`);
  console.log(`latency p50   ${percentile(durations, 0.5).toFixed(1)} ms`);
  console.log(`latency p95   ${percentile(durations, 0.95).toFixed(1)} ms`);
  console.log(`latency p99   ${percentile(durations, 0.99).toFixed(1)} ms`);
  console.log(
    `statuses      ${[...statusCounts.entries()].map(([status, count]) => `${String(status)}×${String(count)}`).join(" ")}`,
  );
  if (errors.length > 0) {
    console.log(`errors        ${String(errors.length)}, first: ${errors[0] ?? ""}`);
    if (samples.length === 0) {
      console.log(`              no response at all: is a server listening on ${base}?`);
    }
  }

  if (flags.games > 0) {
    const cpu = cpuBenchmark(flags.games);
    console.log("");
    console.log(`simulator     ${String(cpu.gamesPerSecond)} ludo games/s on one core`);
    console.log(`              ${String(cpu.msPerGame)} ms per game`);
  }

  const failed = errors.length > 0 || [...statusCounts.keys()].some((status) => status >= 500);
  if (failed) {
    console.error("load test failed: there were errors or 5xx responses");
    process.exitCode = 1;
  }
}

await main();
