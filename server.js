// server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// CORS: solo tu frontend (agrega localhost si lo usas)
app.use(cors({
  origin: ["https://fabriziomc20.github.io"],
}));
app.options("*", cors());

// JSON
app.use(express.json());

// Multer (recibe archivos en memoria; límite 10MB por archivo)
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
const campos = upload.fields([
  { name: "dni",           maxCount: 2  },
  { name: "certificados",  maxCount: 10 },
  { name: "antecedentes",  maxCount: 5  },
  { name: "medicos",       maxCount: 5  },
  { name: "capacitacion",  maxCount: 10 }
]);

// Postgres Pool (Render suele requerir SSL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Health-check
app.get("/", (_req, res) => res.status(200).send("API Funcionando 🚀"));

/**
 * GET /api/empleados
 * Filtros:
 *   ?ano=2024|TODOS  &  ?mes=1..12|TODOS
 *   ó  ?grupoInicio=51&grupoFin=53   (rango)  ó  ?grupo=TODOS
 */
app.get("/api/empleados", async (req, res) => {
  try {
    const { ano, mes, grupo, grupoInicio, grupoFin } = req.query;

    const where = [];
    const params = [];
    let i = 1;

    // Año/Mes (ambos presentes desde el frontend)
    if (ano && mes) {
      if (ano !== "TODOS") {
        where.push(`EXTRACT(YEAR FROM fecha) = $${i++}`);
        params.push(Number(ano));
      }
      if (mes !== "TODOS") {
        where.push(`EXTRACT(MONTH FROM fecha) = $${i++}`);
        params.push(Number(mes));
      }
    }

    // Grupo por rango
    if (grupo && grupo === "TODOS") {
      // sin filtro
    } else if (grupoInicio && grupoFin) {
      where.push(`CAST(grupo AS INT) BETWEEN $${i++} AND $${i++}`);
      params.push(Number(grupoInicio), Number(grupoFin));
    }

    const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // 1) empleados
    const empRes = await pool.query(
      `SELECT id, nombre, sede, grupo, fecha
         FROM empleados
         ${whereSQL}
         ORDER BY fecha DESC, id DESC`,
      params
    );
    const empleados = empRes.rows;
    if (empleados.length === 0) return res.json([]);

    // 2) documentos de esos empleados
    const ids = empleados.map(e => e.id);
    const docsRes = await pool.query(
      `SELECT empleado_id, tipo, url
         FROM documentos
        WHERE empleado_id = ANY($1::int[])`,
      [ids]
    );

    // 3) indexado por empleado_id y tipo (si hay varios certificados/capacitacion, tomamos el primero)
    const docsMap = {};
    for (const d of docsRes.rows) {
      if (!docsMap[d.empleado_id]) docsMap[d.empleado_id] = {};
      if (d.tipo === "certificados" || d.tipo === "capacitacion") {
        if (!docsMap[d.empleado_id][d.tipo]) docsMap[d.empleado_id][d.tipo] = d.url;
      } else {
        docsMap[d.empleado_id][d.tipo] = d.url;
      }
    }

    // 4) mezclar y responder
    const result = empleados.map(e => ({
      id: e.id,
      nombre: e.nombre,
      sede: e.sede,
      grupo: e.grupo,
      fecha: e.fecha?.toISOString?.().slice(0,10) || e.fecha, // YYYY-MM-DD
      dni:           docsMap[e.id]?.dni || null,
      certificados:  docsMap[e.id]?.certificados || null,
      antecedentes:  docsMap[e.id]?.antecedentes || null,
      medicos:       docsMap[e.id]?.medicos || null,
      capacitacion:  docsMap[e.id]?.capacitacion || null
    }));

    res.json(result);
  } catch (err) {
    console.error("GET /api/empleados error:", err);
    res.status(500).json({ error: "Error consultando empleados" });
  }
});

/**
 * GET /api/empleados/:id
 */
app.get("/api/empleados/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const empRes = await pool.query(
      "SELECT id, nombre, sede, grupo, fecha FROM empleados WHERE id = $1",
      [id]
    );
    if (empRes.rowCount === 0) return res.status(404).json({ error: "No encontrado" });

    const e = empRes.rows[0];

    const docsRes = await pool.query(
      "SELECT tipo, url FROM documentos WHERE empleado_id = $1",
      [id]
    );

    const docs = {};
    for (const d of docsRes.rows) {
      // si hay múltiples certificados/capacitacion podrías armar arrays; por ahora 1ro
      if (d.tipo === "certificados" || d.tipo === "capacitacion") {
        if (!docs[d.tipo]) docs[d.tipo] = d.url;
      } else {
        docs[d.tipo] = d.url;
      }
    }

    res.json({
      id: e.id,
      nombre: e.nombre,
      sede: e.sede,
      grupo: e.grupo,
      fecha: e.fecha?.toISOString?.().slice(0,10) || e.fecha,
      ...docs
    });
  } catch (err) {
    console.error("GET /api/empleados/:id error:", err);
    res.status(500).json({ error: "Error consultando empleado" });
  }
});

/**
 * POST /api/empleados
 * Crea el empleado. (Archivos recibidos pero aún NO se suben a storage; próximo paso)
 */
app.post("/api/empleados", campos, async (req, res) => {
  try {
    const { nombre, sede, grupo } = req.body;
    if (!nombre || !sede || !grupo) {
      return res.status(400).json({ error: "Faltan campos" });
    }

    // 1) insertar empleado
    const ins = await pool.query(
      `INSERT INTO empleados (nombre, sede, grupo)
       VALUES ($1,$2,$3)
       RETURNING id`,
      [nombre, sede, grupo]
    );
    const nuevoId = ins.rows[0].id;

    // 2) (Opcional) en el siguiente paso: subir archivos a storage y guardar URLs en "documentos"
    //    Aquí solo mostramos cómo leer qué llegó:
    //    req.files.dni, req.files.certificados, etc.

    res.json({ ok: true, id: nuevoId });
  } catch (err) {
    console.error("POST /api/empleados error:", err);
    res.status(500).json({ error: "Error creando empleado" });
  }
});

/**
 * PUT /api/empleados/:id
 * Actualiza nombre/sede/grupo. (Archivos ignorados por ahora)
 */
app.put("/api/empleados/:id", campos, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nombre, sede, grupo } = req.body;

    const exists = await pool.query("SELECT id FROM empleados WHERE id = $1", [id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: "No encontrado" });

    await pool.query(
      `UPDATE empleados
          SET nombre = COALESCE($1, nombre),
              sede   = COALESCE($2, sede),
              grupo  = COALESCE($3, grupo)
        WHERE id = $4`,
      [nombre || null, sede || null, grupo || null, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/empleados/:id error:", err);
    res.status(500).json({ error: "Error actualizando empleado" });
  }
});

// Arrancar
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
