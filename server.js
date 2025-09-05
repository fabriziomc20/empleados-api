// server.js

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");

const app = express();

/* =========================
   CORS (tu frontend)
   ========================= */
app.use(cors({
  origin: ["https://fabriziomc20.github.io"],
}));
app.options("*", cors());
app.use(express.json());

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
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

function uploadToCloudinary(fileBuffer, folder, filename) {
  return new Promise((resolve, reject) => {
    const up = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "auto",
        public_id: filename?.replace(/\.[^.]+$/, "")?.slice(0, 120)
      },
      (err, result) => err ? reject(err) : resolve(result.secure_url)
    );
    streamifier.createReadStream(fileBuffer).pipe(up);
  });
}

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


/* =========================
   Start
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

