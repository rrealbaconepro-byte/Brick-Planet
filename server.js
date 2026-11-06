
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/health", (req, res) => {
  res.json({
    name: "Brick Planet",
    status: "healthy"
  });
});

// Protect private server files
app.use((req, res, next) => {
  const blocked = [
    /^\/server\.js$/i,
    /^\/package(-lock)?\.json$/i,
    /^\/\.env/i,
    /^\/.*service-account.*\.json$/i,
    /^\/node_modules(?:\/|$)/i,
    /^\/\.git(?:\/|$)/i
  ];

  if (blocked.some(pattern => pattern.test(req.path))) {
    return res.sendStatus(404);
  }

  next();
});

// Serve all frontend files from the repository
app.use(express.static(__dirname, {
  index: false,
  dotfiles: "deny",
  extensions: ["html"]
}));

// Main website
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Frontend route fallback
app.use((req, res, next) => {
  if (
    req.method !== "GET" ||
    req.path.startsWith("/socket.io/") ||
    path.extname(req.path) !== "" ||
    !req.accepts("html")
  ) {
    return next();
  }

  res.sendFile(path.join(__dirname, "index.html"), err => {
    if (err) next(err);
  });
});

// Multiplayer connection foundation
io.on("connection", socket => {
  console.log("Player connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Brick Planet running on port ${PORT}`);
});
