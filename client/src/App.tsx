import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  MOVES,
  type Move,
  type PlayerSlot,
  type PlayerStatusPayload,
  type RoomState,
  type RoomStatePayload,
  type RoundResultPayload
} from "./types";

function getSocketUrl(): string {
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL;
  }

  if (typeof window === "undefined") {
    return "http://localhost:3001";
  }

  const { hostname, origin, protocol, port } = window.location;
  const isLocalHost =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isViteDevPort = port === "5173" || port === "4173";

  if (isLocalHost || isViteDevPort) {
    return `${protocol}//${hostname}:3001`;
  }

  return origin;
}

function getOpponentSlot(slot: PlayerSlot): PlayerSlot {
  return slot === "player1" ? "player2" : "player1";
}

function getWinnerLabel(
  winner: RoundResultPayload["winner"],
  selfSlot: PlayerSlot,
  room: RoomState
): string {
  if (winner === "draw") {
    return "Draw round.";
  }

  const winningName = room.players[winner]?.name ?? "A player";
  return winner === selfSlot ? "You win the round." : `${winningName} wins the round.`;
}

function getStatusMessage(
  room: RoomState | null,
  selfSlot: PlayerSlot | null,
  localMoveLocked: boolean,
  lastRoundResult: RoundResultPayload | null,
  connectionStatus: "connecting" | "connected" | "disconnected",
  latestPlayerStatus: PlayerStatusPayload | null
): string {
  if (connectionStatus === "connecting") {
    return "Connecting to the game server.";
  }

  if (connectionStatus === "disconnected" && !room) {
    return "Disconnected. Reconnecting will start a fresh session.";
  }

  if (!room || !selfSlot) {
    return "Create a private room or join one with a room code.";
  }

  if (room.roundState.status === "abandoned") {
    return latestPlayerStatus?.message ?? "Your opponent left the room.";
  }

  if (!room.canStart) {
    return "Waiting for a second player to join.";
  }

  if (room.roundState.status === "resolved" && lastRoundResult) {
    return `${getWinnerLabel(lastRoundResult.winner, selfSlot, room)} Next round starting shortly.`;
  }

  if (localMoveLocked) {
    return "Move locked. Waiting for the other player.";
  }

  if (latestPlayerStatus?.type === "rematch_waiting") {
    return latestPlayerStatus.message;
  }

  return "Choose rock, paper, or scissors.";
}

export default function App() {
  const [connectionSeed, setConnectionSeed] = useState(0);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [selfSlot, setSelfSlot] = useState<PlayerSlot | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [localMoveLocked, setLocalMoveLocked] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [lastRoundResult, setLastRoundResult] =
    useState<RoundResultPayload | null>(null);
  const [latestPlayerStatus, setLatestPlayerStatus] =
    useState<PlayerStatusPayload | null>(null);

  useEffect(() => {
    const nextSocket = io(getSocketUrl());
    setSocket(nextSocket);
    setConnectionStatus("connecting");

    nextSocket.on("connect", () => {
      setConnectionStatus("connected");
    });

    nextSocket.on("disconnect", () => {
      setConnectionStatus("disconnected");
    });

    nextSocket.on("room:error", ({ message }: { message: string }) => {
      setErrorMessage(message);
    });

    nextSocket.on("room:state", ({ room: nextRoom, selfSlot: nextSlot }: RoomStatePayload) => {
      setRoom(nextRoom);
      setSelfSlot(nextSlot);
      setLocalMoveLocked(nextRoom.roundState.lockedMoves[nextSlot]);
      setErrorMessage("");

      if (nextRoom.roundState.status === "choosing") {
        setLastRoundResult(null);
      }
    });

    nextSocket.on("round:result", (payload: RoundResultPayload) => {
      setLastRoundResult(payload);
    });

    nextSocket.on("player:status", (payload: PlayerStatusPayload) => {
      setLatestPlayerStatus(payload);
    });

    return () => {
      nextSocket.removeAllListeners();
      nextSocket.disconnect();
    };
  }, [connectionSeed]);

  const opponentSlot = selfSlot ? getOpponentSlot(selfSlot) : null;
  const opponent = opponentSlot && room ? room.players[opponentSlot] : null;
  const myRematchVote = room && selfSlot ? room.rematchVotes[selfSlot] : false;
  const opponentRematchVote =
    room && opponentSlot ? room.rematchVotes[opponentSlot] : false;
  const moveButtonsDisabled =
    !room ||
    !selfSlot ||
    !room.canStart ||
    localMoveLocked ||
    room.roundState.status !== "choosing";

  const statusMessage = useMemo(
    () =>
      getStatusMessage(
        room,
        selfSlot,
        localMoveLocked,
        lastRoundResult,
        connectionStatus,
        latestPlayerStatus
      ),
    [
      room,
      selfSlot,
      localMoveLocked,
      lastRoundResult,
      connectionStatus,
      latestPlayerStatus
    ]
  );

  function resetSession(): void {
    setRoom(null);
    setSelfSlot(null);
    setJoinCode("");
    setLocalMoveLocked(false);
    setLastRoundResult(null);
    setLatestPlayerStatus(null);
    setErrorMessage("");
    setConnectionSeed((value) => value + 1);
  }

  function handleCreateRoom(): void {
    if (!socket) {
      return;
    }

    setErrorMessage("");
    setLastRoundResult(null);
    setLatestPlayerStatus(null);
    socket.emit("room:create");
  }

  function handleJoinRoom(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (!socket) {
      return;
    }

    const roomCode = joinCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

    if (!roomCode) {
      setErrorMessage("Enter a valid room code.");
      return;
    }

    setErrorMessage("");
    setLastRoundResult(null);
    setLatestPlayerStatus(null);
    socket.emit("room:join", { roomCode });
  }

  function handleMoveSelect(move: Move): void {
    if (!socket || !room) {
      return;
    }

    setErrorMessage("");
    setLatestPlayerStatus(null);
    setLocalMoveLocked(true);
    socket.emit("move:select", {
      roomCode: room.roomCode,
      move
    });
  }

  function handleRematchVote(): void {
    if (!socket || !room || !selfSlot || myRematchVote) {
      return;
    }

    setErrorMessage("");
    socket.emit("rematch:vote", {
      roomCode: room.roomCode
    });
  }

  function renderLobby() {
    return (
      <section className="panel lobby-panel">
        <div className="panel-header">
          <span className="eyebrow">Private Match</span>
          <h1>Rock Paper Scissors</h1>
          <p>
            Create a room, share the code, and settle it live in the browser.
          </p>
        </div>

        <div className="lobby-grid">
          <article className="action-card">
            <h2>Start a room</h2>
            <p>Open a fresh two-player match and wait for your opponent.</p>
            <button
              className="primary-button"
              onClick={handleCreateRoom}
              disabled={connectionStatus !== "connected"}
            >
              Create Room
            </button>
          </article>

          <article className="action-card">
            <h2>Join a room</h2>
            <p>Enter the code from your opponent to join instantly.</p>
            <form className="join-form" onSubmit={handleJoinRoom}>
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ROOM CODE"
                maxLength={6}
                aria-label="Room code"
              />
              <button
                className="secondary-button"
                type="submit"
                disabled={connectionStatus !== "connected"}
              >
                Join Room
              </button>
            </form>
          </article>
        </div>
      </section>
    );
  }

  function renderWaitingRoom() {
    if (!room || !selfSlot) {
      return null;
    }

    return (
      <section className="panel waiting-panel">
        <div className="panel-header">
          <span className="eyebrow">Waiting Room</span>
          <h1>Share this code</h1>
        </div>

        <div className="room-code">{room.roomCode}</div>

        <div className="waiting-meta">
          <div>
            <span className="meta-label">You are</span>
            <strong>{room.players[selfSlot]?.name}</strong>
          </div>
          <div>
            <span className="meta-label">Seat</span>
            <strong>{selfSlot === "player1" ? "Player 1" : "Player 2"}</strong>
          </div>
        </div>

        <p className="room-note">
          The match starts as soon as the second player joins.
        </p>
      </section>
    );
  }

  function renderPlayerCard(slot: PlayerSlot) {
    if (!room || !selfSlot) {
      return null;
    }

    const player = room.players[slot];
    const isSelf = slot === selfSlot;
    const locked = room.roundState.lockedMoves[slot];
    const revealedMove = room.roundState.revealedMoves[slot];

    return (
      <article className={`player-card ${isSelf ? "self" : ""}`}>
        <div className="player-card-top">
          <div>
            <span className="meta-label">{isSelf ? "You" : "Opponent"}</span>
            <h2>{player?.name ?? "Open slot"}</h2>
          </div>
          <div className="score-chip">{room.matchScore[slot]}</div>
        </div>

        <div className="player-state">
          {room.roundState.status === "resolved" ? (
            <span className="move-reveal">{revealedMove ?? "?"}</span>
          ) : locked ? (
            <span className="move-hidden">Move locked</span>
          ) : (
            <span className="move-hidden">Waiting</span>
          )}
        </div>
      </article>
    );
  }

  function renderGame() {
    if (!room || !selfSlot) {
      return null;
    }

    return (
      <section className="game-shell">
        <div className="panel status-panel">
          <div className="status-copy">
            <span className="eyebrow">Room {room.roomCode}</span>
            <h1>{statusMessage}</h1>
          </div>

          <div className="status-actions">
            <button
              className="secondary-button"
              onClick={handleRematchVote}
              disabled={!room.canStart || myRematchVote}
            >
              {myRematchVote ? "Rematch Voted" : "Rematch"}
            </button>
            {room.roundState.status === "abandoned" ? (
              <button className="primary-button" onClick={resetSession}>
                Return to Lobby
              </button>
            ) : null}
          </div>
        </div>

        <div className="scoreboard">
          {renderPlayerCard("player1")}
          {renderPlayerCard("player2")}
        </div>

        <div className="panel moves-panel">
          <div className="move-grid">
            {MOVES.map((move) => (
              <button
                key={move}
                className="move-button"
                onClick={() => handleMoveSelect(move)}
                disabled={moveButtonsDisabled}
              >
                <span className="move-name">{move}</span>
                <span className="move-hint">
                  {move === "rock"
                    ? "Crushes scissors"
                    : move === "paper"
                      ? "Covers rock"
                      : "Cuts paper"}
                </span>
              </button>
            ))}
          </div>

          <div className="round-footer">
            <div>
              <span className="meta-label">Round state</span>
              <strong>{room.roundState.status}</strong>
            </div>
            <div>
              <span className="meta-label">Opponent rematch</span>
              <strong>{opponentRematchVote ? "Ready" : "Not yet"}</strong>
            </div>
            <div>
              <span className="meta-label">Opponent</span>
              <strong>{opponent?.name ?? "Waiting"}</strong>
            </div>
          </div>
        </div>

        {lastRoundResult ? (
          <div className="result-banner">
            <strong>{getWinnerLabel(lastRoundResult.winner, selfSlot, room)}</strong>
            <span>
              {room.players.player1?.name}: {lastRoundResult.moves.player1} |{" "}
              {room.players.player2?.name}: {lastRoundResult.moves.player2}
            </span>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <main className="app-shell">
      <div className="background-orb orb-one" />
      <div className="background-orb orb-two" />

      <section className="chrome">
        <header className="topbar">
          <div>
            <span className="eyebrow">Realtime Browser Game</span>
            <p className="connection-pill">Status: {connectionStatus}</p>
          </div>

          {errorMessage ? <p className="error-pill">{errorMessage}</p> : null}
        </header>

        {!room && renderLobby()}
        {room && !room.canStart && room.roundState.status !== "abandoned" && renderWaitingRoom()}
        {room && (room.canStart || room.roundState.status === "abandoned") && renderGame()}
      </section>
    </main>
  );
}
