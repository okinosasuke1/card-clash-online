const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 15;

const LEVELS = {
  easy: { rows: 4, cols: 4 },
  medium: { rows: 4, cols: 5 },
  hard: { rows: 4, cols: 6 }
};

const EMOJIS = [
  "🐉", "🦊", "🔥", "💎", "🌙", "⚔️", "🛡️", "👑",
  "🚀", "🪐", "⭐", "🌈", "⚡", "🧿", "🎲", "🦄",
  "🧊", "🌋", "🧬", "🕹️", "🔮", "🦾", "💀", "🍀"
];

const SKILLS = {
  sight: { id: "sight", name: "Soi Vòng", icon: "👁" },
  chaos: { id: "chaos", name: "Xào Lại Bài", icon: "🌀" },
  freeze: { id: "freeze", name: "Khóa Thẻ", icon: "❄️" }
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const publicDir = path.join(__dirname, "public");
const rootIndex = path.join(__dirname, "index.html");
const publicIndex = path.join(publicDir, "index.html");
const indexFile = fs.existsSync(publicIndex) ? publicIndex : rootIndex;

app.use(express.static(publicDir));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  if (!fs.existsSync(indexFile)) {
    res.status(404).send("CARD CLASH index.html not found");
    return;
  }
  res.sendFile(indexFile);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "card-clash-online" });
});

const waiting = [];
const rooms = new Map();
const socketRoom = new Map();

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildCards(total) {
  const symbols = shuffle(EMOJIS).slice(0, total / 2);
  return shuffle([...symbols, ...symbols]).map((emoji, id) => ({
    id,
    emoji,
    matched: false,
    owner: null,
    frozenFor: null
  }));
}

function cleanName(name, fallback) {
  const text = String(name || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
  return text || fallback;
}

function createRoom(socketA, socketB, level, nameA, nameB) {
  const cfg = LEVELS[level] || LEVELS.easy;
  const roomId = `room-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const room = {
    id: roomId,
    level,
    rows: cfg.rows,
    cols: cfg.cols,
    players: [
      { id: socketA.id, name: cleanName(nameA, "PLAYER 1"), score: 0, usedSkills: {} },
      { id: socketB.id, name: cleanName(nameB, "PLAYER 2"), score: 0, usedSkills: {} }
    ],
    cards: buildCards(cfg.rows * cfg.cols),
    flipped: [],
    current: 0,
    turnMatches: 0,
    locked: false,
    ended: false,
    deadline: 0,
    timer: null
  };

  rooms.set(roomId, room);
  socketRoom.set(socketA.id, roomId);
  socketRoom.set(socketB.id, roomId);
  socketA.join(roomId);
  socketB.join(roomId);
  startTurn(room, "Trận đấu bắt đầu!");
}

function publicState(room, viewerId) {
  const viewerIndex = room.players.findIndex(player => player.id === viewerId);
  return {
    roomId: room.id,
    level: room.level,
    rows: room.rows,
    cols: room.cols,
    current: room.current,
    deadline: room.deadline,
    you: viewerIndex,
    players: room.players.map(player => ({
      name: player.name,
      score: player.score,
      usedSkills: player.usedSkills
    })),
    cards: room.cards.map(card => {
      const visible = card.matched || room.flipped.includes(card.id);
      return {
        id: card.id,
        emoji: visible ? card.emoji : null,
        matched: card.matched,
        owner: card.owner,
        frozen: card.frozenFor === viewerIndex,
        lockedByOpponent: card.frozenFor !== null && card.frozenFor !== viewerIndex,
        flipped: room.flipped.includes(card.id)
      };
    })
  };
}

function emitState(room, log) {
  room.players.forEach(player => {
    io.to(player.id).emit("state", { state: publicState(room, player.id), log });
  });
}

function startTurn(room, log) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + TURN_SECONDS * 1000;
  emitState(room, log);
  room.timer = setTimeout(() => {
    if (room.ended) return;
    endTurn(room, `${room.players[room.current].name} hết giờ và mất lượt.`);
  }, TURN_SECONDS * 1000 + 150);
}

function endTurn(room, log) {
  clearTimeout(room.timer);
  room.flipped = [];
  room.locked = false;
  room.turnMatches = 0;
  clearFrozenFor(room, room.current);
  room.current = room.current === 0 ? 1 : 0;
  startTurn(room, log);
}

function clearFrozenFor(room, playerIndex) {
  room.cards.forEach(card => {
    if (card.frozenFor === playerIndex) card.frozenFor = null;
  });
}

function finishIfDone(room) {
  if (!room.cards.every(card => card.matched)) return false;
  room.ended = true;
  clearTimeout(room.timer);
  const [p1, p2] = room.players;
  let result = "Hòa!";
  if (p1.score > p2.score) result = `${p1.name} thắng!`;
  if (p2.score > p1.score) result = `${p2.name} thắng!`;
  emitState(room, "Ván đấu kết thúc.");
  io.to(room.id).emit("gameOver", {
    result,
    scores: room.players.map(player => ({ name: player.name, score: player.score }))
  });
  return true;
}

function getRoomFor(socket) {
  const roomId = socketRoom.get(socket.id);
  return roomId ? rooms.get(roomId) : null;
}

function playerIndex(room, socketId) {
  return room.players.findIndex(player => player.id === socketId);
}

function availableCards(room) {
  return room.cards.filter(card => !card.matched && !room.flipped.includes(card.id));
}

io.on("connection", socket => {
  socket.on("findMatch", ({ level = "easy", name = "" } = {}) => {
    const cleanLevel = LEVELS[level] ? level : "easy";
    const cleanPlayerName = cleanName(name, "Người chơi");
    const existing = waiting.find(entry => entry.socket.id !== socket.id && entry.level === cleanLevel);
    if (existing) {
      const index = waiting.indexOf(existing);
      waiting.splice(index, 1);
      createRoom(existing.socket, socket, cleanLevel, existing.name, cleanPlayerName);
      return;
    }

    if (!waiting.some(entry => entry.socket.id === socket.id)) {
      waiting.push({ socket, level: cleanLevel, name: cleanPlayerName });
    }
    socket.emit("queue", { message: "Đang tìm đối thủ..." });
  });

  socket.on("cancelQueue", () => {
    const index = waiting.findIndex(entry => entry.socket.id === socket.id);
    if (index >= 0) waiting.splice(index, 1);
    socket.emit("queueCancelled");
  });

  socket.on("flipCard", ({ id }) => {
    const room = getRoomFor(socket);
    if (!room || room.ended || room.locked) return;
    const index = playerIndex(room, socket.id);
    if (index !== room.current) return;
    const card = room.cards[id];
    if (!card || card.matched || room.flipped.includes(id)) return;
    if (card.frozenFor === index) {
      socket.emit("toast", "Thẻ này đang bị khóa.");
      return;
    }

    room.flipped.push(id);
    emitState(room);

    if (room.flipped.length !== 2) return;
    room.locked = true;
    setTimeout(() => {
      if (room.ended) return;
      const [firstId, secondId] = room.flipped;
      const first = room.cards[firstId];
      const second = room.cards[secondId];
      const player = room.players[room.current];

      if (first && second && first.emoji === second.emoji) {
        first.matched = true;
        second.matched = true;
        first.owner = room.current;
        second.owner = room.current;
        player.score += 1;
        room.turnMatches += 1;
        let log = `${player.name} ghép đúng ${first.emoji} ${second.emoji} và nhận +1 điểm.`;
        if (room.turnMatches === 2) {
          player.score += 1;
          log = `${log} COMBO x2: +1 điểm thưởng!`;
        }
        room.flipped = [];
        room.locked = false;
        clearFrozenFor(room, room.current);
        if (!finishIfDone(room)) startTurn(room, log);
        return;
      }

      const log = `${player.name} lật sai và mất lượt.`;
      setTimeout(() => endTurn(room, log), 600);
    }, 300);
  });

  socket.on("useSkill", ({ skillId }) => {
    const room = getRoomFor(socket);
    if (!room || room.ended || room.locked) return;
    const index = playerIndex(room, socket.id);
    if (index !== room.current) return;
    const player = room.players[index];
    const skill = SKILLS[skillId];
    if (!skill || player.usedSkills[skillId]) return;

    player.usedSkills[skillId] = true;

    if (skillId === "sight") {
      const picks = shuffle(availableCards(room)).slice(0, 3);
      socket.emit("peek", {
        cards: picks.map(card => ({ id: card.id, emoji: card.emoji })),
        ms: 2000
      });
      emitState(room, `${player.name} dùng ${skill.icon} ${skill.name}.`);
    }

    if (skillId === "chaos") {
      const unmatched = room.cards.filter(card => !card.matched);
      const emojis = shuffle(unmatched.map(card => card.emoji));
      unmatched.forEach((card, i) => {
        card.emoji = emojis[i];
      });
      room.flipped = [];
      emitState(room, `${player.name} dùng ${skill.icon} ${skill.name}: xào lại bài chưa ghép.`);
    }

    if (skillId === "freeze") {
      const opponent = index === 0 ? 1 : 0;
      const picks = shuffle(availableCards(room)).slice(0, 2);
      picks.forEach(card => {
        card.frozenFor = opponent;
      });
      emitState(room, `${player.name} dùng ${skill.icon} ${skill.name}: khóa 2 thẻ của đối thủ.`);
    }
  });

  socket.on("disconnect", () => {
    const waitingIndex = waiting.findIndex(entry => entry.socket.id === socket.id);
    if (waitingIndex >= 0) waiting.splice(waitingIndex, 1);

    const room = getRoomFor(socket);
    if (!room) return;
    room.ended = true;
    clearTimeout(room.timer);
    socketRoom.delete(socket.id);
    room.players.forEach(player => {
      if (player.id !== socket.id) {
        socketRoom.delete(player.id);
        io.to(player.id).emit("opponentLeft");
      }
    });
    rooms.delete(room.id);
  });
});

server.listen(PORT, () => {
  console.log(`CARD CLASH online running at http://localhost:${PORT}`);
});
