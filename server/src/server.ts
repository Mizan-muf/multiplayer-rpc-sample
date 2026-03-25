import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import {
  MOVES,
  PLAYER_SLOTS,
  createRoom,
  disconnectPlayer,
  getPlayerSlotForSocket,
  getPublicRoomState,
  isRoomEmpty,
  joinRoom,
  resetRound,
  submitMove,
  voteRematch,
  type Move,
  type PlayerSlot,
  type Room
} from "./game.js";

interface ClientToServerEvents {
  "room:create": () => void;
  "room:join": (payload: { roomCode: string }) => void;
  "move:select": (payload: { roomCode: string; move: Move }) => void;
  "rematch:vote": (payload: { roomCode: string }) => void;
}

interface ServerToClientEvents {
  "room:state": (payload: {
    room: ReturnType<typeof getPublicRoomState>;
    selfSlot: PlayerSlot;
  }) => void;
  "room:error": (payload: { message: string }) => void;
  "round:result": (payload: {
    roomCode: string;
    moves: Record<PlayerSlot, Move>;
    winner: PlayerSlot | "draw";
    score: Record<PlayerSlot, number>;
  }) => void;
  "player:status": (payload: {
    type: "joined" | "disconnected" | "rematch_waiting" | "rematch_ready";
    message: string;
  }) => void;
}

const ROUND_RESET_DELAY_MS = 2200;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, "../../client/dist");

function sanitizeRoomCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function createRoomCode(rooms: Map<string, Room>): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  while (true) {
    let roomCode = "";

    for (let index = 0; index < 5; index += 1) {
      roomCode += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    if (!rooms.has(roomCode)) {
      return roomCode;
    }
  }
}

export function createAppServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: "*"
    }
  });
  const rooms = new Map<string, Room>();
  const roundResetTimers = new Map<string, NodeJS.Timeout>();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  if (existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));

    app.use((request, response, next) => {
      if (request.path === "/health") {
        next();
        return;
      }

      response.sendFile(path.join(clientDistPath, "index.html"));
    });
  }

  function clearRoundReset(roomCode: string): void {
    const timer = roundResetTimers.get(roomCode);

    if (timer) {
      clearTimeout(timer);
      roundResetTimers.delete(roomCode);
    }
  }

  function emitRoomState(room: Room): void {
    for (const slot of PLAYER_SLOTS) {
      const player = room.players[slot];

      if (!player) {
        continue;
      }

      io.to(player.socketId).emit("room:state", {
        room: getPublicRoomState(room),
        selfSlot: slot
      });
    }
  }

  function removeRoomIfEmpty(room: Room): void {
    if (!isRoomEmpty(room)) {
      return;
    }

    clearRoundReset(room.roomCode);
    rooms.delete(room.roomCode);
  }

  function abandonRoomForSocket(socket: Socket, reason: string): void {
    for (const room of rooms.values()) {
      const slot = getPlayerSlotForSocket(room, socket.id);

      if (!slot) {
        continue;
      }

      clearRoundReset(room.roomCode);
      disconnectPlayer(room, slot);
      socket.leave(room.roomCode);

      if (!isRoomEmpty(room)) {
        io.to(room.roomCode).emit("player:status", {
          type: "disconnected",
          message: reason
        });
        emitRoomState(room);
      }

      removeRoomIfEmpty(room);
      break;
    }
  }

  function scheduleRoundReset(room: Room): void {
    clearRoundReset(room.roomCode);

    const timer = setTimeout(() => {
      const latestRoom = rooms.get(room.roomCode);

      if (!latestRoom || latestRoom.roundState.status !== "resolved") {
        return;
      }

      resetRound(latestRoom);
      emitRoomState(latestRoom);
      roundResetTimers.delete(room.roomCode);
    }, ROUND_RESET_DELAY_MS);

    roundResetTimers.set(room.roomCode, timer);
  }

  io.on("connection", (socket) => {
    socket.on("room:create", () => {
      abandonRoomForSocket(socket, "Your opponent left the room.");

      const roomCode = createRoomCode(rooms);
      const room = createRoom(roomCode, socket.id);
      rooms.set(roomCode, room);
      socket.join(roomCode);
      emitRoomState(room);
    });

    socket.on("room:join", (payload) => {
      const roomCode = sanitizeRoomCode(payload.roomCode);
      const room = rooms.get(roomCode);

      if (!room) {
        socket.emit("room:error", {
          message: "Room not found. Check the code and try again."
        });
        return;
      }

      abandonRoomForSocket(socket, "Your opponent left the room.");

      const joinResult = joinRoom(room, socket.id);

      if (!joinResult.ok) {
        socket.emit("room:error", { message: joinResult.error });
        return;
      }

      socket.join(roomCode);
      emitRoomState(room);
      io.to(room.roomCode).emit("player:status", {
        type: "joined",
        message: "Both players are here. Pick your move."
      });
    });

    socket.on("move:select", (payload) => {
      const room = rooms.get(sanitizeRoomCode(payload.roomCode));

      if (!room) {
        socket.emit("room:error", {
          message: "Room not found."
        });
        return;
      }

      const slot = getPlayerSlotForSocket(room, socket.id);

      if (!slot) {
        socket.emit("room:error", {
          message: "You are not a player in this room."
        });
        return;
      }

      if (!MOVES.includes(payload.move)) {
        socket.emit("room:error", {
          message: "Invalid move."
        });
        return;
      }

      clearRoundReset(room.roomCode);

      const moveResult = submitMove(room, slot, payload.move);

      if (!moveResult.ok) {
        socket.emit("room:error", { message: moveResult.error });
        return;
      }

      emitRoomState(room);

      if (moveResult.value.resolved) {
        io.to(room.roomCode).emit("round:result", moveResult.value.resolved);
        scheduleRoundReset(room);
      }
    });

    socket.on("rematch:vote", (payload) => {
      const room = rooms.get(sanitizeRoomCode(payload.roomCode));

      if (!room) {
        socket.emit("room:error", {
          message: "Room not found."
        });
        return;
      }

      const slot = getPlayerSlotForSocket(room, socket.id);

      if (!slot) {
        socket.emit("room:error", {
          message: "You are not a player in this room."
        });
        return;
      }

      clearRoundReset(room.roomCode);

      const rematchResult = voteRematch(room, slot);

      if (!rematchResult.ok) {
        socket.emit("room:error", { message: rematchResult.error });
        return;
      }

      if (rematchResult.value.reset) {
        io.to(room.roomCode).emit("player:status", {
          type: "rematch_ready",
          message: "Rematch accepted. Score reset for a fresh match."
        });
      } else {
        io.to(room.roomCode).emit("player:status", {
          type: "rematch_waiting",
          message: "Rematch vote locked. Waiting for the other player."
        });
      }

      emitRoomState(room);
    });

    socket.on("disconnect", () => {
      abandonRoomForSocket(socket, "Your opponent disconnected.");
    });
  });

  return {
    app,
    server: httpServer,
    io
  };
}
