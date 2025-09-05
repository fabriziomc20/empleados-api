// server.js

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");

const app = express();

// --- Helpers para códigos automáticos (pegar una sola vez, después de crear `pool`) ---
function slugify(str){
  return String(str || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // quita tildes
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")   // espacios y símbolos -> guiones
    .replace(/^-+|-+$/g, "")       // sin guiones al borde
    .slice(0, 32);                 // limita longitud
}

async function generateUniqueCode(table, baseCode){
  let code = baseCode || "ITEM";
  let n = 1;
  for(;;){
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE code=$1 LIMIT 1`, [code]);
    if (!rows.length) return code;
    n += 1;
    code = `${baseCode}-${n}`;
  }
}

/* =========================
   CORS (tu frontend)
   ========================= */
app.use(cors({
  origin: ["https://fabriziomc20.github.io"],
}));
app.options("*", cors());
app.use(express.json());

// ===== Normalización de entrada =====

// 1) Helpers
function stripDiacritics(s = "") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function toTitleCase(s = "") {
  return s
    .toLowerCase()
    .replace(/\b[\p{L}\p{N}]+/gu, w => w.charAt(0).toUpperCase() + w.slice(1));
}
function normalizeBodyValue(str) {
  const t = stripDiacritics(String(str).trim());
  return toTitleCase(t); // "juan pérez" -> "Juan Perez"
}
function normalizeQueryValue(str) {
  // Para búsquedas: trim + sin tildes + en minúsculas
  return stripDiacritics(String(str).trim()).toLowerCase();
}

// 2) Middleware
app.use((req, _res, next) => {
  // BODY -> Title Case
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    for (const k of Object.keys(req.body)) {
      if (typeof req.body[k] === "string") {
        req.body[k] = normalizeBodyValue(req.body[k]);
      }
    }
  }
  // QUERY -> búsqueda (lowercase)
  if (req.query && typeof req.query === "object") {
    for (const k of Object.keys(req.query)) {
      if (typeof req.query[k] === "string") {
        req.query[k] = normalizeQueryValue(req.query[k]);
      }
    }
  }
  // params NO se tocan
  next();
});


/* =========================
   Multer en memoria (15MB)
   ========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});
const campos = upload.fields([
  { name: "dni",           maxCount: 2  },
  { name: "certificados",  maxCount: 10 },
  { name: "antecedentes",  maxCount: 5  },
  { name: "medicos",       maxCount: 5  },
  { name: "capacitacion",  maxCount: 10 },
  { name: "cv",            maxCount: 5  }
]);

/* =========================
   Cloudinary (ENV required)
   ========================= */
import { v2 as cloudinary } from "cloudinary";

// Con CLOUDINARY_URL ya definida, no hace falta config manual
// cloudinary.config() la detecta automáticamente.
cloudinary.config();

app.post("/upload", async (req, res) => {
  try {
    const result = await cloudinary.uploader.upload("https://picsum.photos/600");
    res.json({ url: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   PostgreSQL
   ========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   Health-check
   ========================= */
app.get("/", (_req, res) => res.status(200).send("API Funcionando 🚀"));

/* ============================================================
   GET /api/candidatos  (filtros: ano/mes/estado, rango grupos)
   ============================================================ */
app.get("/api/candidatos", async (req, res) => {
  try {
    const {
      ano = "TODOS",
      mes = "TODOS",
      estado = null,
      grupoInicio = null,
      grupoFin = null
    } = req.query;

    const where = [];
    const params = [];
    let i = 1;

    if (ano !== "TODOS") { where.push(`EXTRACT(YEAR  FROM fecha) = $${i++}`); params.push(Number(ano)); }
    if (mes !== "TODOS") { where.push(`EXTRACT(MONTH FROM fecha) = $${i++}`); params.push(Number(mes)); }
    if (estado)         { where.push(`estado = $${i++}`); params.push(estado); }
    if (grupoInicio && grupoFin) {
      where.push(`(grupo ~ '^[0-9]+$' AND CAST(grupo AS INT) BETWEEN $${i++} AND $${i++})`);
      params.push(Number(grupoInicio), Number(grupoFin));
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT
        id, dni, apellido_paterno, apellido_materno, nombres, nombre_completo,
        sede, turno_horario, grupo, estado, fecha,
        dni_doc_url        AS dni,
        certificados_url   AS certificados,
        antecedentes_url   AS antecedentes,
        medicos_url        AS medicos,
        capacitacion_url   AS capacitacion,
        cv_url             AS cv
      FROM vw_api_candidatos
      ${whereSQL}
      ORDER BY fecha DESC, id DESC
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("GET /api/candidatos", e);
    res.status(500).json({ error: "Error consultando candidatos" });
  }
});

/* =================================
   GET /api/candidatos/:id (detalle)
   ================================= */
app.get("/api/candidatos/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cab = await pool.query(
      `SELECT
         id, dni, apellido_paterno, apellido_materno, nombres, nombre_completo,
         sede, turno_horario, grupo, estado, fecha,
         dni_doc_url AS dni, certificados_url AS certificados,
         antecedentes_url AS antecedentes, medicos_url AS medicos,
         capacitacion_url AS capacitacion, cv_url AS cv
       FROM vw_api_candidatos
       WHERE id=$1`,
      [id]
    );
    if (cab.rowCount === 0) return res.status(404).json({ error: "No encontrado" });

    const docs = await pool.query(
      `SELECT tipo, url, created_at
         FROM candidato_documentos
        WHERE candidato_id=$1
        ORDER BY created_at DESC`,
      [id]
    );

    res.json({ ...cab.rows[0], documentos: docs.rows });
  } catch (e) {
    console.error("GET /api/candidatos/:id", e);
    res.status(500).json({ error: "Error consultando candidato" });
  }
});

/* ============================================
   POST /api/candidatos  (crea + sube documentos)
   ============================================ */
app.post("/api/candidatos", campos, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      dni,
      apellido_paterno,
      apellido_materno,
      nombres,
      sede = null,
      turno_horario = null,
      grupo = null
    } = req.body;

    if (!dni || !apellido_paterno || !apellido_materno || !nombres) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO candidatos (dni, apellido_paterno, apellido_materno, nombres, sede, turno_horario, grupo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, dni`,
      [dni, apellido_paterno, apellido_materno, nombres, sede, turno_horario, grupo]
    );
    const { id: candidatoId, dni: candDni } = ins.rows[0];

    // Subir archivos si llegaron
    const tipos = ["dni","certificados","antecedentes","medicos","capacitacion","cv"];
    const inserts = [];

    for (const tipo of tipos) {
      const files = req.files?.[tipo] || [];
      for (const f of files) {
        const folder = `candidatos/${candDni}/${tipo}`;
        const url = await uploadToCloudinary(f.buffer, folder, f.originalname);
        inserts.push({ tipo, url });
      }
    }

    if (inserts.length) {
      const values = inserts.map((_, i) => `($1, $${i*2+2}, $${i*2+3})`).join(", ");
      const params = [candidatoId, ...inserts.flatMap(x => [x.tipo, x.url])];
      await client.query(
        `INSERT INTO candidato_documentos (candidato_id, tipo, url) VALUES ${values}`,
        params
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, id: candidatoId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/candidatos", e);
    if (e.code === "23505") return res.status(409).json({ error: "DNI ya registrado" });
    res.status(500).json({ error: "Error creando candidato" });
  } finally {
    client.release();
  }
});

/* ============================================
   PUT /api/candidatos/:id  (actualiza básicos)
   ============================================ */
app.put("/api/candidatos/:id", campos, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { apellido_paterno, apellido_materno, nombres, sede, turno_horario, grupo, estado } = req.body;

    const r = await pool.query(
      `UPDATE candidatos
          SET apellido_paterno = COALESCE($1, apellido_paterno),
              apellido_materno = COALESCE($2, apellido_materno),
              nombres         = COALESCE($3, nombres),
              sede            = COALESCE($4, sede),
              turno_horario   = COALESCE($5, turno_horario),
              grupo           = COALESCE($6, grupo),
              estado          = COALESCE($7, estado)
        WHERE id=$8`,
      [apellido_paterno || null, apellido_materno || null, nombres || null,
       sede || null, turno_horario || null, grupo || null, estado || null, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "No encontrado" });

    // (Opcional) Si envías archivos en edición, puedes subirlos igual que en POST y guardarlos:
    // ... similar a inserts en POST, apuntando a candidato_documentos

    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/candidatos/:id", e);
    res.status(500).json({ error: "Error actualizando candidato" });
  }
});

/* ============================================
   PUT /api/candidatos/:id/estado  (cambiar estado)
   ============================================ */
app.put("/api/candidatos/:id/estado", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado } = req.body; // EN_REVISION | CANCELADO | APROBADO
    if (!["EN_REVISION","CANCELADO","APROBADO"].includes(estado)) {
      return res.status(400).json({ error: "Estado inválido" });
    }
    const r = await pool.query(`UPDATE candidatos SET estado=$1 WHERE id=$2`, [estado, id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "No encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/candidatos/:id/estado", e);
    res.status(500).json({ error: "Error cambiando estado" });
  }
});
// ====== Helpers ======
async function getEmployerIdOrNull() {
  const r = await pool.query(`SELECT id FROM employers ORDER BY id ASC LIMIT 1`);
  return r.rows[0]?.id || null;
}

// ====== Régimen Tributario: catálogos ======
app.get("/api/regimes/tax", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, code, name FROM regimes_tax ORDER BY id ASC`);
    res.json(rows);
  } catch (e) {
    console.error("GET /api/regimes/tax", e);
    res.status(500).send("error");
  }
});

// ====== Régimen Tributario por EMPRESA (histórico) ======
// Actual vigente
app.get("/api/employer/tax", async (_req, res) => {
  try {
    const empId = await getEmployerIdOrNull();
    if (!empId) return res.status(400).json({ error: "Primero registra la Empresa" });

    const q = await pool.query(
      `SELECT eth.id, eth.valid_from, eth.valid_to, rt.code, rt.name
         FROM employer_tax_history eth
         JOIN regimes_tax rt ON rt.id = eth.regime_id
        WHERE eth.employer_id = $1
        ORDER BY eth.valid_from DESC
        LIMIT 1`,
      [empId]
    );
    res.json(q.rows[0] || null);
  } catch (e) {
    console.error("GET /api/employer/tax", e);
    res.status(500).send("error");
  }
});

// Histórico completo
app.get("/api/employer/tax/history", async (_req, res) => {
  try {
    const empId = await getEmployerIdOrNull();
    if (!empId) return res.status(400).json({ error: "Primero registra la Empresa" });

    const { rows } = await pool.query(
      `SELECT eth.id, eth.valid_from, eth.valid_to, rt.code, rt.name
         FROM employer_tax_history eth
         JOIN regimes_tax rt ON rt.id = eth.regime_id
        WHERE eth.employer_id = $1
        ORDER BY eth.valid_from DESC`,
      [empId]
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /api/employer/tax/history", e);
    res.status(500).send("error");
  }
});

// Establecer nuevo régimen (versionado)
// body: { regime_code: 'MICRO'|'ESPECIAL'|'PEQUENA'|'GENERAL', valid_from?: 'YYYY-MM-DD' }
app.post("/api/employer/tax", async (req, res) => {
  const client = await pool.connect();
  try {
    const empId = await getEmployerIdOrNull();
    if (!empId) return res.status(400).json({ error: "Primero registra la Empresa" });

    const { regime_code, valid_from } = req.body || {};
    if (!regime_code) return res.status(400).json({ error: "regime_code es obligatorio" });

    const r = await client.query(`SELECT id FROM regimes_tax WHERE code = $1`, [regime_code]);
    if (r.rowCount === 0) return res.status(400).json({ error: "regime_code inválido" });
    const regimeId = r.rows[0].id;

    const vf = valid_from || new Date().toISOString().slice(0,10); // hoy por defecto

    await client.query("BEGIN");

    // Cerrar el anterior (si existe)
    const prev = await client.query(
      `SELECT id, valid_from FROM employer_tax_history
        WHERE employer_id = $1 AND valid_to IS NULL
        ORDER BY valid_from DESC LIMIT 1`,
      [empId]
    );
    if (prev.rowCount) {
      await client.query(
        `UPDATE employer_tax_history
            SET valid_to = (DATE $2 - INTERVAL '1 day')::date
          WHERE id = $1 AND valid_to IS NULL`,
        [prev.rows[0].id, vf]
      );
    }

    // Insertar el nuevo vigente
    const ins = await client.query(
      `INSERT INTO employer_tax_history (employer_id, regime_id, valid_from, valid_to)
       VALUES ($1,$2,$3,NULL)
       RETURNING id`,
      [empId, regimeId, vf]
    );

    await client.query("COMMIT");

    // responder estado actual
    const cur = await pool.query(
      `SELECT eth.id, eth.valid_from, eth.valid_to, rt.code, rt.name
         FROM employer_tax_history eth
         JOIN regimes_tax rt ON rt.id = eth.regime_id
        WHERE eth.id = $1`,
      [ins.rows[0].id]
    );
    res.json(cur.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /api/employer/tax", e);
    res.status(500).json({ error: "Error estableciendo régimen tributario" });
  } finally {
    client.release();
  }
});

// ===== EMPRESA =====
app.get("/api/employer", async (_req, res) => {
  try {
    const q = await pool.query(`SELECT id, ruc, name, logo_url FROM employers ORDER BY id ASC LIMIT 1`);
    res.json(q.rows[0] || null);
  } catch (e) {
    console.error("GET /api/employer", e);
    res.status(500).send("error");
  }
});

app.post("/api/employer", async (req, res) => {
  try {
    const { ruc, name, logo_url } = req.body || {};
    if (!ruc || !name) return res.status(400).send("RUC y nombre son obligatorios");
    const up = await pool.query(
      `INSERT INTO employers (ruc, name, logo_url)
       VALUES ($1,$2,$3)
       ON CONFLICT (ruc) DO UPDATE SET name=EXCLUDED.name, logo_url=EXCLUDED.logo_url
       RETURNING id, ruc, name, logo_url`,
      [String(ruc).trim(), String(name).trim(), logo_url || null]
    );
    res.json(up.rows[0]);
  } catch (e) {
    console.error("POST /api/employer", e);
    res.status(500).send("error");
  }
});

// ===== SITES (Sedes) =====
app.get("/api/sites", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, code, name FROM sites ORDER BY id ASC`);
    res.json(rows);
  } catch (e) {
    console.error("GET /api/sites", e);
    res.status(500).send("error");
  }
});

app.post("/api/sites", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).send("name es obligatorio");

    const base = slugify(name);
    const code = await generateUniqueCode("sites", base || "SITE");

    const r = await pool.query(
      `INSERT INTO sites (code, name)
       VALUES ($1,$2)
       RETURNING id, code, name`,
      [code, String(name).trim()]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error("POST /api/sites", e);
    res.status(500).send("error");
  }
});

app.put("/api/sites/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name=null } = req.body || {};
    const r = await pool.query(
      `UPDATE sites
          SET name = COALESCE($1, name)
        WHERE id=$2`,
      [name, id]
    );
    if (r.rowCount === 0) return res.status(404).send("no encontrado");
    res.json({ ok:true });
  } catch (e) {
    console.error("PUT /api/sites/:id", e);
    res.status(500).send("error");
  }
});

app.delete("/api/sites/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`DELETE FROM sites WHERE id=$1`, [id]);
    res.json({ ok:true });
  } catch (e) {
    if (e.code === "23503") return res.status(409).send("No se puede eliminar: tiene proyectos asociados");
    console.error("DELETE /api/sites/:id", e);
    res.status(500).send("error");
  }
});


// ===== PROJECTS =====
app.get("/api/projects", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.code, p.name, p.site_id,
              s.code AS site_code, s.name AS site_name
         FROM projects p
         LEFT JOIN sites s ON s.id = p.site_id
        ORDER BY p.id ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /api/projects", e);
    res.status(500).send("error");
  }
});

app.post("/api/projects", async (req, res) => {
  try {
    const { name, site_id } = req.body || {};
    if (!name || !site_id) return res.status(400).send("name y site_id son obligatorios");

    const base = slugify(name);
    const code = await generateUniqueCode("projects", base || "PROJ");

    const r = await pool.query(
      `INSERT INTO projects (code, name, site_id)
       VALUES ($1,$2,$3)
       RETURNING id, code, name, site_id`,
      [code, String(name).trim(), Number(site_id)]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error("POST /api/projects", e);
    res.status(500).send("error");
  }
});

app.put("/api/projects/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name=null, site_id=null } = req.body || {};
    const r = await pool.query(
      `UPDATE projects
          SET name   = COALESCE($1, name),
              site_id= COALESCE($2, site_id)
        WHERE id=$3`,
      [name, site_id, id]
    );
    if (r.rowCount === 0) return res.status(404).send("no encontrado");
    res.json({ ok:true });
  } catch (e) {
    console.error("PUT /api/projects/:id", e);
    res.status(500).send("error");
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`DELETE FROM projects WHERE id=$1`, [id]);
    res.json({ ok:true });
  } catch (e) {
    if (e.code === "23503") return res.status(409).send("No se puede eliminar: tiene asignaciones o dependencias");
    console.error("DELETE /api/projects/:id", e);
    res.status(500).send("error");
  }
});


// ===== SHIFTS (Turnos) =====
app.get("/api/shifts", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name,
              to_char(start_time,'HH24:MI') AS start_time,
              to_char(end_time,  'HH24:MI') AS end_time
         FROM shifts
        ORDER BY id ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /api/shifts", e);
    res.status(500).send("error");
  }
});

app.post("/api/shifts", async (req, res) => {
  try {
    const { name, start_time, end_time } = req.body || {};
    if (!name || !start_time || !end_time)
      return res.status(400).send("name, start_time y end_time son obligatorios");
    const r = await pool.query(
      `INSERT INTO shifts (name, start_time, end_time)
       VALUES ($1,$2,$3)
       RETURNING id, name,
                 to_char(start_time,'HH24:MI') AS start_time,
                 to_char(end_time,  'HH24:MI') AS end_time`,
      [String(name).trim(), start_time, end_time]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error("POST /api/shifts", e);
    res.status(500).send("error");
  }
});

app.put("/api/shifts/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name=null, start_time=null, end_time=null } = req.body || {};
    const r = await pool.query(
      `UPDATE shifts
          SET name = COALESCE($1, name),
              start_time = COALESCE($2, start_time),
              end_time   = COALESCE($3, end_time)
        WHERE id=$4`,
      [name, start_time, end_time, id]
    );
    if (r.rowCount === 0) return res.status(404).send("no encontrado");
    res.json({ ok:true });
  } catch (e) {
    console.error("PUT /api/shifts/:id", e);
    res.status(500).send("error");
  }
});

app.delete("/api/shifts/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`DELETE FROM shifts WHERE id=$1`, [id]);
    res.json({ ok:true });
  } catch (e) {
    if (e.code === "23503") return res.status(409).send("No se puede eliminar: está referenciado");
    console.error("DELETE /api/shifts/:id", e);
    res.status(500).send("error");
  }
});




/* =========================
   Start
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

