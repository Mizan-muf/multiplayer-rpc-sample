export const PLAYER_SLOTS = ["player1", "player2"] as const;
export const MOVES = ["rock", "paper", "scissors"] as const;

export type PlayerSlot = (typeof PLAYER_SLOTS)[number];
export type Move = (typeof MOVES)[number];
export type RoundWinner = PlayerSlot | "draw";
export type RoundStatus = "waiting" | "choosing" | "resolved" | "abandoned";

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

export interface RoomStatePayload {
  room: RoomState;
  selfSlot: PlayerSlot;
}

export interface RoundResultPayload {
  roomCode: string;
  moves: Record<PlayerSlot, Move>;
  winner: RoundWinner;
  score: Record<PlayerSlot, number>;
}

export interface PlayerStatusPayload {
  type: "joined" | "disconnected" | "rematch_waiting" | "rematch_ready";
  message: string;
}