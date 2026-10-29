import { Client } from "@colyseus/sdk";
import { env } from "../src/lib/env.js";

/**
 * npm run carrom:watch -- <roomId> [ws://host:port]
 *
 * A small spectator client: joins the room anonymously, prints the state and every
 * shot as it arrives, and leaves when the match ends. Proof that a live match can
 * be followed without playing in it, and the quickest way to see a dev match.
 */
async function main(): Promise<number> {
  const roomId = process.argv[2];
  const url = process.argv[3] ?? `ws://localhost:${env.PORT}`;

  if (roomId === undefined || roomId.trim() === "") {
    console.error("usage: npm run carrom:watch -- <roomId> [ws://host:port]");
    return 2;
  }

  const client = new Client(url);
  const room = await client.joinById(roomId, { spectate: true });

  console.log(`watching room ${roomId} on ${url}`);

  const finished = new Promise<void>((resolve) => {
    room.onMessage("welcome", (message: unknown) => {
      console.log("welcome", message);
    });

    room.onMessage("shot", (payload: unknown) => {
      const shot = payload as {
        shotNumber?: number;
        seat?: number;
        colour?: string;
        shot?: { x: number; angle: number; power: number };
        events?: ReadonlyArray<{ type: string }>;
        nextState?: { board?: number; scores?: { white: number; black: number } };
      };
      const events = (shot.events ?? []).map((event) => event.type).join(",") || "no events";
      console.log(
        `#${String(shot.shotNumber)} seat ${String(shot.seat)} (${String(shot.colour)}) ` +
          `x=${shot.shot?.x.toFixed(0)} angle=${shot.shot?.angle.toFixed(2)} power=${shot.shot?.power.toFixed(2)} ` +
          `-> ${events} | board ${String(shot.nextState?.board)} ` +
          `score ${String(shot.nextState?.scores?.white)}-${String(shot.nextState?.scores?.black)}`,
      );
    });

    room.onMessage("match_end", (result: unknown) => {
      console.log("match over", result);
      resolve();
    });

    room.onStateChange((state: unknown) => {
      const snapshot = state as {
        board?: number;
        turn?: string;
        shotNumber?: number;
        toJSON?: () => unknown;
      };
      console.log(
        `state: board ${String(snapshot.board)} turn ${String(snapshot.turn)} shot ${String(snapshot.shotNumber)}`,
      );
    });
  });

  await finished;
  await room.leave();
  return 0;
}

process.exitCode = await main();
