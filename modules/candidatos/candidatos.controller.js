module.exports = ({ pool, uploadToCloudinary }) => {
  return {
    list: async (req, res) => {
      try {
        const {
          ano = "TODOS",
          mes = "TODOS",
          estado = null,
          grupoInicio = null,
          grupoFin = null,
        } = req.query;

        const where = [];
        const params = [];
        let i = 1;

        if (ano !== "TODOS") { where.push(`EXTRACT(YEAR  FROM fecha) = $${i++}`); params.push(Number(ano)); }
        if (mes !== "TODOS") { where.push(`EXTRACT(MONTH FROM fecha) = $${i++}`); params.push(Number(mes)); }
        if (estado)         { where.push(`LOWER(estado) = LOWER($${i++})`);       params.push(estado); }
        if (grupoInicio && grupoFin) {
          where.push(`(grupo ~ '^[0-9]+$' AND CAST(grupo AS INT) BETWEEN $${i++} AND $${i++})`);
          params.push(Number(grupoInicio), Number(grupoFin));
        }

        const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const sql = `
          SELECT
            id,
            dni                         AS dni_numero,
            apellido_paterno,
            apellido_materno,
            nombres,
            nombre_completo,
            sede,
            turno_horario,
            grupo,
            estado,
            fecha,
            dni_doc_url                 AS dni_doc,
            certificados_url            AS certificados,
            antecedentes_url            AS antecedentes,
            medicos_url                 AS medicos,
            capacitacion_url            AS capacitacion,
            cv_url                      AS cv_doc
            COALESCE(dc.doc_count, 0) AS doc_count
          FROM vw_api_candidatos
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS doc_count
            FROM candidato_documentos d
            WHERE d.candidato_id = v.id
          ) dc ON TRUE
          ${whereSQL}
          ORDER BY fecha DESC, id DESC
        `;
        const { rows } = await pool.query(sql, params);
        res.json(rows);
      } catch (e) {
        console.error("GET /api/candidatos", e);
        res.status(500).json({ error: "Error consultando candidatos" });
      }
    },

    getById: async (req, res) => {
      try {
        const id = Number(req.params.id);
        const cab = await pool.query(
          `SELECT
             id,
             dni                         AS dni_numero,
             apellido_paterno,
             apellido_materno,
             nombres,
             nombre_completo,
             sede,
             turno_horario,
             grupo,
             estado,
             fecha,
             dni_doc_url                 AS dni_doc,
             certificados_url            AS certificados,
             antecedentes_url            AS antecedentes,
             medicos_url                 AS medicos,
             capacitacion_url            AS capacitacion,
             cv_url                      AS cv_doc
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
    },

    create: async (req, res) => {
      const client = await pool.connect();
      try {
        const {
          dni,
          apellido_paterno,
          apellido_materno,
          nombres,
          sede = null,
          turno_horario = null,
          grupo = null,
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

        const tipos = ["dni", "certificados", "antecedentes", "medicos", "capacitacion", "cv"];
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
          const values = inserts.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(", ");
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
    },

    update: async (req, res) => {
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

        res.json({ ok: true });
      } catch (e) {
        console.error("PUT /api/candidatos/:id", e);
        res.status(500).json({ error: "Error actualizando candidato" });
      }
    },

    updateEstado: async (req, res) => {
      try {
        const id = Number(req.params.id);
        const { estado } = req.body;
        if (!["En Revision", "Cancelado", "Aprobado"].includes(estado)) {
          return res.status(400).json({ error: "Estado inválido" });
        }
        const r = await pool.query(`UPDATE candidatos SET estado=$1 WHERE id=$2`, [estado, id]);
        if (r.rowCount === 0) return res.status(404).json({ error: "No encontrado" });
        res.json({ ok: true });
      } catch (e) {
        console.error("PUT /api/candidatos/:id/estado", e);
        res.status(500).json({ error: "Error cambiando estado" });
      }
    },
  };
};


