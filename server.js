const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const rooms = new Map();
const ROLES = ["Guardian", "Seer", "Werewolf", "Hunter", "White Jack"];

function makeCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}
function roomFor(socket) {
  return socket.data.room ? rooms.get(socket.data.room) : null;
}
function playerFor(room, id) {
  return room?.players.find(p => p.id === id);
}
function alive(room) {
  return room.players.filter(p => p.alive);
}
function publicState(room, viewerId) {
  const me = playerFor(room, viewerId);
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    day: room.day,
    started: room.started,
    ended: room.ended,
    winner: room.winner,
    players: room.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive,
      role: room.ended ? p.role : (p.id === viewerId ? p.role : null)
    })),
    me: me ? { id: me.id, role: me.role, alive: me.alive } : null,
    notices: room.notices.slice(-8)
  };
}
function updateRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit("state", publicState(room, p.id));
  }
}
function notice(room, message) {
  room.notices.push(message);
  room.notices = room.notices.slice(-30);
  io.to(room.code).emit("notice", message);
}
function checkWinner(room) {
  if (room.ended) return true;
  const living = alive(room);
  if (!living.some(p => p.role === "Werewolf")) {
    room.ended = true; room.phase = "ended"; room.winner = "Village";
    notice(room, "Tim Village menang! Semua Werewolf sudah tereliminasi.");
  } else if (living.filter(p => p.role === "Werewolf").length >= living.filter(p => p.role !== "Werewolf").length) {
    room.ended = true; room.phase = "ended"; room.winner = "Werewolf";
    notice(room, "Tim Werewolf menang!");
  }
  if (room.ended) updateRoom(room);
  return room.ended;
}
function eliminate(room, player, reason) {
  if (!player || !player.alive) return;
  player.alive = false;
  notice(room, `${player.name} tereliminasi. (${reason})`);
}
function startNight(room) {
  if (room.ended) return;
  room.phase = "night";
  room.nightActions = {};
  notice(room, `Malam ${room.day} dimulai. Role khusus, lakukan aksimu.`);
  updateRoom(room);
}
function resolveNight(room) {
  const actions = room.nightActions || {};
  const guardian = room.players.find(p => p.role === "Guardian" && p.alive);
  const wolf = room.players.find(p => p.role === "Werewolf" && p.alive);
  const seer = room.players.find(p => p.role === "Seer" && p.alive);
  const whiteJack = room.players.find(p => p.role === "White Jack" && p.alive);

  if (seer && actions[seer.id]?.type === "seer") {
    const target = playerFor(room, actions[seer.id].target);
    if (target) io.to(seer.id).emit("privateMessage", `Hasil Seer: ${target.name} adalah ${target.role}.`);
  }
  if (whiteJack && actions[whiteJack.id]?.type === "whitejack") {
    const target = playerFor(room, actions[whiteJack.id].target);
    if (target && target.id !== whiteJack.id) {
      if (target.role === "Werewolf") {
        room.ended = true; room.phase = "ended"; room.winner = "White Jack";
        notice(room, "White Jack menebak dengan benar dan menang sendiri!");
        updateRoom(room); return;
      } else {
        eliminate(room, whiteJack, "White Jack salah menebak");
        if (checkWinner(room)) return;
      }
    }
  }
  let victim = null;
  if (wolf && actions[wolf.id]?.type === "wolf") {
    victim = playerFor(room, actions[wolf.id].target);
  }
  const protectedId = guardian && actions[guardian.id]?.type === "guardian"
    ? actions[guardian.id].target : null;
  if (victim && victim.alive) {
    if (victim.id === protectedId) notice(room, "Guardian berhasil menggagalkan serangan malam ini.");
    else eliminate(room, victim, "serangan malam");
  }
  if (checkWinner(room)) return;
  room.phase = "day";
  room.day += 1;
  room.votes = {};
  notice(room, "Pagi tiba. Diskusikan siapa yang dicurigai, lalu lakukan voting.");
  updateRoom(room);
}
function assignRoles(room) {
  const roleList = [...ROLES];
  while (roleList.length < room.players.length) roleList.push("Villager");
  // Fisher-Yates shuffle: role assignment is randomized on the server.
  for (let i = roleList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roleList[i], roleList[j]] = [roleList[j], roleList[i]];
  }
  room.players.forEach((p, i) => { p.role = roleList[i]; p.alive = true; });
}
function leaveRoom(socket) {
  const room = roomFor(socket);
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(room.code);
  socket.data.room = null;
  if (!room.players.length) rooms.delete(room.code);
  else {
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    if (room.started && !room.ended) checkWinner(room);
    updateRoom(room);
  }
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name }, cb) => {
    name = String(name || "").trim().slice(0, 18);
    if (!name) return cb?.({ error: "Masukkan nama dulu." });
    const code = makeCode();
    const room = { code, hostId: socket.id, players: [{ id: socket.id, name, alive: true, role: null }],
      started: false, ended: false, phase: "lobby", day: 0, winner: null,
      notices: ["Room dibuat. Bagikan kode room kepada teman."], nightActions: {}, votes: {} };
    rooms.set(code, room); socket.join(code); socket.data.room = code;
    cb?.({ code }); updateRoom(room);
  });
  socket.on("joinRoom", ({ name, code }, cb) => {
    name = String(name || "").trim().slice(0, 18);
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!name) return cb?.({ error: "Masukkan nama dulu." });
    if (!room) return cb?.({ error: "Room tidak ditemukan." });
    if (room.started) return cb?.({ error: "Game sudah dimulai." });
    if (room.players.length >= 10) return cb?.({ error: "Room penuh (maksimal 10 pemain)." });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return cb?.({ error: "Nama itu sudah dipakai di room." });
    if (socket.data.room) leaveRoom(socket);
    room.players.push({ id: socket.id, name, alive: true, role: null });
    socket.join(code); socket.data.room = code;
    cb?.({ ok: true }); updateRoom(room);
  });
  socket.on("startGame", cb => {
    const room = roomFor(socket);
    if (!room) return cb?.({ error: "Gabung room terlebih dahulu." });
    if (room.hostId !== socket.id) return cb?.({ error: "Hanya host yang bisa memulai." });
    if (room.started) return cb?.({ error: "Game sudah dimulai." });
    if (room.players.length < 5) return cb?.({ error: "Minimal 5 pemain untuk 5 role utama." });
    assignRoles(room); room.started = true; room.day = 1;
    notice(room, "Permainan dimulai! Periksa role rahasiamu.");
    startNight(room); cb?.({ ok: true }); updateRoom(room);
  });
  socket.on("nightAction", ({ type, target }, cb) => {
    const room = roomFor(socket), me = playerFor(room, socket.id), targetPlayer = playerFor(room, target);
    if (!room || !me || !me.alive || room.phase !== "night" || room.ended) return cb?.({ error: "Aksi tidak tersedia sekarang." });
    const allowed = { Guardian: "guardian", Seer: "seer", Werewolf: "wolf", "White Jack": "whitejack" };
    if (allowed[me.role] !== type) return cb?.({ error: "Role kamu tidak punya aksi itu." });
    if (!targetPlayer || !targetPlayer.alive || targetPlayer.id === me.id) return cb?.({ error: "Pilih pemain lain yang masih hidup." });
    room.nightActions[me.id] = { type, target };
    cb?.({ ok: true, message: "Aksi tersimpan." });
    // Resolusi otomatis ketika semua role yang hidup dan punya aksi sudah memilih.
    const actors = room.players.filter(p => p.alive && allowed[p.role]);
    if (actors.every(p => room.nightActions[p.id])) resolveNight(room);
  });
  socket.on("chat", ({ message }, cb) => {
    const room = roomFor(socket), me = playerFor(room, socket.id);
    message = String(message || "").trim().slice(0, 300);
    if (!room || !me || !message) return cb?.({ error: "Pesan kosong." });
    if (!room.started || room.ended || !me.alive) return cb?.({ error: "Kamu tidak bisa chat sekarang." });
    if (room.phase === "night") {
      if (me.role !== "Werewolf") return cb?.({ error: "Chat malam hanya untuk Werewolf." });
      room.players.filter(p => p.alive && p.role === "Werewolf")
        .forEach(p => io.to(p.id).emit("chatMessage", { name: me.name, message, channel: "wolf" }));
    } else if (room.phase === "day") {
      io.to(room.code).emit("chatMessage", { name: me.name, message, channel: "day" });
    } else return cb?.({ error: "Chat belum tersedia." });
    cb?.({ ok: true });
  });
  socket.on("vote", ({ target }, cb) => {
    const room = roomFor(socket), me = playerFor(room, socket.id), t = playerFor(room, target);
    if (!room || room.phase !== "day" || room.ended || !me?.alive) return cb?.({ error: "Voting tidak tersedia." });
    if (!t?.alive || t.id === me.id) return cb?.({ error: "Pilih pemain lain yang masih hidup." });
    room.votes[me.id] = target;
    cb?.({ ok: true, message: "Vote tersimpan." });
    const living = alive(room);
    if (living.every(p => room.votes[p.id])) {
      const counts = {};
      Object.values(room.votes).forEach(id => counts[id] = (counts[id] || 0) + 1);
      const max = Math.max(...Object.values(counts));
      const winners = Object.keys(counts).filter(id => counts[id] === max);
      if (winners.length > 1) notice(room, "Voting seri! Tidak ada yang dieliminasi hari ini.");
      else {
        const targetPlayer = playerFor(room, winners[0]);
        eliminate(room, targetPlayer, "hasil voting");
        if (targetPlayer?.role === "Hunter") {
          room.phase = "hunter";
          room.pendingHunter = targetPlayer.id;
          notice(room, "Hunter tereliminasi! Hunter boleh memilih satu pemain untuk ditembak.");
          io.to(targetPlayer.id).emit("privateMessage", "Kamu adalah Hunter. Pilih target untuk ditembak sekarang.");
          updateRoom(room); return;
        }
      }
      if (!checkWinner(room)) startNight(room);
    }
  });
  socket.on("hunterShot", ({ target }, cb) => {
    const room = roomFor(socket), hunter = playerFor(room, socket.id), t = playerFor(room, target);
    if (!room || room.phase !== "hunter" || room.pendingHunter !== socket.id) return cb?.({ error: "Aksi Hunter tidak tersedia." });
    if (!t?.alive || t.id === socket.id) return cb?.({ error: "Pilih pemain hidup lainnya." });
    eliminate(room, t, "tembakan Hunter");
    room.pendingHunter = null;
    if (!checkWinner(room)) startNight(room);
    cb?.({ ok: true }); updateRoom(room);
  });
  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Werewolf berjalan di port ${PORT}`);
});
