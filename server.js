const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
app.use(cors());                // Permite que tu frontend (GitHub Pages) llame a esta API
app.use(express.json());        // Para JSON en requests

// Multer para recibir archivos (en memoria, para demo)
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB por archivo

// Datos de ejemplo (para que consulta.html funcione ya mismo)
let empleados = [
  {
    id: 1,
    nombre: "JUAN PEREZ LOPEZ",
    sede: "Lima / Mañana",
    grupo: "51",
    fecha: "2024-08-01",
    dni: "https://example.com/uploads/1/dni.pdf",
    certificados: null,
    antecedentes: "https://example.com/uploads/1/antecedentes.pdf",
    medicos: null,
    capacitacion: "https://example.com/uploads/1/capacitacion.pdf"
  },
  {
    id: 2,
    nombre: "MARIA GARCIA FLORES",
    sede: "Arequipa / Tarde",
    grupo: "51",
    fecha: "2024-08-05",
    dni: "https://example.com/uploads/2/dni.pdf",
    certificados: "https://example.com/uploads/2/certificados.pdf",
    antecedentes: null,
    medicos: null,
    capacitacion: null
  },
  {
    id: 3,
    nombre: "CARLOS RAMOS DIAZ",
    sede: "Cusco / Noche",
    grupo: "52",
    fecha: "2024-09-12",
    dni: null,
    certificados: null,
    antecedentes: null,
    medicos: "https://example.com/uploads/3/medicos.pdf",
    capacitacion: null
  }
];

// GET /api/empleados con filtros ?ano & ?mes  o  ?grupoInicio & ?grupoFin (o ?grupo=TODOS)
app.get("/api/empleados", (req, res) => {
  let result = [...empleados];

  const { ano, mes, grupo, grupoInicio, grupoFin } = req.query;

  // Filtro por fecha (año/mes) — admite "TODOS"
  if (ano && mes) {
    result = result.filter(e => {
      const y = (e.fecha || "").slice(0, 4);
      const m = (e.fecha || "").slice(5, 7); // "01".."12"
      const matchAno = (ano === "TODOS") || (y === String(ano));
      const matchMes = (mes === "TODOS") || (Number(m) === Number(mes));
      // Regla: si mes específico, año NO puede ser "TODOS" (frontend ya valida)
      return matchAno && matchMes;
    });
  }

  // Filtro por grupo como rango
  if (grupo && grupo === "TODOS") {
    // no filtra nada
  } else if (grupoInicio && grupoFin) {
    const ini = Number(grupoInicio);
    const fin = Number(grupoFin);
    result = result.filter(e => {
      const g = Number(e.grupo);
      return g >= ini && g <= fin;
    });
  }

  res.json(result);
});

// GET /api/empleados/:id — detalle
app.get("/api/empleados/:id", (req, res) => {
  const id = Number(req.params.id);
  const emp = empleados.find(e => e.id === id);
  if (!emp) return res.status(404).json({ error: "No encontrado" });
  res.json(emp);
});

// POST /api/empleados — crear (solo demo: agrega a la lista en memoria)
const campos = upload.fields([
  { name: "dni", maxCount: 2 },
  { name: "certificados", maxCount: 10 },
  { name: "antecedentes", maxCount: 5 },
  { name: "medicos", maxCount: 5 },
  { name: "capacitacion", maxCount: 10 }
]);

app.post("/api/empleados", campos, (req, res) => {
  const { nombre, sede, grupo } = req.body;
  if (!nombre || !sede || !grupo) {
    return res.status(400).json({ error: "Faltan campos" });
  }

  const nuevo = {
    id: (empleados.at(-1)?.id || 0) + 1,
    nombre,
    sede,
    grupo,
    fecha: new Date().toISOString().slice(0, 10),
    // En una app real, aquí subirías los archivos a un storage (S3/Cloudinary/OneDrive) y guardarías sus URLs
    dni: null, certificados: null, antecedentes: null, medicos: null, capacitacion: null
  };

  empleados.push(nuevo);
  res.json({ ok: true, id: nuevo.id });
});

// PUT /api/empleados/:id — actualizar (demo: solo texto; archivos ignorados)
app.put("/api/empleados/:id", campos, (req, res) => {
  const id = Number(req.params.id);
  const idx = empleados.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: "No encontrado" });

  const { nombre, sede, grupo } = req.body;
  if (nombre) empleados[idx].nombre = nombre;
  if (sede)   empleados[idx].sede   = sede;
  if (grupo)  empleados[idx].grupo  = grupo;

  res.json({ ok: true });
});

// Ping
app.get("/", (_req, res) => res.send("API Funcionando 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
