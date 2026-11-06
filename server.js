// Brick Planet (BPL) - Express + Socket.IO + Firebase Admin
// Required Render environment variables:
// FIREBASE_PROJECT_ID
// FIREBASE_CLIENT_EMAIL
// FIREBASE_PRIVATE_KEY
// CLIENT_ORIGIN (your frontend URL, e.g. https://brick-planet.onrender.com)
// PORT is supplied by Render.

const express = require("express");
const http = require("http");
const cors = require("cors");
const admin = require("firebase-admin");
const { Server } = require("socket.io");
require("dotenv").config();

const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

// Render may store the PEM key with literal \\n characters or real line breaks.
// Remove accidental wrapping quotes, normalize line breaks, and validate the PEM
// before passing it to Firebase Admin.
let firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY.trim();

if (
  (firebasePrivateKey.startsWith('"') && firebasePrivateKey.endsWith('"')) ||
  (firebasePrivateKey.startsWith("'") && firebasePrivateKey.endsWith("'"))
) {
  firebasePrivateKey = firebasePrivateKey.slice(1, -1);
}

firebasePrivateKey = firebasePrivateKey.replace(/\\n/g, "\n").trim();

if (
  !firebasePrivateKey.includes("-----BEGIN PRIVATE KEY-----") ||
  !firebasePrivateKey.includes("-----END PRIVATE KEY-----")
) {
  console.error(
    "FIREBASE_PRIVATE_KEY is not a valid PEM private key. In Render, paste only the private_key value from your Firebase service-account JSON, including the BEGIN/END lines."
  );
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: firebasePrivateKey,
    }),
  });
} catch (error) {
  console.error("Firebase Admin initialization failed:", error.message);
  console.error(
    "Check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in Render. Do not paste the service-account JSON or Web API key into FIREBASE_PRIVATE_KEY."
  );
  process.exit(1);
}

const db = admin.firestore();
const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CLIENT_ORIGIN || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests without an Origin header (health checks/server tools).
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
  })
);
app.use(express.json({ limit: "1mb" }));

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
    methods: ["GET", "POST"],
  },
});

const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();

function cleanText(value, maxLength = 80) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function publicQuestion(question) {
  return {
    text: question.text,
    answers: question.answers,
    // Never send correctIndex to players before they answer.
  };
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return res.status(401).json({ error: "Sign in first." });
    }

    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    return res.status(401).json({ error: "Your sign-in session is invalid or expired." });
  }
}

async function getOrCreateProfile(user) {
  const ref = db.collection("users").doc(user.uid);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    const emailName = user.email ? user.email.split("@")[0] : "Player";
    const username = cleanText(user.name || emailName, 20) || "Player";

    await ref.set(
      {
        uid: user.uid,
        username,
        coins: 0,
        gamesPlayed: 0,
        totalScore: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  const latest = await ref.get();
  return { id: latest.id, ...latest.data() };
}

app.get("/", (_req, res) => {
  res.json({ name: "Brick Planet API", status: "online", version: "1.0.0" });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Get or create the signed-in player's profile.
app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    const profile = await getOrCreateProfile(req.user);
    res.json({ profile });
  } catch (error) {
    console.error("Profile error:", error);
    res.status(500).json({ error: "Could not load your profile." });
  }
});

// Change username.
app.patch("/api/profile", requireAuth, async (req, res) => {
  try {
    const username = cleanText(req.body.username, 20);
    if (username.length < 3) {
      return res.status(400).json({ error: "Username must be 3–20 characters." });
    }

    const ref = db.collection("users").doc(req.user.uid);
    await getOrCreateProfile(req.user);
    await ref.set({ username, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    res.json({ success: true, username });
  } catch (error) {
    console.error("Username update error:", error);
    res.status(500).json({ error: "Could not update your username." });
  }
});

// Create a quiz. Body: { title, description, isPublic, questions: [{text, answers, correctIndex}] }
app.post("/api/quizzes", requireAuth, async (req, res) => {
  try {
    const title = cleanText(req.body.title, 80);
    const description = cleanText(req.body.description, 300);
    const questions = req.body.questions;
    const isPublic = req.body.isPublic === true;

    if (!title) return res.status(400).json({ error: "Quiz title is required." });
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 50) {
      return res.status(400).json({ error: "A quiz must have 1–50 questions." });
    }

    const validQuestions = [];
    for (const question of questions) {
      const text = cleanText(question.text, 300);
      const answers = Array.isArray(question.answers)
        ? question.answers.map((answer) => cleanText(answer, 120))
        : [];
      const correctIndex = Number(question.correctIndex);

      if (
        !text ||
        answers.length < 2 ||
        answers.length > 4 ||
        answers.some((answer) => !answer) ||
        !Number.isInteger(correctIndex) ||
        correctIndex < 0 ||
        correctIndex >= answers.length
      ) {
        return res.status(400).json({
          error: "Each question needs text, 2–4 answers, and a valid correctIndex.",
        });
      }

      validQuestions.push({ text, answers, correctIndex });
    }

    const ref = await db.collection("quizzes").add({
      title,
      description,
      questions: validQuestions,
      ownerUid: req.user.uid,
      isPublic,
      plays: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ success: true, quizId: ref.id });
  } catch (error) {
    console.error("Quiz creation error:", error);
    res.status(500).json({ error: "Could not create quiz." });
  }
});

// Browse public quizzes. Does not return questions or answers.
app.get("/api/quizzes", async (_req, res) => {
  try {
    const snapshot = await db.collection("quizzes")
      .where("isPublic", "==", true)
      .limit(100)
      .get();

    const quizzes = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title,
        description: data.description || "",
        plays: data.plays || 0,
        questionCount: Array.isArray(data.questions) ? data.questions.length : 0,
      };
    });

    res.json({ quizzes });
  } catch (error) {
    console.error("Quiz list error:", error);
    res.status(500).json({ error: "Could not load quizzes." });
  }
});

// Get a quiz. Owners receive correct answers; other players do not.
app.get("/api/quizzes/:id", requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("quizzes").doc(req.params.id).get();
    if (!snapshot.exists) return res.status(404).json({ error: "Quiz not found." });

    const quiz = snapshot.data();
    const isOwner = quiz.ownerUid === req.user.uid;

    if (!isOwner && !quiz.isPublic) {
      return res.status(403).json({ error: "This quiz is private." });
    }

    res.json({
      quiz: {
        id: snapshot.id,
        title: quiz.title,
        description: quiz.description || "",
        questions: (quiz.questions || []).map((question) =>
          isOwner
            ? question
            : { text: question.text, answers: question.answers }
        ),
        isOwner,
      },
    });
  } catch (error) {
    console.error("Quiz read error:", error);
    res.status(500).json({ error: "Could not load quiz." });
  }
});

// Edit a quiz. Only its owner can edit it.
app.patch("/api/quizzes/:id", requireAuth, async (req, res) => {
  try {
    const ref = db.collection("quizzes").doc(req.params.id);
    const snapshot = await ref.get();

    if (!snapshot.exists) return res.status(404).json({ error: "Quiz not found." });
    if (snapshot.data().ownerUid !== req.user.uid) {
      return res.status(403).json({ error: "Only the quiz owner can edit it." });
    }

    const updates = {};
    if (req.body.title !== undefined) {
      const title = cleanText(req.body.title, 80);
      if (!title) return res.status(400).json({ error: "Title cannot be empty." });
      updates.title = title;
    }
    if (req.body.description !== undefined) {
      updates.description = cleanText(req.body.description, 300);
    }
    if (req.body.isPublic !== undefined) {
      updates.isPublic = req.body.isPublic === true;
    }
    if (req.body.questions !== undefined) {
      if (!Array.isArray(req.body.questions) || req.body.questions.length < 1 || req.body.questions.length > 50) {
        return res.status(400).json({ error: "A quiz must have 1–50 questions." });
      }

      const questions = req.body.questions.map((question) => ({
        text: cleanText(question.text, 300),
        answers: Array.isArray(question.answers)
          ? question.answers.map((answer) => cleanText(answer, 120))
          : [],
        correctIndex: Number(question.correctIndex),
      }));

      const invalid = questions.some((question) =>
        !question.text ||
        question.answers.length < 2 ||
        question.answers.length > 4 ||
        question.answers.some((answer) => !answer) ||
        !Number.isInteger(question.correctIndex) ||
        question.correctIndex < 0 ||
        question.correctIndex >= question.answers.length
      );
      if (invalid) return res.status(400).json({ error: "One or more questions are invalid." });
      updates.questions = questions;
    }

    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.update(updates);
    res.json({ success: true });
  } catch (error) {
    console.error("Quiz update error:", error);
    res.status(500).json({ error: "Could not update quiz." });
  }
});

// Delete a quiz. Only its owner can delete it.
app.delete("/api/quizzes/:id", requireAuth, async (req, res) => {
  try {
    const ref = db.collection("quizzes").doc(req.params.id);
    const snapshot = await ref.get();

    if (!snapshot.exists) return res.status(404).json({ error: "Quiz not found." });
    if (snapshot.data().ownerUid !== req.user.uid) {
      return res.status(403).json({ error: "Only the quiz owner can delete it." });
    }

    await ref.delete();
    res.json({ success: true });
  } catch (error) {
    console.error("Quiz delete error:", error);
    res.status(500).json({ error: "Could not delete quiz." });
  }
});

// Leaderboard.
app.get("/api/leaderboard", async (_req, res) => {
  try {
    const snapshot = await db.collection("users")
      .orderBy("totalScore", "desc")
      .limit(50)
      .get();

    res.json({
      leaderboard: snapshot.docs.map((doc) => ({
        uid: doc.id,
        username: doc.data().username || "Player",
        totalScore: doc.data().totalScore || 0,
        gamesPlayed: doc.data().gamesPlayed || 0,
      })),
    });
  } catch (error) {
    console.error("Leaderboard error:", error);
    res.status(500).json({ error: "Could not load leaderboard." });
  }
});

// Match history for the signed-in player.
app.get("/api/matches", requireAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("matches")
      .where("playerUids", "array-contains", req.user.uid)
      .limit(50)
      .get();

    res.json({
      matches: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    });
  } catch (error) {
    console.error("Match history error:", error);
    res.status(500).json({ error: "Could not load match history." });
  }
});

// Socket.IO authentication: frontend sends { auth: { token: firebaseIdToken } }.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error("Sign in to play."));
    socket.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (_error) {
    next(new Error("Your sign-in session is invalid or expired."));
  }
});

function getRoomForSocket(socket, code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Room not found.");
  if (!room.players.has(socket.user.uid)) throw new Error("Join the room first.");
  return room;
}

function sendQuestion(room) {
  const question = room.quiz.questions[room.questionIndex];
  if (!question) return;

  io.to(room.code).emit("question", {
    index: room.questionIndex,
    total: room.quiz.questions.length,
    question: publicQuestion(question),
  });
}

async function finishMatch(room) {
  if (room.finished) return;
  room.finished = true;

  const results = Array.from(room.players.values())
    .map((player) => ({
      uid: player.uid,
      username: player.username,
      score: player.score,
    }))
    .sort((a, b) => b.score - a.score);

  const matchData = {
    roomCode: room.code,
    quizId: room.quizId,
    quizTitle: room.quiz.title,
    hostUid: room.hostUid,
    playerUids: results.map((player) => player.uid),
    results,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await db.collection("matches").add(matchData);

    const batch = db.batch();
    for (const player of results) {
      const userRef = db.collection("users").doc(player.uid);
      batch.set(userRef, {
        gamesPlayed: admin.firestore.FieldValue.increment(1),
        totalScore: admin.firestore.FieldValue.increment(player.score),
        coins: admin.firestore.FieldValue.increment(Math.max(0, Math.floor(player.score / 100))),
      }, { merge: true });
    }
    await batch.commit();
  } catch (error) {
    console.error("Could not save match:", error);
  }

  io.to(room.code).emit("game-over", { results });
}

io.on("connection", (socket) => {
  socket.on("create-room", async ({ quizId } = {}, callback = () => {}) => {
    try {
      if (typeof quizId !== "string" || !quizId) throw new Error("Choose a quiz first.");

      const quizSnapshot = await db.collection("quizzes").doc(quizId).get();
      if (!quizSnapshot.exists) throw new Error("Quiz not found.");

      const quiz = quizSnapshot.data();
      if (quiz.ownerUid !== socket.user.uid && !quiz.isPublic) {
        throw new Error("This quiz is private.");
      }
      if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
        throw new Error("This quiz has no questions.");
      }

      const profile = await getOrCreateProfile(socket.user);
      const code = makeRoomCode();
      const room = {
        code,
        quizId,
        quiz: { title: quiz.title, questions: quiz.questions },
        hostUid: socket.user.uid,
        players: new Map(),
        questionIndex: -1,
        started: false,
        finished: false,
      };

      room.players.set(socket.user.uid, {
        uid: socket.user.uid,
        username: profile.username || "Host",
        score: 0,
        answered: false,
      });

      rooms.set(code, room);
      socket.join(code);
      callback({ success: true, code });
      io.to(code).emit("room-updated", {
        code,
        players: Array.from(room.players.values()).map(({ uid, username, score }) => ({ uid, username, score })),
      });
    } catch (error) {
      callback({ success: false, error: error.message || "Could not create room." });
    }
  });

  socket.on("join-room", async ({ code } = {}, callback = () => {}) => {
    try {
      const normalizedCode = cleanText(code, 6).toUpperCase();
      const room = rooms.get(normalizedCode);
      if (!room) throw new Error("Room not found.");
      if (room.started) throw new Error("This game has already started.");
      if (room.players.has(socket.user.uid)) throw new Error("You are already in this room.");

      const profile = await getOrCreateProfile(socket.user);
      room.players.set(socket.user.uid, {
        uid: socket.user.uid,
        username: profile.username || "Player",
        score: 0,
        answered: false,
      });

      socket.join(normalizedCode);
      callback({ success: true, code: normalizedCode });
      io.to(normalizedCode).emit("room-updated", {
        code: normalizedCode,
        players: Array.from(room.players.values()).map(({ uid, username, score }) => ({ uid, username, score })),
      });
    } catch (error) {
      callback({ success: false, error: error.message || "Could not join room." });
    }
  });

  socket.on("start-game", ({ code } = {}, callback = () => {}) => {
    try {
      const room = getRoomForSocket(socket, code);
      if (room.hostUid !== socket.user.uid) throw new Error("Only the host can start the game.");
      if (room.started) throw new Error("The game has already started.");

      room.started = true;
      room.questionIndex = 0;
      room.players.forEach((player) => { player.answered = false; });
      callback({ success: true });
      sendQuestion(room);
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("submit-answer", ({ code, answerIndex } = {}, callback = () => {}) => {
    try {
      const room = getRoomForSocket(socket, code);
      if (!room.started || room.finished) throw new Error("The game is not accepting answers.");
      const player = room.players.get(socket.user.uid);
      if (player.answered) throw new Error("You already answered this question.");

      const question = room.quiz.questions[room.questionIndex];
      const selected = Number(answerIndex);
      if (!Number.isInteger(selected) || selected < 0 || selected >= question.answers.length) {
        throw new Error("Choose a valid answer.");
      }

      const correct = selected === question.correctIndex;
      if (correct) player.score += 100;

      player.answered = true;
      callback({ success: true, correct, score: player.score });

      const allAnswered = Array.from(room.players.values()).every((entry) => entry.answered);
      if (allAnswered) {
        io.to(room.code).emit("question-complete", {
          scores: Array.from(room.players.values()).map(({ uid, username, score }) => ({ uid, username, score })),
        });
      }
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("next-question", ({ code } = {}, callback = () => {}) => {
    try {
      const room = getRoomForSocket(socket, code);
      if (room.hostUid !== socket.user.uid) throw new Error("Only the host can move to the next question.");
      if (!room.started || room.finished) throw new Error("The game is not active.");

      const allAnswered = Array.from(room.players.values()).every((player) => player.answered);
      if (!allAnswered) throw new Error("Wait until everyone has answered.");

      room.questionIndex += 1;
      if (room.questionIndex >= room.quiz.questions.length) {
        callback({ success: true, finished: true });
        finishMatch(room);
        return;
      }

      room.players.forEach((player) => { player.answered = false; });
      callback({ success: true, finished: false });
      sendQuestion(room);
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("disconnect", () => {
    // Rooms are intentionally kept alive until the process restarts.
    // A disconnected player remains in the room's score/results.
  });
});

server.listen(PORT, () => {
  console.log(`Brick Planet API listening on port ${PORT}`);
});
