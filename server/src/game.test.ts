import { describe, expect, it } from "vitest";
import {
  createRoom,
  disconnectPlayer,
  getPlayerSlotForSocket,
  getPublicRoomState,
  getRoundWinner,
  joinRoom,
  resetRound,
  submitMove,
  voteRematch,
  type Move
} from "./game.js";

describe("game room lifecycle", () => {
  it("creates a room with the creator assigned to player1", () => {
    const room = createRoom("ABCDE", "socket-1");

    expect(room.players.player1?.socketId).toBe("socket-1");
    expect(room.players.player1?.name).toBe("Player 1");
    expect(room.players.player2).toBeNull();

    const publicRoom = getPublicRoomState(room);
    expect(publicRoom.roomCode).toBe("ABCDE");
    expect(publicRoom.roundState.status).toBe("waiting");
  });

  it("joins a valid room as player2 and starts the round", () => {
    const room = createRoom("ABCDE", "socket-1");
    const joinResult = joinRoom(room, "socket-2");

    expect(joinResult.ok).toBe(true);
    expect(getPlayerSlotForSocket(room, "socket-2")).toBe("player2");
    expect(room.roundState.status).toBe("choosing");
  });

  it("rejects joining a full room", () => {
    const room = createRoom("ABCDE", "socket-1");
    expect(joinRoom(room, "socket-2").ok).toBe(true);

    const joinAgain = joinRoom(room, "socket-3");
    expect(joinAgain.ok).toBe(false);
    expect(joinAgain.ok ? "" : joinAgain.error).toMatch(/full/i);
  });
});

describe("move resolution", () => {
  const matrix: Array<[Move, Move, "player1" | "player2" | "draw"]> = [
    ["rock", "rock", "draw"],
    ["rock", "paper", "player2"],
    ["rock", "scissors", "player1"],
    ["paper", "rock", "player1"],
    ["paper", "paper", "draw"],
    ["paper", "scissors", "player2"],
    ["scissors", "rock", "player2"],
    ["scissors", "paper", "player1"],
    ["scissors", "scissors", "draw"]
  ];

  it.each(matrix)(
    "resolves %s vs %s as %s",
    (player1Move, player2Move, winner) => {
      expect(getRoundWinner(player1Move, player2Move)).toBe(winner);
    }
  );

  it("keeps moves hidden until both players lock in", () => {
    const room = createRoom("ABCDE", "socket-1");
    joinRoom(room, "socket-2");

    const moveResult = submitMove(room, "player1", "rock");
    expect(moveResult.ok).toBe(true);
    expect(moveResult.ok && moveResult.value.resolved).toBeNull();

    const publicRoom = getPublicRoomState(room);
    expect(publicRoom.roundState.lockedMoves.player1).toBe(true);
    expect(publicRoom.roundState.revealedMoves.player1).toBeUndefined();
  });

  it("increments score only on non-draw rounds", () => {
    const room = createRoom("ABCDE", "socket-1");
    joinRoom(room, "socket-2");

    submitMove(room, "player1", "rock");
    submitMove(room, "player2", "rock");
    expect(room.matchScore.player1).toBe(0);
    expect(room.matchScore.player2).toBe(0);

    resetRound(room);
    submitMove(room, "player1", "rock");
    submitMove(room, "player2", "scissors");
    expect(room.matchScore.player1).toBe(1);
    expect(room.matchScore.player2).toBe(0);
  });

  it("prevents duplicate move submissions in the same round", () => {
    const room = createRoom("ABCDE", "socket-1");
    joinRoom(room, "socket-2");

    expect(submitMove(room, "player1", "rock").ok).toBe(true);
    const secondAttempt = submitMove(room, "player1", "paper");
    expect(secondAttempt.ok).toBe(false);
  });

  it("starting a new round clears moves but keeps score", () => {
    const room = createRoom("ABCDE", "socket-1");
    joinRoom(room, "socket-2");

    submitMove(room, "player1", "paper");
    submitMove(room, "player2", "rock");
    expect(room.matchScore.player1).toBe(1);

    resetRound(room);
    expect(room.matchScore.player1).toBe(1);
    expect(room.roundState.lockedMoves.player1).toBe(false);
    expect(room.roundState.revealedMoves.player1).toBeUndefined();
    expect(room.roundState.status).toBe("choosing");
  });
});

describe("rematch and disconnect handling", () => {
  it("resets score and round state only after both players vote rematch", () => {
    const room = createRoom("ABCDE", "socket-1");
    joinRoom(room, "socket-2");

    submitMove(room, "player1", "scissors");
    submitMove(room, "player2", "paper");
    expect(room.matchScore.player1).toBe(1);

    const firstVote = voteRematch(room, "player1");
    expect(firstVote.ok).toBe(true);
    expect(firstVote.ok && firstVote.value.reset).toBe(false);
    expect(room.matchScore.player1).toBe(1);

    const secondVote = voteRematch(room, "player2");
    expect(secondVote.ok).toBe(true);
    expect(secondVote.ok && secondVote.value.reset).toBe(true);
    expect(room.matchScore.player1).toBe(0);
    expect(room.roundState.status).toBe("choosing");
  });

  it("marks the room inactive after a disconnect", () => {
    const room = createRoom("ABCDE", "socket-1");
    joinRoom(room, "socket-2");

    disconnectPlayer(room, "player2");

    const publicRoom = getPublicRoomState(room);
    expect(publicRoom.isActive).toBe(false);
    expect(publicRoom.roundState.status).toBe("abandoned");
    expect(publicRoom.players.player2).toBeNull();
  });
});
