export const PLAYER_SLOTS = ["player1", "player2"] as const;
export const MOVES = ["rock", "paper", "scissors"] as const;

export type PlayerSlot = (typeof PLAYER_SLOTS)[number];
export type Move = (typeof MOVES)[number];
export type RoundWinner = PlayerSlot | "draw";
export type RoundStatus = "waiting" | "choosing" | "resolved" | "abandoned";

export type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface PublicPlayer {
  name: string;
  connected: boolean;
}

export interface RoomState {
  roomCode: string;
  players: Record<PlayerSlot, PublicPlayer | null>;
  matchScore: Record<PlayerSlot, number>;
  roundState: {
    status: RoundStatus;
    lockedMoves: Record<PlayerSlot, boolean>;
    revealedMoves: Partial<Record<PlayerSlot, Move>>;
    winner: RoundWinner | null;
  };
  rematchVotes: Record<PlayerSlot, boolean>;
  canStart: boolean;
  isActive: boolean;
  createdAt: number;
}

export interface RoundResult {
  roomCode: string;
  moves: Record<PlayerSlot, Move>;
  winner: RoundWinner;
  score: Record<PlayerSlot, number>;
}

interface InternalPlayer {
  socketId: string;
  slot: PlayerSlot;
  name: string;
  connected: boolean;
}

interface InternalRoundState {
  status: RoundStatus;
  moves: Partial<Record<PlayerSlot, Move>>;
  lockedMoves: Record<PlayerSlot, boolean>;
  revealedMoves: Partial<Record<PlayerSlot, Move>>;
  winner: RoundWinner | null;
}

export interface Room {
  roomCode: string;
  players: Record<PlayerSlot, InternalPlayer | null>;
  matchScore: Record<PlayerSlot, number>;
  roundState: InternalRoundState;
  rematchVotes: Record<PlayerSlot, boolean>;
  isActive: boolean;
  createdAt: number;
}

function createEmptyRoundState(status: RoundStatus): InternalRoundState {
  return {
    status,
    moves: {},
    lockedMoves: {
      player1: false,
      player2: false
    },
    revealedMoves: {},
    winner: null
  };
}

function createPlayer(socketId: string, slot: PlayerSlot): InternalPlayer {
  return {
    socketId,
    slot,
    name: slot === "player1" ? "Player 1" : "Player 2",
    connected: true
  };
}

export function createRoom(roomCode: string, socketId: string): Room {
  return {
    roomCode,
    players: {
      player1: createPlayer(socketId, "player1"),
      player2: null
    },
    matchScore: {
      player1: 0,
      player2: 0
    },
    roundState: createEmptyRoundState("waiting"),
    rematchVotes: {
      player1: false,
      player2: false
    },
    isActive: true,
    createdAt: Date.now()
  };
}

export function getAvailableSlot(room: Room): PlayerSlot | null {
  if (!room.players.player1) {
    return "player1";
  }

  if (!room.players.player2) {
    return "player2";
  }

  return null;
}

export function getPlayerSlotForSocket(
  room: Room,
  socketId: string
): PlayerSlot | null {
  return (
    PLAYER_SLOTS.find((slot) => room.players[slot]?.socketId === socketId) ?? null
  );
}

export function getRoundWinner(
  firstMove: Move,
  secondMove: Move
): RoundWinner {
  if (firstMove === secondMove) {
    return "draw";
  }

  if (
    (firstMove === "rock" && secondMove === "scissors") ||
    (firstMove === "paper" && secondMove === "rock") ||
    (firstMove === "scissors" && secondMove === "paper")
  ) {
    return "player1";
  }

  return "player2";
}

export function joinRoom(
  room: Room,
  socketId: string
): ActionResult<{ slot: PlayerSlot }> {
  const slot = getAvailableSlot(room);

  if (!slot) {
    return {
      ok: false,
      error: "Room is already full."
    };
  }

  room.players[slot] = createPlayer(socketId, slot);
  room.isActive = true;
  room.rematchVotes.player1 = false;
  room.rematchVotes.player2 = false;
  room.roundState = createEmptyRoundState("choosing");

  return {
    ok: true,
    value: { slot }
  };
}

export function resetRound(room: Room): void {
  const nextStatus =
    room.players.player1 && room.players.player2 && room.isActive
      ? "choosing"
      : "waiting";

  room.roundState = createEmptyRoundState(nextStatus);
  room.rematchVotes.player1 = false;
  room.rematchVotes.player2 = false;
}

export function resetMatch(room: Room): void {
  room.matchScore.player1 = 0;
  room.matchScore.player2 = 0;
  resetRound(room);
}

export function submitMove(
  room: Room,
  slot: PlayerSlot,
  move: Move
): ActionResult<{ resolved: RoundResult | null }> {
  if (!room.isActive || room.roundState.status === "abandoned") {
    return {
      ok: false,
      error: "This room is no longer active."
    };
  }

  if (!room.players.player1 || !room.players.player2) {
    return {
      ok: false,
      error: "Waiting for a second player to join."
    };
  }

  if (room.roundState.status !== "choosing") {
    return {
      ok: false,
      error: "Round is not accepting moves right now."
    };
  }

  if (room.roundState.lockedMoves[slot]) {
    return {
      ok: false,
      error: "You already locked a move for this round."
    };
  }

  room.roundState.moves[slot] = move;
  room.roundState.lockedMoves[slot] = true;
  room.rematchVotes.player1 = false;
  room.rematchVotes.player2 = false;

  const firstMove = room.roundState.moves.player1;
  const secondMove = room.roundState.moves.player2;

  if (!firstMove || !secondMove) {
    return {
      ok: true,
      value: { resolved: null }
    };
  }

  const winner = getRoundWinner(firstMove, secondMove);
  room.roundState.status = "resolved";
  room.roundState.revealedMoves = {
    player1: firstMove,
    player2: secondMove
  };
  room.roundState.winner = winner;

  if (winner !== "draw") {
    room.matchScore[winner] += 1;
  }

  return {
    ok: true,
    value: {
      resolved: {
        roomCode: room.roomCode,
        moves: {
          player1: firstMove,
          player2: secondMove
        },
        winner,
        score: {
          player1: room.matchScore.player1,
          player2: room.matchScore.player2
        }
      }
    }
  };
}

export function voteRematch(
  room: Room,
  slot: PlayerSlot
): ActionResult<{ reset: boolean }> {
  if (!room.isActive || room.roundState.status === "abandoned") {
    return {
      ok: false,
      error: "This room is no longer active."
    };
  }

  if (!room.players.player1 || !room.players.player2) {
    return {
      ok: false,
      error: "Both players must be present for a rematch."
    };
  }

  room.rematchVotes[slot] = true;

  if (room.rematchVotes.player1 && room.rematchVotes.player2) {
    resetMatch(room);
    return {
      ok: true,
      value: { reset: true }
    };
  }

  return {
    ok: true,
    value: { reset: false }
  };
}

export function disconnectPlayer(room: Room, slot: PlayerSlot): void {
  room.players[slot] = null;
  room.isActive = false;
  room.roundState = createEmptyRoundState("abandoned");
  room.rematchVotes.player1 = false;
  room.rematchVotes.player2 = false;
}

export function isRoomEmpty(room: Room): boolean {
  return !room.players.player1 && !room.players.player2;
}

export function getPublicRoomState(room: Room): RoomState {
  return {
    roomCode: room.roomCode,
    players: {
      player1: room.players.player1
        ? {
            name: room.players.player1.name,
            connected: room.players.player1.connected
          }
        : null,
      player2: room.players.player2
        ? {
            name: room.players.player2.name,
            connected: room.players.player2.connected
          }
        : null
    },
    matchScore: {
      player1: room.matchScore.player1,
      player2: room.matchScore.player2
    },
    roundState: {
      status: room.roundState.status,
      lockedMoves: {
        player1: room.roundState.lockedMoves.player1,
        player2: room.roundState.lockedMoves.player2
      },
      revealedMoves:
        room.roundState.status === "resolved"
          ? {
              player1: room.roundState.revealedMoves.player1,
              player2: room.roundState.revealedMoves.player2
            }
          : {},
      winner: room.roundState.status === "resolved" ? room.roundState.winner : null
    },
    rematchVotes: {
      player1: room.rematchVotes.player1,
      player2: room.rematchVotes.player2
    },
    canStart: Boolean(room.players.player1 && room.players.player2 && room.isActive),
    isActive: room.isActive,
    createdAt: room.createdAt
  };
}