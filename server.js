import express from "express";
import Stripe from "stripe";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4242;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PRICE_CENTS = 100; // $1 per erase
// A Price from your Stripe product catalog (price_...). Recommended: it carries the product's tax code,
// which accounts using Stripe-managed tax require. Without it, checkout builds an untaxed $1 product.
const PRICE_ID = (process.env.STRIPE_PRICE_ID || "").trim();

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("Missing STRIPE_SECRET_KEY. Copy .env.example to .env and add your Stripe test key.");
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Paid credits: { players: { [pid]: { credits } }, sessions: { [sessionId]: true } }
// Kept in a JSON file. Credits are normally spent seconds after paying, so a lost file costs little.
const DATA_FILE = path.join(__dirname, "data.json");
let db = { players: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
const persist = () => {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
};
const player = pid => (db.players[pid] ??= { credits: 0 });

// Credits a paid Checkout Session exactly once, whether it arrives via webhook or the redirect.
// Returns how many erases were added (0 if unpaid or already credited).
async function creditSession(session) {
  if (session.payment_status !== "paid") return 0;
  if (db.sessions[session.id]) return 0;
  const pid = session.client_reference_id;
  if (!pid) return 0;
  const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
  const qty = items.data.reduce((n, li) => n + (li.quantity || 0), 0);
  if (db.sessions[session.id]) return 0; // re-check after the await
  db.sessions[session.id] = true;
  player(pid).credits += qty;
  persist();
  console.log(`Credited ${qty} erase(s) to ${pid} from ${session.id}`);
  broadcastPlayer(pid);
  return qty;
}

// --- Games live in memory. A restart ends games in progress; players just start a new one.
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const CELL_NAMES = ["top left","top middle","top right","middle left","center","middle right","bottom left","bottom middle","bottom right"];
const games = new Map();
const other = m => (m === "X" ? "O" : "X");

function newCode() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from(crypto.randomBytes(6), b => abc[b % abc.length]).join(""); } while (games.has(code));
  return code;
}

function createGame(pid) {
  const g = {
    code: newCode(), seats: { X: pid, O: null }, board: Array(9).fill(null),
    turn: "X", starter: "X", winner: null, line: null, draw: false, erasedThisTurn: false,
    score: { X: 0, O: 0, D: 0 }, log: [], clients: new Set(), touched: Date.now()
  };
  games.set(g.code, g);
  return g;
}

function settle(g) {
  for (const l of LINES) {
    const [a, b, c] = l;
    if (g.board[a] && g.board[a] === g.board[b] && g.board[b] === g.board[c]) {
      g.winner = g.board[a]; g.line = l; g.score[g.winner]++; return;
    }
  }
  if (g.board.every(Boolean)) { g.draw = true; g.score.D++; }
}

const seatOf = (g, pid) => (g.seats.X === pid ? "X" : g.seats.O === pid ? "O" : null);
const online = (g, seat) => [...g.clients].some(c => c.pid === g.seats[seat]);

function view(g, pid) {
  return {
    code: g.code, you: seatOf(g, pid), credits: player(pid).credits,
    board: g.board, turn: g.turn, winner: g.winner, line: g.line, draw: g.draw,
    erasedThisTurn: g.erasedThisTurn, score: g.score, log: g.log.slice(0, 30),
    seats: { X: !!g.seats.X, O: !!g.seats.O }, online: { X: online(g, "X"), O: online(g, "O") }
  };
}

function broadcast(g) {
  g.touched = Date.now();
  for (const c of g.clients) c.res.write(`data: ${JSON.stringify(view(g, c.pid))}\n\n`);
}
function broadcastPlayer(pid) {
  for (const g of games.values()) if (g.seats.X === pid || g.seats.O === pid) broadcast(g);
}

// Drop games nobody has touched for a day.
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600e3;
  for (const [code, g] of games) if (g.touched < cutoff && !g.clients.size) games.delete(code);
}, 3600e3).unref();

const app = express();
app.set("trust proxy", true);

// Webhook needs the raw body for signature verification, so it's registered before express.json().
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(400).send("Webhook secret not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch (err) {
    return res.status(400).send(`Webhook signature check failed: ${err.message}`);
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    try { await creditSession(event.data.object); }
    catch (err) { console.error(err); return res.status(500).end(); }
  }
  res.json({ received: true });
});

app.use(express.json());

// Anonymous player id in an httpOnly cookie: this is how the server knows who's X and who's O.
app.use((req, res, next) => {
  const m = /(?:^|;\s*)pid=([a-f0-9-]{36})/.exec(req.headers.cookie || "");
  req.pid = m ? m[1] : crypto.randomUUID();
  if (!m) {
    const secure = BASE_URL.startsWith("https://") ? "; Secure" : "";
    res.setHeader("Set-Cookie", `pid=${req.pid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  }
  next();
});

const gameFor = (req, res) => {
  const g = games.get(String(req.params.code || "").toUpperCase());
  if (!g) res.status(404).json({ error: "That game doesn't exist anymore. Start a new one." });
  return g;
};

app.post("/api/games", (req, res) => {
  const g = createGame(req.pid);
  res.json({ code: g.code });
});

// Live updates over Server-Sent Events. The first two people to open a game take X and O.
app.get("/api/games/:code/stream", (req, res) => {
  const g = gameFor(req, res);
  if (!g) return;
  if (!seatOf(g, req.pid) && !g.seats.O) g.seats.O = req.pid;
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
    Connection: "keep-alive", "X-Accel-Buffering": "no"
  });
  const client = { pid: req.pid, res };
  g.clients.add(client);
  broadcast(g);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); g.clients.delete(client); broadcast(g); });
});

app.post("/api/games/:code/move", (req, res) => {
  const g = gameFor(req, res);
  if (!g) return;
  const me = seatOf(g, req.pid), i = Number(req.body?.cell);
  if (!me) return res.status(403).json({ error: "You're watching this game, not playing." });
  if (g.winner || g.draw) return res.status(409).json({ error: "This round is over." });
  if (!g.seats.O) return res.status(409).json({ error: "Wait for your friend to join." });
  if (g.turn !== me) return res.status(409).json({ error: "It's not your turn." });
  if (!(i >= 0 && i < 9) || g.board[i]) return res.status(409).json({ error: "That square is taken." });
  g.board[i] = me;
  settle(g);
  if (!g.winner && !g.draw) { g.turn = other(me); g.erasedThisTurn = false; }
  broadcast(g);
  res.json({ ok: true });
});

app.post("/api/games/:code/erase", (req, res) => {
  const g = gameFor(req, res);
  if (!g) return;
  const me = seatOf(g, req.pid), i = Number(req.body?.cell);
  if (!me) return res.status(403).json({ error: "You're watching this game, not playing." });
  if (g.winner || g.draw) return res.status(409).json({ error: "This round is over." });
  if (g.turn !== me) return res.status(409).json({ error: "You can only erase on your turn." });
  if (g.erasedThisTurn) return res.status(409).json({ error: "You've already erased a mark this turn." });
  if (!(i >= 0 && i < 9) || g.board[i] !== other(me)) return res.status(409).json({ error: `Pick one of the ${other(me)}'s.` });
  const p = player(req.pid);
  if (p.credits < 1) return res.status(402).json({ error: "Pay $1 first." });
  p.credits -= 1;
  persist();
  g.board[i] = null;
  g.erasedThisTurn = true;
  g.log.unshift(`${me} paid $1 to erase the ${other(me)} at ${CELL_NAMES[i]}`);
  broadcast(g);
  res.json({ ok: true });
});

app.post("/api/games/:code/rematch", (req, res) => {
  const g = gameFor(req, res);
  if (!g) return;
  if (!seatOf(g, req.pid)) return res.status(403).json({ error: "Only the players can start a rematch." });
  if (!g.winner && !g.draw) return res.status(409).json({ error: "Finish this round first." });
  g.starter = other(g.starter);
  Object.assign(g, { board: Array(9).fill(null), turn: g.starter, winner: null, line: null, draw: false, erasedThisTurn: false });
  broadcast(g);
  res.json({ ok: true });
});

// Stripe Checkout for one $1 erase; Stripe sends the player back to their game afterwards.
app.post("/api/checkout", async (req, res) => {
  const code = String(req.body?.game || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: req.pid,
      line_items: [PRICE_ID ? { price: PRICE_ID, quantity: 1 } : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PRICE_CENTS,
          product_data: { name: "Bribe-Tac-Toe erase", description: "Erase one of your opponent's marks" }
        }
      }],
      success_url: `${BASE_URL}/bribe-tac-toe/?game=${code}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/bribe-tac-toe/?game=${code}&canceled=1`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout failed:", err.message);
    res.status(500).json({ error: "Couldn't open Stripe. Try again in a moment." });
  }
});

// Called when Stripe redirects back, so the payment counts even without a webhook.
app.post("/api/confirm", async (req, res) => {
  const id = String(req.body?.session_id || "");
  if (!id.startsWith("cs_")) return res.status(400).json({ error: "Invalid session" });
  try {
    const session = await stripe.checkout.sessions.retrieve(id);
    if (session.client_reference_id !== req.pid) return res.status(403).json({ error: "This payment belongs to another browser" });
    const added = await creditSession(session);
    res.json({ credits: player(req.pid).credits, paid: session.payment_status === "paid", added });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't confirm payment" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Bribe-Tac-Toe running at ${BASE_URL}`));
