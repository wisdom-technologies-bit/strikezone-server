import { describe, expect, it } from "vitest";
import {
  BOARD_SPAN_MM,
  CONTRACT_VERSION,
  FRAME_ABSENT,
  FRAME_SCALE,
  decodeBase64,
  decodeFrames,
  encodeBase64,
  encodeFrames,
  frameBodies,
  matchDetailSchema,
  positionAt,
  quantise,
  shotMessageSchema,
  dequantise,
  type RawFrames,
} from "../../src/api/contract.js";

/**
 * The contract file on its own.
 *
 * It is copied into the website as it stands, so what matters is that everything
 * a browser needs is here and behaves: base64 without a global, a frame encoder
 * and decoder that agree to well under a coin's radius, and no import that would
 * drag the server along with it.
 */

const bodies = ["white-1", "black-1", "queen", "striker"];

function frames(count: number): RawFrames {
  return {
    fps: 30,
    frames: Array.from({ length: count }, (_unused, index) => ({
      t: index / 30,
      bodies: bodies.map((id, bodyIndex) => ({
        id,
        x: 40 + index * 3 + bodyIndex * 10.25,
        y: 60 + index * 2.5 + bodyIndex * 5.5,
      })),
    })),
  };
}

describe("base64", () => {
  it("round-trips bytes of every length modulo three", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 31]) {
      const bytes = Uint8Array.from({ length }, (_unused, index) => (index * 37) % 256);
      expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
    }
  });

  it("writes the standard alphabet", () => {
    expect(encodeBase64(new TextEncoder().encode("wat?"))).toBe("d2F0Pw==");
    expect(new TextDecoder().decode(decodeBase64("d2F0Pw=="))).toBe("wat?");
  });

  it("refuses a character outside the alphabet", () => {
    expect(() => decodeBase64("not base64!")).toThrow(/not base64/u);
  });
});

describe("frame quantisation", () => {
  it("maps the board's two walls to the two ends of the range", () => {
    expect(quantise(0)).toBe(0);
    expect(quantise(BOARD_SPAN_MM)).toBe(FRAME_SCALE);
    expect(dequantise(FRAME_SCALE)).toBeCloseTo(BOARD_SPAN_MM, 6);
    // The sentinel is never produced by a real position.
    expect(FRAME_SCALE).toBeLessThan(FRAME_ABSENT);
  });

  it("clamps a position outside the board rather than wrapping", () => {
    expect(quantise(-10)).toBe(0);
    expect(quantise(BOARD_SPAN_MM + 10)).toBe(FRAME_SCALE);
    expect(quantise(BOARD_SPAN_MM + 10)).not.toBe(FRAME_ABSENT);
  });

  it("records a body that is off the board in a frame as absent, not at the origin", () => {
    const raw = {
      fps: 30,
      frames: [
        {
          t: 0,
          bodies: [
            { id: "white-1", x: 100, y: 200 },
            { id: "black-1", x: 300, y: 400 },
          ],
        },
        // white-1 was pocketed: it is gone from this frame entirely.
        { t: 0.033, bodies: [{ id: "black-1", x: 310, y: 410 }] },
      ],
    };

    const decoded = decodeFrames(encodeFrames(raw));

    expect(positionAt(decoded, 1, "white-1")).toBeNull();
    expect(frameBodies(decoded, 1).map((body) => body.id)).toEqual(["black-1"]);
    expect(positionAt(decoded, 1, "black-1")?.x).toBeCloseTo(310, 1);
  });

  it("round-trips every body in every frame to under a hundredth of a millimetre", () => {
    const raw = frames(12);
    const decoded = decodeFrames(encodeFrames(raw));

    expect(decoded.frameCount).toBe(12);
    expect(decoded.bodyIds).toEqual(bodies);

    for (let frameIndex = 0; frameIndex < raw.frames.length; frameIndex += 1) {
      for (const body of raw.frames[frameIndex]?.bodies ?? []) {
        const position = positionAt(decoded, frameIndex, body.id);
        expect(position).not.toBeNull();
        expect(position?.x).toBeCloseTo(body.x, 1);
        expect(position?.y).toBeCloseTo(body.y, 1);
        expect(Math.abs((position?.x ?? 0) - body.x)).toBeLessThan(0.02);
      }
    }
  });

  it("keeps a whole shot under a kilobyte per frame", () => {
    const encoded = encodeFrames(frames(60));
    // 4 bodies, 2 axes, 2 bytes each: 16 bytes per frame before base64.
    expect(encoded.data.length).toBeLessThan(60 * 16 * 2);
  });

  it("handles a shot with no frames", () => {
    const encoded = encodeFrames({ fps: 30, frames: [] });
    expect(encoded.frameCount).toBe(0);
    expect(encoded.bodyIds).toEqual([]);
    expect(encoded.data).toBe("");
    expect(decodeFrames(encoded).values.length).toBe(0);
  });

  it("reads a frame back as bodies in header order", () => {
    const decoded = decodeFrames(encodeFrames(frames(2)));
    const first = frameBodies(decoded, 0);
    expect(first.map((body) => body.id)).toEqual(bodies);
    expect(frameBodies(decoded, 5)).toEqual([]);
    expect(positionAt(decoded, 0, "nobody")).toBeNull();
  });
});

describe("the shot message", () => {
  it("validates the message the server builds", () => {
    const encoded = encodeFrames(frames(3));
    const parsed = shotMessageSchema.safeParse({
      type: "shot",
      shotNumber: 7,
      seat: 1,
      events: [{ type: "coin_pocketed", shot: 7, coin: "white", creditedTo: "white", by: "white" }],
      frames: encoded,
      nextState: {
        board: 2,
        turn: "black",
        phase: "aiming",
        shotNumber: 7,
        scores: { white: 4, black: 2 },
        queue: [{ id: "white-1", colour: "white", x: 100, y: 120 }],
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a shot with no frames block", () => {
    const parsed = shotMessageSchema.safeParse({
      type: "shot",
      shotNumber: 1,
      seat: 1,
      events: [],
      nextState: {
        board: 1,
        turn: "white",
        phase: "aiming",
        shotNumber: 1,
        scores: { white: 0, black: 0 },
        queue: [],
      },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("the version", () => {
  it("is a positive integer, so a mismatch is detectable", () => {
    expect(Number.isInteger(CONTRACT_VERSION)).toBe(true);
    expect(CONTRACT_VERSION).toBeGreaterThan(0);
  });
});

describe("the lobby row", () => {
  /* A four seat Ludo match, priced, as the fixture scheduler serves it. */
  const summary = {
    id: "c0000000-0000-4000-8000-00000000f001",
    game: "ludo" as const,
    status: "scheduled" as const,
    tournamentId: null,
    isTournament: false,
    startedAt: null,
    endedAt: null,
    scheduledAt: "2026-10-31T10:00:00.000Z",
    players: [1, 2, 3, 4].map((seat) => ({
      seat: seat as 1 | 2 | 3 | 4,
      playerId: `bot-${String(seat)}`,
      displayName: `House ${String(seat)}`,
      isBot: true,
      botLevel: "club" as const,
      botPolicy: "cautious",
      rating: 1200,
      score: null,
    })),
    scores: null,
    headlineMarket: {
      marketType: "ludo_match_winner",
      name: "Match winner",
      selections: ["red", "green", "yellow", "blue"].map((selectionKey) => ({
        selectionKey,
        name: selectionKey,
        oddsDecimal: 4.1,
        status: "open" as const,
      })),
    },
    roomId: null,
    seedCommit: "ab".repeat(32),
    seedReveal: null,
    resultSignature: null,
    logHeadHash: null,
    result: null,
  };

  it("carries four seats, a start time and the winner market's prices", () => {
    const parsed = matchDetailSchema.parse(summary);

    expect(parsed.players).toHaveLength(4);
    expect(parsed.players.map((player) => player.seat)).toEqual([1, 2, 3, 4]);
    expect(parsed.scheduledAt).toBe("2026-10-31T10:00:00.000Z");
    expect(parsed.headlineMarket?.selections).toHaveLength(4);
  });

  it("refuses a seat number the game cannot have", () => {
    const broken = {
      ...summary,
      players: [{ ...summary.players[0], seat: 5 }],
    };

    expect(matchDetailSchema.safeParse(broken).success).toBe(false);
  });
});
