const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

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

app.use(express.static(publicDir));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(publicIndex, error => {
    if (error) res.sendFile(rootIndex);
  });
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
