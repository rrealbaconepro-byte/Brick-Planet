
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET || !DATABASE_URL) {
  throw new Error("Missing JWT_SECRET or DATABASE_URL");
}

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false"
    ? false
    : { rejectUnauthorized: false }
});

app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "*"
}));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300
}));

// DATABASE

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(24) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      coins INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS quizzes (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(100) NOT NULL,
      description TEXT DEFAULT '',
      questions JSONB NOT NULL DEFAULT '[]',
      public BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS match_history (
      id SERIAL PRIMARY KEY,
      room_code VARCHAR(8),
      quiz_id INTEGER REFERENCES quizzes(id) ON DELETE SET NULL,
      results JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// AUTHENTICATION

function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({ error: "Login required" });
    }

    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// HEALTH CHECK

app.get("/", (req, res) => {
  res.json({
    site: "Brick Planet",
    status: "online",
    version: "1.0.0"
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ status: "healthy", database: "connected" });
  } catch {
    res.status(503).json({ status: "unhealthy" });
  }
});

// ACCOUNT CREATION

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (
      typeof username !== "string" ||
      !/^[a-zA-Z0-9_]{3,24}$/.test(username) ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128
    ) {
      return res.status(400).json({
        error: "Invalid account details. Password must be at least 8 characters."
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await db.query(
      `INSERT INTO users (username, email, password)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, coins`,
      [username, email.toLowerCase(), hash]
    );

    const user = result.rows[0];

    res.status(201).json({
      user,
      token: createToken(user)
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Username or email already exists"
      });
    }

    res.status(500).json({ error: "Registration failed" });
  }
});

// LOGIN

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({ error: "Invalid login details" });
    }

    const result = await db.query(
      "SELECT * FROM users WHERE email = $1",
      [email.toLowerCase()]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Incorrect email or password" });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        coins: user.coins
      },
      token: createToken(user)
    });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

// PROFILE

app.get("/api/profile", authenticate, async (req, res) => {
  const result = await db.query(
    `SELECT id, username, email, coins, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "Account not found" });
  }

  res.json(result.rows[0]);
});

// QUIZ CREATION

function validQuestions(questions) {
  return Array.isArray(questions) &&
    questions.length > 0 &&
    questions.length <= 100 &&
    questions.every(q =>
      q &&
      typeof q.question === "string" &&
      q.question.length > 0 &&
      q.question.length <= 500 &&
      Array.isArray(q.answers) &&
      q.answers.length >= 2 &&
      q.answers.length <= 6 &&
      q.answers.every(a =>
        typeof a === "string" && a.length <= 200
      ) &&
      Number.isInteger(q.correctAnswer) &&
      q.correctAnswer >= 0 &&
      q.correctAnswer < q.answers.length
    );
}

app.post("/api/quizzes", authenticate, async (req, res) => {
  const { title, description, questions, public: isPublic } = req.body;

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 100 ||
    !validQuestions(questions)
  ) {
    return res.status(400).json({ error: "Invalid quiz data" });
  }

  const result = await db.query(
    `INSERT INTO quizzes
     (owner_id, title, description, questions, public)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      req.user.id,
      title.trim(),
      typeof description === "string" ? description.slice(0, 1000) : "",
      JSON.stringify(questions),
      isPublic !== false
    ]
  );

  res.status(201).json(result.rows[0]);
});

// VIEW QUIZZES

app.get("/api/quizzes", async (req, res) => {
  const result = await db.query(`
    SELECT q.id, q.title, q.description, q.created_at,
           u.username AS creator,
           jsonb_array_length(q.questions) AS question_count
    FROM quizzes q
    JOIN users u ON u.id = q.owner_id
    WHERE q.public = TRUE
    ORDER BY q.created_at DESC
    LIMIT 100
  `);

  res.json(result.rows);
});

// VIEW ONE QUIZ

app.get("/api/quizzes/:id", async (req, res) => {
  const result = await db.query(
    `SELECT q.id, q.title, q.description, q.questions,
            q.owner_id, q.public, u.username AS creator
     FROM quizzes q
     JOIN users u ON u.id = q.owner_id
     WHERE q.id = $1`,
    [req.params.id]
  );

  const quiz = result.rows[0];

  if (!quiz || (!quiz.public && !req.headers.authorization)) {
    return res.status(404).json({ error: "Quiz not found" });
  }

  if (!quiz.public) {
    try {
      const token = req.headers.authorization.split(" ")[1];
      const user = jwt.verify(token, JWT_SECRET);

      if (user.id !== quiz.owner_id) {
        return res.status(404).json({ error: "Quiz not found" });
      }
    } catch {
      return res.status(401).json({ error: "Login required" });
    }
  }

  res.json(quiz);
});

// EDIT QUIZ

app.put("/api/quizzes/:id", authenticate, async (req, res) => {
  const { title, description, questions, public: isPublic } = req.body;

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 100 ||
    !validQuestions(questions)
  ) {
    return res.status(400).json({ error: "Invalid quiz data" });
  }

  const result = await db.query(
    `UPDATE quizzes
     SET title = $1, description = $2,
         questions = $3, public = $4
     WHERE id = $5 AND owner_id = $6
     RETURNING *`,
    [
      title.trim(),
      typeof description === "string" ? description.slice(0, 1000) : "",
      JSON.stringify(questions),
      isPublic !== false,
      req.params.id,
      req.user.id
    ]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "Quiz not found or not yours" });
  }

  res.json(result.rows[0]);
});

// DELETE QUIZ

app.delete("/api/quizzes/:id", authenticate, async (req, res) => {
  const result = await db.query(
    "DELETE FROM quizzes WHERE id = $1 AND owner_id = $2 RETURNING id",
    [req.params.id, req.user.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "Quiz not found or not yours" });
  }

  res.json({ success: true });
});

// MULTIPLAYER GAME SYSTEM

const rooms = new Map();

function generateCode() {
  let code;

  do {
    code = crypto.randomInt(100000, 1000000).toString();
  } while (rooms.has(code));

  return code;
}

function roomPlayers(room) {
  return [...room.players.values()].map(p => ({
    username: p.username,
    score: p.score,
    connected: p.connected
  }));
}

function broadcastPlayers(code) {
  const room = rooms.get(code);
  if (!room) return;

  io.to(code).emit("players-update", roomPlayers(room));
}

function cleanQuestion(question) {
  return {
    question: question.question,
    answers: question.answers
  };
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Login required"));
    }

    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid login token"));
  }
});

io.on("connection", socket => {

  // CREATE ROOM

  socket.on("create-room", async ({ quizId } = {}, callback = () => {}) => {
    try {
      const result = await db.query(
        "SELECT * FROM quizzes WHERE id = $1 AND owner_id = $2",
        [quizId, socket.user.id]
      );

      const quiz = result.rows[0];

      if (!quiz || !validQuestions(quiz.questions)) {
        return callback({ error: "Quiz unavailable" });
      }

      const code = generateCode();

      rooms.set(code, {
        code,
        host: socket.id,
        hostUserId: socket.user.id,
        quizId: quiz.id,
        title: quiz.title,
        questions: quiz.questions,
        players: new Map(),
        questionIndex: -1,
        status: "waiting"
      });

      socket.join(code);

      callback({
        success: true,
        code,
        title: quiz.title
      });
    } catch {
      callback({ error: "Could not create game" });
    }
  });

  // JOIN ROOM

  socket.on("join-room", ({ code } = {}, callback = () => {}) => {
    const room = rooms.get(String(code || ""));

    if (!room || room.status !== "waiting") {
      return callback({ error: "Game not found or already started" });
    }

    if (room.players.size >= 100) {
      return callback({ error: "Game is full" });
    }

    if ([...room.players.values()].some(
      p => p.userId === socket.user.id
    )) {
      return callback({ error: "Already in this game" });
    }

    room.players.set(socket.id, {
      userId: socket.user.id,
      username: socket.user.username,
      score: 0,
      connected: true,
      answered: false
    });

    socket.join(room.code);

    callback({
      success: true,
      code: room.code,
      title: room.title,
      players: roomPlayers(room)
    });

    broadcastPlayers(room.code);

    io.to(room.code).emit("player-joined", {
      username: socket.user.username
    });
  });

  // START GAME

  socket.on("start-game", ({ code } = {}, callback = () => {}) => {
    const room = rooms.get(String(code || ""));

    if (!room || room.host !== socket.id) {
      return callback({ error: "Only the host can start the game" });
    }

    if (room.status !== "waiting") {
      return callback({ error: "Game already started" });
    }

    if (room.players.size === 0) {
      return callback({ error: "Waiting for players" });
    }

    room.status = "playing";
    room.questionIndex = 0;

    const question = room.questions[0];

    io.to(room.code).emit("game-started", {
      title: room.title,
      totalQuestions: room.questions.length,
      question: cleanQuestion(question),
      questionNumber: 1
    });

    callback({ success: true });
  });

  // SUBMIT ANSWER

  socket.on("submit-answer", ({ code, answerIndex } = {}, callback = () => {}) => {
    const room = rooms.get(String(code || ""));

    if (!room || room.status !== "playing") {
      return callback({ error: "Game is not running" });
    }

    const player = room.players.get(socket.id);

    if (!player || player.answered) {
      return callback({ error: "Answer already submitted or player missing" });
    }

    if (
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= room.questions[room.questionIndex].answers.length
    ) {
      return callback({ error: "Invalid answer" });
    }

    const question = room.questions[room.questionIndex];
    const correct = answerIndex === question.correctAnswer;

    player.answered = true;

    if (correct) {
      player.score += 100;
    }

    callback({
      success: true,
      correct,
      pointsEarned: correct ? 100 : 0,
      score: player.score
    });

    broadcastPlayers(room.code);
  });

  // NEXT QUESTION

  socket.on("next-question", ({ code } = {}, callback = () => {}) => {
    const room = rooms.get(String(code || ""));

    if (!room || room.host !== socket.id || room.status !== "playing") {
      return callback({ error: "Host permission required" });
    }

    if (room.questionIndex + 1 >= room.questions.length) {
      room.status = "finished";

      const results = roomPlayers(room).sort(
        (a, b) => b.score - a.score
      );

      io.to(room.code).emit("game-ended", { results });

      db.query(
        `INSERT INTO match_history (room_code, quiz_id, results)
         VALUES ($1, $2, $3)`,
        [room.code, room.quizId, JSON.stringify(results)]
      ).catch(console.error);

      return callback({ success: true, finished: true, results });
    }

    room.questionIndex++;

    for (const player of room.players.values()) {
      player.answered = false;
    }

    io.to(room.code).emit("new-question", {
      question: cleanQuestion(room.questions[room.questionIndex]),
      questionNumber: room.questionIndex + 1,
      totalQuestions: room.questions.length
    });

    callback({ success: true });
  });

  // LEAVE ROOM / DISCONNECT

  socket.on("leave-room", ({ code } = {}) => {
    leaveRoom(socket, code);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (room.players.has(socket.id)) {
        room.players.get(socket.id).connected = false;
        broadcastPlayers(code);
      }
    }
  });
});

function leaveRoom(socket, code) {
  const room = rooms.get(String(code || ""));
  if (!room) return;

  if (room.players.has(socket.id)) {
    room.players.delete(socket.id);
    socket.leave(room.code);
    broadcastPlayers(room.code);
  }
}

// GLOBAL LEADERBOARD

app.get("/api/leaderboard", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT username, coins
       FROM users
       ORDER BY coins DESC
       LIMIT 50`
    );

    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Leaderboard unavailable" });
  }
});

// START SERVER

async function start() {
  await initDatabase();

  server.listen(PORT, () => {
    console.log(`🧱 Brick Planet running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
