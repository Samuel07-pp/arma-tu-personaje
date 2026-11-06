// Servidor de "Arma tu personaje" para Render.
// Publica /public, guarda cada clic en "Generar personaje" en Postgres y expone el panel privado.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PUBLIC_DIR = join(process.cwd(), "public");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

await pool.query(`CREATE TABLE IF NOT EXISTS personajes (
  id TEXT PRIMARY KEY,
  creado TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado TIMESTAMPTZ,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  nombre TEXT,
  empresa TEXT NOT NULL,
  sexo TEXT, departamento TEXT, prenda_en_color TEXT, pose TEXT, objeto TEXT,
  seleccion JSONB, accesorios JSONB, prompt TEXT NOT NULL, state JSONB
)`);

await pool.query("ALTER TABLE personajes ALTER COLUMN nombre DROP NOT NULL");

const ESTADOS = ["pendiente", "generado", "descartado"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}
function readBody(req, limit = 30000) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const toItem = (r) => ({
  id: r.id, creado: r.creado, actualizado: r.actualizado, estado: r.estado, nombre: r.nombre, empresa: r.empresa,
  sexo: r.sexo, departamento: r.departamento, prendaEnColor: r.prenda_en_color, pose: r.pose, objeto: r.objeto,
  seleccion: r.seleccion, accesorios: r.accesorios, prompt: r.prompt,
});

// Límite simple: 10 envíos por IP cada 10 minutos.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 10;
}

async function guardar(req, res) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "Demasiados envíos seguidos. Intenta en unos minutos." });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: "Solicitud inválida" }); }
  if (str(body.website)) return send(res, 200, { ok: true }); // campo trampa contra bots
  const nombre = str(body.nombre, 80) || null, empresa = str(body.empresa, 40), prompt = str(body.prompt, 6000), departamento = str(body.departamento, 80);
  if (!empresa || !departamento || !prompt) return send(res, 400, { error: "Faltan datos del personaje" });
  const seleccion = {};
  if (body.seleccion && typeof body.seleccion === "object")
    for (const [k, v] of Object.entries(body.seleccion).slice(0, 20)) seleccion[str(k, 40)] = str(v, 80);
  const accesorios = Array.isArray(body.accesorios) ? body.accesorios.slice(0, 20).map((a) => str(a, 40)) : [];
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO personajes (id,nombre,empresa,sexo,departamento,prenda_en_color,pose,objeto,seleccion,accesorios,prompt,state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, nombre, empresa, str(body.sexo, 20), departamento, str(body.prendaEnColor, 20), str(body.pose, 60), str(body.objeto, 60),
     JSON.stringify(seleccion), JSON.stringify(accesorios), prompt, body.state && typeof body.state === "object" ? JSON.stringify(body.state) : null]);
  send(res, 200, { ok: true, id });
}

async function admin(req, res, url) {
  if (!ADMIN_TOKEN) return send(res, 500, { error: "Falta configurar ADMIN_TOKEN en Render" });
  if ((req.headers.authorization || "") !== `Bearer ${ADMIN_TOKEN}`) return send(res, 401, { error: "Clave incorrecta" });
  if (req.method === "GET") {
    const { rows } = await pool.query("SELECT * FROM personajes ORDER BY creado DESC LIMIT 2000");
    return send(res, 200, { items: rows.map(toItem) });
  }
  if (req.method === "PATCH") {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "Formato inválido" }); }
    if (!body.id || !ESTADOS.includes(body.estado)) return send(res, 400, { error: "Datos inválidos" });
    const { rows } = await pool.query("UPDATE personajes SET estado=$2, actualizado=now() WHERE id=$1 RETURNING *", [body.id, body.estado]);
    return rows[0] ? send(res, 200, { ok: true, item: toItem(rows[0]) }) : send(res, 404, { error: "No existe esa solicitud" });
  }
  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return send(res, 400, { error: "Falta el id" });
    await pool.query("DELETE FROM personajes WHERE id=$1", [id]);
    return send(res, 200, { ok: true });
  }
  send(res, 405, { error: "Método no permitido" });
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^([/\\])+/, "");
  if (rel.includes("..")) { res.writeHead(400); return res.end(); }
  try {
    const file = await readFile(join(PUBLIC_DIR, rel));
    const headers = { "Content-Type": TYPES[extname(rel)] || "application/octet-stream" };
    if (rel === "admin.html") Object.assign(headers, { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" });
    res.writeHead(200, headers); res.end(file);
  } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Página no encontrada"); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname === "/api/guardar") return req.method === "POST" ? await guardar(req, res) : send(res, 405, { error: "Método no permitido" });
    if (url.pathname === "/api/personajes") return await admin(req, res, url);
    if (req.method !== "GET") return send(res, 405, { error: "Método no permitido" });
    return await serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "Error del servidor" });
  }
}).listen(PORT, () => console.log(`Arma tu personaje escuchando en ${PORT}`));
