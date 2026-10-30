import { InMemoryMatchRepository } from "../src/lib/match-repository.js";
import { setMatchRepository } from "../src/lib/match-store.js";

/**
 * npm run ludo:watch
 *
 * Runs the real server with the match store in memory, so the whole dev path works
 * without a database: open http://localhost:2567/dev/ludo.html, press "Start a four
 * bot match", and watch the room the way a spectator does.
 *
 * Nothing here is a stub: the app, the rooms, the stream and the verifier are the
 * production ones. Only the store is swapped, which is the seam the tests use too.
 */

setMatchRepository(new InMemoryMatchRepository());

await import("../src/index.js");
