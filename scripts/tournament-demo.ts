import { env } from "../src/lib/env.js";

/**
 * npm run tournament:demo -- [--players 8] [--level club] [--fee 0] [--timeout 900]
 *
 * API_URL overrides the server address; the port comes from the environment.
 *
 * The end-to-end demonstration, against a running server: create a tournament
 * through the admin API, open it, let the scheduler fill it with labelled bots and
 * play it out, then print the champion, the prize split, and the matches to
 * verify.
 *
 * Everything here goes over HTTP with the admin key, so it exercises the routes,
 * the service, the scheduler, the room and the ledger exactly as a real operator
 * would. It creates no money: a bot-only tournament pays no fees, so the pool is
 * whatever the entrants paid in.
 */

interface ApiResponse {
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

interface CliOptions {
  readonly players: number;
  readonly level: "rookie" | "club" | "master";
  readonly fee: number;
  readonly timeoutSeconds: number;
}

function readOptions(argv: readonly string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const players = Number(get("players") ?? 8);
  const fee = Number(get("fee") ?? 0);
  const level = get("level") ?? "club";
  const timeout = Number(get("timeout") ?? 900);

  if (!Number.isInteger(players) || players < 2 || players > 64) {
    throw new Error("--players must be a whole number from 2 to 64");
  }
  if (!Number.isInteger(fee) || fee < 0) {
    throw new Error("--fee must be a whole number of minor units, zero or more");
  }
  if (level !== "rookie" && level !== "club" && level !== "master") {
    throw new Error("--level must be rookie, club or master");
  }

  return { players, level, fee, timeoutSeconds: timeout };
}

async function call(
  url: string,
  body: unknown,
  method: "GET" | "POST" = "POST",
): Promise<ApiResponse> {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-admin-key": env.ADMIN_API_KEY,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });

  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`unexpected response from ${url}: ${String(response.status)}`);
  }

  const payload = parsed as ApiResponse;
  if (!payload.ok) {
    throw new Error(
      `${method} ${url} failed with ${String(response.status)}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface TournamentView {
  id: string;
  name: string;
  status: string;
  format: string;
  prizePoolMinor: number;
  currency: string;
  championPlayerId: string | null;
  payouts:
    | {
        playerId: string;
        place: number;
        amountMinor: number;
        viaBotPlayerId: string | null;
      }[]
    | null;
}

interface BracketView {
  rounds: number;
  byes: number;
  positions: {
    id: string;
    round: number;
    slot: number;
    status: string;
    matchId: string | null;
    isWalkover: boolean;
    seat1: { displayName: string } | null;
    seat2: { displayName: string } | null;
    winner: { displayName: string } | null;
  }[];
}

interface EntriesView {
  entries: { playerId: string; displayName: string; isBot: boolean; seed: number | null }[];
}

async function main(): Promise<number> {
  const options = readOptions(process.argv.slice(2));
  const base = (process.env["API_URL"] ?? `http://localhost:${String(env.PORT)}`).replace(
    /\/$/,
    "",
  );

  const now = Date.now();
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

  console.log(`creating a ${String(options.players)} player tournament on ${base}`);

  const created = await call(`${base}/api/admin/tournaments`, {
    name: `Demo Cup ${new Date(now).toISOString().slice(11, 19)}`,
    config: {
      game: "carrom",
      format: "single_elimination",
      minPlayers: options.players,
      maxPlayers: options.players,
      entryFeeMinor: options.fee,
      rakeBps: 1_000,
      prizeSplit: [60, 30, 10],
      botPrizePolicy: "next_human",
      fillWithBots: true,
      botLevel: options.level,
      registrationOpensAt: iso(-60_000),
      registrationClosesAt: iso(5_000),
      startsAt: iso(6_000),
      walkoverSeconds: 180,
      match: { targetPoints: 25, boardsPerMatch: 1, turnSeconds: 30 },
      allowSpectators: true,
    },
  });

  const tournament = created["tournament"] as TournamentView;
  console.log(`created ${tournament.id}`);

  await call(`${base}/api/admin/tournaments/${tournament.id}/open`, {});
  console.log("registration open; the scheduler starts it on time");

  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  let lastStatus = "";
  let final: { tournament: TournamentView; bracket: BracketView; entries: EntriesView } | null =
    null;

  while (Date.now() < deadline) {
    const detail = await call(`${base}/api/tournaments/${tournament.id}`, {}, "GET");
    const view = detail["tournament"] as TournamentView;
    const bracket = detail["bracket"] as BracketView;

    if (view.status !== lastStatus) {
      console.log(`status: ${view.status}`);
      lastStatus = view.status;
    }

    const decided = bracket.positions.filter((position) => position.winner !== null).length;
    console.log(
      `  round ${String(bracket.rounds)} bracket: ${String(decided)}/${String(bracket.positions.length)} decided`,
    );

    if (view.status === "finished" || view.status === "cancelled") {
      final = { tournament: view, bracket, entries: detail["entries"] as EntriesView };
      break;
    }

    await sleep(5_000);
  }

  if (final === null) {
    console.error("the tournament did not finish in time");
    return 1;
  }

  const { tournament: finished, bracket, entries } = final;
  const nameOf = new Map(entries.entries.map((entry) => [entry.playerId, entry.displayName]));
  const champion = finished.championPlayerId;

  console.log("");
  console.log(`champion: ${champion === null ? "none" : (nameOf.get(champion) ?? champion)}`);
  console.log(`prize pool: ${String(finished.prizePoolMinor)} ${finished.currency}`);

  for (const payout of finished.payouts ?? []) {
    const who = nameOf.get(payout.playerId) ?? payout.playerId;
    const via = payout.viaBotPlayerId === null ? "" : " (a bot's prize, passed down)";
    console.log(`  place ${String(payout.place)}: ${who} wins ${String(payout.amountMinor)}${via}`);
  }

  console.log("");
  console.log("bracket:");
  for (const position of bracket.positions) {
    const left = position.seat1?.displayName ?? "bye";
    const right = position.seat2?.displayName ?? "bye";
    const result =
      position.winner === null
        ? position.status
        : `${position.winner.displayName}${position.isWalkover ? " (walkover)" : ""}`;
    console.log(
      `  r${String(position.round)}m${String(position.slot)} ${left} v ${right} -> ${result}`,
    );
  }

  const matchIds = bracket.positions
    .map((position) => position.matchId)
    .filter((matchId): matchId is string => matchId !== null);

  console.log("");
  console.log(`verify each match from the database alone:`);
  for (const matchId of matchIds) {
    console.log(`  npm run verify-match -- ${matchId}`);
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
