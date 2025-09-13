const express = require('express');
const controllerFactory = require('./candidatos.controller');

module.exports = function candidatosRoutes({ pool, uploadToCloudinary, campos }) {
  const router = express.Router();
  const ctrl = controllerFactory({ pool, uploadToCloudinary });

  router.get('/candidatos', ctrl.list);
  router.get('/candidatos/:id', ctrl.getById);
  router.post('/candidatos', campos, ctrl.create);
  router.put('/candidatos/:id', campos, ctrl.update);
  router.put('/candidatos/:id/estado', ctrl.updateEstado);

  return router;
};

