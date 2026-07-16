const express = require('express');

const ROLES_ADMIN = ['presidente', 'vicepresidente', 'secretario', 'tesorero', 'difusion'];
const TODOS_ADMIN = [...ROLES_ADMIN];
const ROLES_ASIGNABLES = ['estudiante', ...ROLES_ADMIN];
const ROLES_ASIGNABLES_VICEPRESIDENTE = ['estudiante', 'secretario', 'tesorero', 'difusion'];

const RECURSOS = {
  proyectos: {
    rolesLectura: ['presidente', 'vicepresidente'],
    rolesEscritura: ['vicepresidente'],
    campos: ['nombre', 'responsable', 'estado', 'avance', 'inicio', 'fin', 'descripcion'],
    requeridos: ['nombre'],
  },
  tareas: {
    rolesLectura: ['presidente', 'vicepresidente'],
    rolesEscritura: ['vicepresidente'],
    campos: ['descripcion', 'responsable', 'prioridad', 'estado', 'fechaLimite', 'proyectoId'],
    requeridos: ['descripcion'],
  },
  propuestas: {
    rolesLectura: ['presidente', 'vicepresidente'],
    rolesEscritura: ['vicepresidente'],
    campos: ['propuesta', 'solicitante', 'estado', 'opinion', 'fecha'],
    requeridos: ['propuesta'],
  },
  reuniones: {
    rolesLectura: ['presidente', 'secretario'],
    rolesEscritura: ['secretario'],
    campos: ['fecha', 'hora', 'tipo', 'lugar', 'asistentes', 'acuerdos', 'acta', 'estado'],
    requeridos: ['fecha', 'tipo'],
  },
  actas: {
    rolesLectura: ['presidente', 'secretario'],
    rolesEscritura: ['secretario'],
    campos: ['reunionId', 'titulo', 'contenido', 'estado', 'fecha', 'firmantes', 'archivoKey'],
    requeridos: ['titulo'],
  },
  comunicados: {
    rolesLectura: ['presidente', 'secretario'],
    rolesEscritura: ['secretario'],
    campos: ['titulo', 'tipo', 'destinatarios', 'fecha', 'estado', 'contenido'],
    requeridos: ['titulo'],
  },
  convocatorias: {
    rolesLectura: ['presidente', 'secretario'],
    rolesEscritura: ['secretario'],
    campos: ['titulo', 'tipo', 'fecha', 'hora', 'lugar', 'destinatarios', 'estado'],
    requeridos: ['titulo', 'fecha'],
  },
  documentos: {
    rolesLectura: ['presidente', 'secretario'],
    rolesEscritura: ['secretario'],
    campos: ['titulo', 'tipo', 'mes', 'responsable', 'archivoKey', 'estado'],
    requeridos: ['titulo'],
  },
  asistencias: {
    rolesLectura: ['presidente', 'secretario'],
    rolesEscritura: ['secretario'],
    campos: ['reunionId', 'miembroId', 'nombre', 'estado', 'observaciones'],
    requeridos: ['reunionId', 'miembroId'],
  },
  transacciones: {
    rolesLectura: ['presidente', 'tesorero'],
    rolesEscritura: ['tesorero'],
    campos: ['fecha', 'concepto', 'tipo', 'monto', 'categoria', 'responsable', 'solicitudGastoId'],
    requeridos: ['concepto', 'tipo', 'monto'],
  },
  presupuestos: {
    rolesLectura: ['presidente', 'tesorero'],
    rolesEscritura: ['tesorero'],
    campos: ['area', 'asignado', 'gastado', 'periodo', 'estado'],
    requeridos: ['area', 'asignado'],
  },
  recaudacion: {
    rolesLectura: ['presidente', 'tesorero'],
    rolesEscritura: ['tesorero'],
    campos: ['nombre', 'eventoId', 'meta', 'recaudado', 'fecha', 'estado'],
    requeridos: ['nombre', 'meta'],
  },
  'solicitudes-gasto': {
    coleccion: 'solicitudes_gasto',
    rolesLectura: ['presidente', 'tesorero'],
    rolesEscritura: ['tesorero'],
    campos: ['solicitante', 'solicitanteRol', 'concepto', 'monto', 'categoria', 'estado', 'fecha', 'comentario'],
    requeridos: ['solicitante', 'concepto', 'monto'],
  },
  publicaciones: {
    rolesLectura: ['presidente', 'difusion'],
    rolesEscritura: ['difusion'],
    campos: ['titulo', 'plataforma', 'estado', 'fecha', 'hora', 'contenido'],
    requeridos: ['titulo', 'plataforma'],
  },
  'solicitudes-material': {
    coleccion: 'solicitudes_material',
    rolesLectura: ['presidente', 'difusion'],
    rolesEscritura: ['difusion'],
    campos: ['solicitante', 'solicitanteRol', 'material', 'evento', 'limite', 'estado', 'comentario'],
    requeridos: ['solicitante', 'material'],
  },
  'solicitudes-actividad': {
    coleccion: 'solicitudes_actividad',
    rolesLectura: ['presidente', 'vicepresidente'],
    rolesEscritura: [],
    campos: [],
    requeridos: [],
  },
  agenda: {
    rolesLectura: TODOS_ADMIN,
    rolesEscritura: ['secretario'],
    campos: ['titulo', 'tipo', 'fecha', 'hora', 'lugar', 'estado', 'responsableRol'],
    requeridos: ['titulo', 'fecha'],
  },
};

function errorHttp(res, estado, error, code, details) {
  return res.status(estado).json({ error, code, ...(details ? { details } : {}) });
}

function normalizarRol(rol = '') {
  return String(rol).trim().toLowerCase();
}

function serializarValor(valor) {
  if (valor && typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (Array.isArray(valor)) return valor.map(serializarValor);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([clave, dato]) => [clave, serializarValor(dato)]));
  }
  return valor;
}

function serializarDocumento(doc) {
  return { id: doc.id, ...serializarValor(doc.data()) };
}

function limpiarEntrada(body = {}, config) {
  return Object.fromEntries(
    config.campos
      .filter((campo) => Object.prototype.hasOwnProperty.call(body, campo))
      .map((campo) => [campo, body[campo]]),
  );
}

function validarEntrada(datos, config, parcial = false) {
  if (!datos || Object.keys(datos).length === 0) return 'No se recibieron campos válidos';
  if (!parcial) {
    const faltante = (config.requeridos || []).find((campo) => datos[campo] === undefined || datos[campo] === null || datos[campo] === '');
    if (faltante) return `El campo ${faltante} es obligatorio`;
  }
  if (Object.prototype.hasOwnProperty.call(datos, 'monto') && (!Number.isFinite(Number(datos.monto)) || Number(datos.monto) < 0)) return 'El monto no es válido';
  if (Object.prototype.hasOwnProperty.call(datos, 'asignado') && (!Number.isFinite(Number(datos.asignado)) || Number(datos.asignado) < 0)) return 'El presupuesto asignado no es válido';
  if (Object.prototype.hasOwnProperty.call(datos, 'avance') && (!Number.isFinite(Number(datos.avance)) || Number(datos.avance) < 0 || Number(datos.avance) > 100)) return 'El avance debe estar entre 0 y 100';
  return null;
}

module.exports = function crearAdminRouter({ db, admin, authenticateToken }) {
  const router = express.Router();
  const capituloId = process.env.CAPITULO_ID || 'isc';
  const coleccionAdmin = (nombre) => db.collection('capitulos').doc(capituloId).collection(nombre);

  async function cargarActor(req, res, next) {
    try {
      const perfilDoc = await db.collection('usuarios').doc(req.firebaseUid).get();
      if (!perfilDoc.exists) return errorHttp(res, 403, 'No existe un perfil autorizado para esta cuenta', 'ADMIN_PROFILE_REQUIRED');

      const perfil = perfilDoc.data();
      const rol = normalizarRol(perfil.rol);
      if (!ROLES_ADMIN.includes(rol)) {
        return errorHttp(res, 403, 'Esta cuenta pertenece al portal de alumnos y no tiene acceso a la Mesa Directiva', 'ADMIN_ROLE_REQUIRED');
      }

      req.actor = {
        uid: req.firebaseUid,
        numeroControl: req.numeroControl,
        nombre: perfil.nombre || req.firebaseUser.name || null,
        email: req.firebaseUser.email,
        rol,
      };
      next();
    } catch (error) {
      console.error('Admin actor error', error);
      return errorHttp(res, 500, 'No se pudo validar el perfil administrativo', 'ADMIN_PROFILE_ERROR');
    }
  }

  const permitirRoles = (...roles) => (req, res, next) => (
    roles.includes(req.actor.rol)
      ? next()
      : errorHttp(res, 403, 'No tienes permiso para realizar esta acción', 'ADMIN_FORBIDDEN')
  );

  router.use(authenticateToken, cargarActor);

  router.get('/sesion', (req, res) => {
    const permisos = Object.fromEntries(Object.entries(RECURSOS).map(([ruta, config]) => [ruta, {
      leer: config.rolesLectura.includes(req.actor.rol),
      escribir: config.rolesEscritura.includes(req.actor.rol),
    }]));
    res.json({ usuario: req.actor, permisos });
  });

  Object.entries(RECURSOS).forEach(([ruta, config]) => {
    const nombreColeccion = config.coleccion || ruta;

    router.get(`/${ruta}`, permitirRoles(...config.rolesLectura), async (req, res) => {
      try {
        const snapshot = await coleccionAdmin(nombreColeccion).get();
        const documentos = snapshot.docs
          .map(serializarDocumento)
          .filter((item) => !item.eliminado)
          .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        res.json(documentos);
      } catch (error) {
        console.error(`Admin list ${ruta}`, error);
        errorHttp(res, 500, `No se pudo consultar ${ruta}`, 'ADMIN_LIST_ERROR');
      }
    });

    router.post(`/${ruta}`, permitirRoles(...config.rolesEscritura), async (req, res) => {
      const datos = limpiarEntrada(req.body, config);
      const errorValidacion = validarEntrada(datos, config);
      if (errorValidacion) return errorHttp(res, 400, errorValidacion, 'ADMIN_VALIDATION_ERROR');

      try {
        const ahora = admin.firestore.FieldValue.serverTimestamp();
        const ref = await coleccionAdmin(nombreColeccion).add({
          ...datos,
          createdAt: ahora,
          updatedAt: ahora,
          createdBy: req.actor.uid,
          updatedBy: req.actor.uid,
          createdByRole: req.actor.rol,
        });
        const creado = await ref.get();
        res.status(201).json(serializarDocumento(creado));
      } catch (error) {
        console.error(`Admin create ${ruta}`, error);
        errorHttp(res, 500, `No se pudo crear el registro en ${ruta}`, 'ADMIN_CREATE_ERROR');
      }
    });

    router.patch(`/${ruta}/:id`, permitirRoles(...config.rolesEscritura), async (req, res) => {
      const datos = limpiarEntrada(req.body, config);
      const errorValidacion = validarEntrada(datos, config, true);
      if (errorValidacion) return errorHttp(res, 400, errorValidacion, 'ADMIN_VALIDATION_ERROR');

      try {
        const ref = coleccionAdmin(nombreColeccion).doc(req.params.id);
        const actual = await ref.get();
        if (!actual.exists || actual.data().eliminado) return errorHttp(res, 404, 'Registro no encontrado', 'ADMIN_NOT_FOUND');
        await ref.update({
          ...datos,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: req.actor.uid,
        });
        const actualizado = await ref.get();
        res.json(serializarDocumento(actualizado));
      } catch (error) {
        console.error(`Admin update ${ruta}`, error);
        errorHttp(res, 500, `No se pudo actualizar el registro en ${ruta}`, 'ADMIN_UPDATE_ERROR');
      }
    });

    router.delete(`/${ruta}/:id`, permitirRoles(...config.rolesEscritura), async (req, res) => {
      try {
        const ref = coleccionAdmin(nombreColeccion).doc(req.params.id);
        const actual = await ref.get();
        if (!actual.exists || actual.data().eliminado) return errorHttp(res, 404, 'Registro no encontrado', 'ADMIN_NOT_FOUND');
        await ref.update({
          eliminado: true,
          eliminadoAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: req.actor.uid,
        });
        res.json({ ok: true });
      } catch (error) {
        console.error(`Admin delete ${ruta}`, error);
        errorHttp(res, 500, `No se pudo eliminar el registro en ${ruta}`, 'ADMIN_DELETE_ERROR');
      }
    });
  });

  router.get('/miembros', permitirRoles('presidente', 'secretario'), async (req, res) => {
    try {
      const snapshot = await db.collection('usuarios').get();
      const miembros = snapshot.docs
        .map(serializarDocumento)
        .filter((item) => normalizarRol(item.rol || 'estudiante') === 'estudiante')
        .map((item) => ({
          id: item.id,
          uid: item.uid || item.id,
          nombre: item.nombre || 'Alumno',
          control: item.numeroControl || '',
          correo: item.email || '',
          carrera: item.carrera || '',
          semestre: item.semestre ?? null,
          estado: item.estado || 'Activo',
          ingreso: item.createdAt || null,
          intereses: item.intereses || [],
        }));
      res.json(miembros);
    } catch (error) {
      console.error('Admin members list', error);
      errorHttp(res, 500, 'No se pudo consultar el directorio de alumnos', 'ADMIN_MEMBER_LIST_ERROR');
    }
  });

  // El alta de cargos siempre pasa por el backend. El alumno debe tener su
  // correo verificado y el Vicepresidente no puede conceder un cargo directivo.
  router.get('/alumnos', permitirRoles('presidente', 'vicepresidente'), async (req, res) => {
    try {
      const snapshot = await db.collection('usuarios').get();
      const alumnos = snapshot.docs
        .map(serializarDocumento)
        .filter((item) => Boolean(item.email || item.correo) && item.numeroControl)
        .map((item) => ({
          id: item.id,
          uid: item.uid || item.id,
          nombre: item.nombre || 'Alumno sin nombre',
          control: item.numeroControl || '',
          correo: item.email || item.correo || '',
          carrera: item.carrera || '',
          semestre: item.semestre ?? null,
          emailVerified: Boolean(item.emailVerified),
          rol: ROLES_ADMIN.includes(normalizarRol(item.rol)) ? normalizarRol(item.rol) : 'estudiante',
          createdAt: item.createdAt || null,
        }))
        .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
      res.json(alumnos);
    } catch (error) {
      console.error('Admin student candidates list', error);
      errorHttp(res, 500, 'No se pudo consultar a los alumnos registrados', 'ADMIN_STUDENT_LIST_ERROR');
    }
  });

  router.patch('/alumnos/:uid/rol', permitirRoles('presidente', 'vicepresidente'), async (req, res) => {
    const uid = String(req.params.uid || '').trim();
    const nuevoRol = normalizarRol(req.body?.rol || 'estudiante');
    const rolesPermitidos = req.actor.rol === 'presidente' ? ROLES_ASIGNABLES : ROLES_ASIGNABLES_VICEPRESIDENTE;

    if (!uid) return errorHttp(res, 400, 'Falta el identificador del alumno', 'ADMIN_VALIDATION_ERROR');
    if (!rolesPermitidos.includes(nuevoRol)) return errorHttp(res, 403, 'Ese cargo no puede ser asignado desde tu puesto', 'ADMIN_ROLE_ASSIGNMENT_FORBIDDEN');
    if (uid === req.actor.uid) return errorHttp(res, 409, 'No puedes cambiar tu propio cargo desde esta sección', 'ADMIN_SELF_ROLE_CHANGE');

    try {
      const authUser = await admin.auth().getUser(uid);
      if (!authUser.emailVerified) return errorHttp(res, 409, 'El alumno debe verificar su correo antes de recibir un cargo', 'ADMIN_EMAIL_VERIFICATION_REQUIRED');

      const perfilRef = db.collection('usuarios').doc(uid);
      const auditoriaRef = coleccionAdmin('asignaciones_roles').doc();
      let anteriorRol = 'estudiante';

      await db.runTransaction(async (transaction) => {
        const perfilDoc = await transaction.get(perfilRef);
        if (!perfilDoc.exists) {
          const error = new Error('ADMIN_TARGET_NOT_FOUND');
          error.code = 'ADMIN_TARGET_NOT_FOUND';
          throw error;
        }

        const perfil = perfilDoc.data();
        anteriorRol = ROLES_ADMIN.includes(normalizarRol(perfil.rol)) ? normalizarRol(perfil.rol) : 'estudiante';
        if (req.actor.rol === 'vicepresidente' && anteriorRol === 'presidente') {
          const error = new Error('ADMIN_TARGET_PRESIDENT');
          error.code = 'ADMIN_TARGET_PRESIDENT';
          throw error;
        }

        const ahora = admin.firestore.FieldValue.serverTimestamp();
        transaction.update(perfilRef, {
          rol: nuevoRol,
          emailVerified: Boolean(perfil.emailVerified) || Boolean(authUser.emailVerified),
          updatedAt: ahora,
          updatedBy: req.actor.uid,
          updatedByRole: req.actor.rol,
        });
        transaction.set(auditoriaRef, {
          uid,
          nombre: perfil.nombre || authUser.displayName || 'Alumno',
          numeroControl: perfil.numeroControl || null,
          rolAnterior: anteriorRol,
          rolNuevo: nuevoRol,
          actorUid: req.actor.uid,
          actorNombre: req.actor.nombre,
          actorRol: req.actor.rol,
          createdAt: ahora,
        });
      });

      const actualizado = await perfilRef.get();
      res.json({ id: actualizado.id, ...serializarValor(actualizado.data()), rolAnterior: anteriorRol });
    } catch (error) {
      if (error.code === 'ADMIN_TARGET_NOT_FOUND') return errorHttp(res, 404, 'No se encontró el perfil del alumno', 'ADMIN_NOT_FOUND');
      if (error.code === 'ADMIN_TARGET_PRESIDENT') return errorHttp(res, 403, 'El Vicepresidente no puede modificar el cargo del Presidente', 'ADMIN_ROLE_ASSIGNMENT_FORBIDDEN');
      if (error.code === 'auth/user-not-found') return errorHttp(res, 404, 'No se encontró la cuenta del alumno', 'ADMIN_NOT_FOUND');
      console.error('Admin role assignment', error);
      errorHttp(res, 500, 'No se pudo actualizar el cargo del alumno', 'ADMIN_ROLE_ASSIGNMENT_ERROR');
    }
  });

  router.get('/aprobaciones', async (req, res) => {
    try {
      const snapshot = await coleccionAdmin('aprobaciones').get();
      const filas = snapshot.docs.map(serializarDocumento).filter((item) => (
        req.actor.rol === 'presidente'
        || item.solicitanteRol === req.actor.rol
        || item.destinatarioRol === req.actor.rol
      ));
      res.json(filas);
    } catch (error) {
      console.error('Admin approvals list', error);
      errorHttp(res, 500, 'No se pudieron consultar las aprobaciones', 'ADMIN_APPROVAL_LIST_ERROR');
    }
  });

  router.post('/aprobaciones', async (req, res) => {
    const permitidos = ['area', 'tipo', 'solicitante', 'resumen', 'monto', 'destinatarioRol'];
    const datos = Object.fromEntries(permitidos.filter((campo) => Object.prototype.hasOwnProperty.call(req.body || {}, campo)).map((campo) => [campo, req.body[campo]]));
    if (!datos.resumen) return errorHttp(res, 400, 'El resumen es obligatorio', 'ADMIN_VALIDATION_ERROR');

    try {
      const ahora = admin.firestore.FieldValue.serverTimestamp();
      const ref = await coleccionAdmin('aprobaciones').add({
        ...datos,
        monto: Number(datos.monto || 0),
        solicitanteRol: req.actor.rol,
        solicitanteUid: req.actor.uid,
        estado: 'Pendiente',
        fecha: new Date().toISOString().slice(0, 10),
        createdAt: ahora,
        updatedAt: ahora,
      });
      const creado = await ref.get();
      res.status(201).json(serializarDocumento(creado));
    } catch (error) {
      console.error('Admin approval create', error);
      errorHttp(res, 500, 'No se pudo crear la aprobación', 'ADMIN_APPROVAL_CREATE_ERROR');
    }
  });

  router.patch('/aprobaciones/:id/decision', permitirRoles('presidente'), async (req, res) => {
    const estado = String(req.body?.estado || '');
    const comentario = String(req.body?.comentario || '').trim();
    if (!['Aprobada', 'Rechazada'].includes(estado)) return errorHttp(res, 400, 'La decisión debe ser Aprobada o Rechazada', 'ADMIN_VALIDATION_ERROR');

    try {
      const aprobacionRef = coleccionAdmin('aprobaciones').doc(req.params.id);
      const decisionRef = coleccionAdmin('decisiones').doc();
      const notificacionRef = coleccionAdmin('notificaciones').doc();

      await db.runTransaction(async (transaction) => {
        const aprobacionDoc = await transaction.get(aprobacionRef);
        if (!aprobacionDoc.exists) {
          const error = new Error('APPROVAL_NOT_FOUND');
          error.code = 'APPROVAL_NOT_FOUND';
          throw error;
        }
        const aprobacion = aprobacionDoc.data();
        if (aprobacion.estado !== 'Pendiente') {
          const error = new Error('APPROVAL_ALREADY_RESOLVED');
          error.code = 'APPROVAL_ALREADY_RESOLVED';
          throw error;
        }

        const ahora = admin.firestore.FieldValue.serverTimestamp();
        transaction.update(aprobacionRef, {
          estado,
          comentario,
          resolvedAt: ahora,
          resolvedBy: req.actor.uid,
          updatedAt: ahora,
        });
        transaction.set(decisionRef, {
          aprobacionId: aprobacionRef.id,
          fecha: new Date().toISOString().slice(0, 10),
          area: aprobacion.area || 'General',
          tipo: estado,
          detalle: aprobacion.resumen,
          comentario,
          actorUid: req.actor.uid,
          actorNombre: req.actor.nombre,
          createdAt: ahora,
        });
        transaction.set(notificacionRef, {
          rol: aprobacion.solicitanteRol || 'presidente',
          usuarioUid: aprobacion.solicitanteUid || null,
          tipo: 'aprobacion',
          mensaje: `Tu solicitud \"${aprobacion.resumen}\" fue ${estado.toLowerCase()}.`,
          leida: false,
          timestamp: ahora,
          createdAt: ahora,
        });
        if (aprobacion.origen === 'solicitud-actividad' && aprobacion.origenId) {
          const solicitudRef = coleccionAdmin('solicitudes_actividad').doc(aprobacion.origenId);
          transaction.set(solicitudRef, {
            estado,
            comentarioMesa: comentario,
            resolvedAt: ahora,
            resolvedBy: req.actor.uid,
            updatedAt: ahora,
          }, { merge: true });
        }
      });

      const actualizado = await aprobacionRef.get();
      res.json(serializarDocumento(actualizado));
    } catch (error) {
      if (error.code === 'APPROVAL_NOT_FOUND') return errorHttp(res, 404, 'Aprobación no encontrada', 'ADMIN_NOT_FOUND');
      if (error.code === 'APPROVAL_ALREADY_RESOLVED') return errorHttp(res, 409, 'Esta aprobación ya fue resuelta', 'ADMIN_APPROVAL_ALREADY_RESOLVED');
      console.error('Admin approval decision', error);
      errorHttp(res, 500, 'No se pudo registrar la decisión', 'ADMIN_APPROVAL_DECISION_ERROR');
    }
  });

  router.get('/decisiones', permitirRoles('presidente'), async (req, res) => {
    try {
      const snapshot = await coleccionAdmin('decisiones').get();
      res.json(snapshot.docs.map(serializarDocumento).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
    } catch (error) {
      console.error('Admin decisions list', error);
      errorHttp(res, 500, 'No se pudo consultar el historial', 'ADMIN_DECISION_LIST_ERROR');
    }
  });

  router.get('/notificaciones', async (req, res) => {
    try {
      const snapshot = await coleccionAdmin('notificaciones').get();
      const filas = snapshot.docs.map(serializarDocumento).filter((item) => (
        req.actor.rol === 'presidente'
        || item.rol === req.actor.rol
        || item.usuarioUid === req.actor.uid
      ));
      res.json(filas.sort((a, b) => String(b.timestamp || b.createdAt || '').localeCompare(String(a.timestamp || a.createdAt || ''))));
    } catch (error) {
      console.error('Admin notifications list', error);
      errorHttp(res, 500, 'No se pudieron consultar las notificaciones', 'ADMIN_NOTIFICATION_LIST_ERROR');
    }
  });

  router.patch('/notificaciones/:id/leer', async (req, res) => {
    try {
      const ref = coleccionAdmin('notificaciones').doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return errorHttp(res, 404, 'Notificación no encontrada', 'ADMIN_NOT_FOUND');
      const notificacion = doc.data();
      const esPropia = req.actor.rol === 'presidente' || notificacion.rol === req.actor.rol || notificacion.usuarioUid === req.actor.uid;
      if (!esPropia) return errorHttp(res, 403, 'No puedes modificar esta notificación', 'ADMIN_FORBIDDEN');
      await ref.update({ leida: true, leidaAt: admin.firestore.FieldValue.serverTimestamp() });
      res.json({ ok: true });
    } catch (error) {
      console.error('Admin notification read', error);
      errorHttp(res, 500, 'No se pudo actualizar la notificación', 'ADMIN_NOTIFICATION_UPDATE_ERROR');
    }
  });

  router.patch('/notificaciones/leer-todas', async (req, res) => {
    try {
      const snapshot = await coleccionAdmin('notificaciones').get();
      const batch = db.batch();
      let actualizadas = 0;
      snapshot.docs.forEach((doc) => {
        const item = doc.data();
        const esPropia = req.actor.rol === 'presidente' || item.rol === req.actor.rol || item.usuarioUid === req.actor.uid;
        if (esPropia && !item.leida) {
          batch.update(doc.ref, { leida: true, leidaAt: admin.firestore.FieldValue.serverTimestamp() });
          actualizadas += 1;
        }
      });
      if (actualizadas > 0) await batch.commit();
      res.json({ ok: true, actualizadas });
    } catch (error) {
      console.error('Admin notifications read all', error);
      errorHttp(res, 500, 'No se pudieron actualizar las notificaciones', 'ADMIN_NOTIFICATION_UPDATE_ERROR');
    }
  });

  router.get('/resumen', async (req, res) => {
    try {
      const accesibles = Object.entries(RECURSOS).filter(([, config]) => config.rolesLectura.includes(req.actor.rol));
      const resultados = await Promise.all(accesibles.map(async ([ruta, config]) => {
        const snapshot = await coleccionAdmin(config.coleccion || ruta).get();
        return [ruta, snapshot.docs.filter((doc) => !doc.data().eliminado).length];
      }));
      const transacciones = req.actor.rol === 'presidente' || req.actor.rol === 'tesorero'
        ? (await coleccionAdmin('transacciones').get()).docs.map((doc) => doc.data())
        : [];
      const balance = transacciones.reduce((total, item) => total + (item.tipo === 'ingreso' ? Number(item.monto || 0) : -Number(item.monto || 0)), 0);
      res.json({ rol: req.actor.rol, totales: Object.fromEntries(resultados), balance });
    } catch (error) {
      console.error('Admin summary', error);
      errorHttp(res, 500, 'No se pudo construir el resumen', 'ADMIN_SUMMARY_ERROR');
    }
  });

  router.get('/vision-global', permitirRoles('presidente'), async (req, res) => {
    try {
      const nombres = ['proyectos', 'reuniones', 'transacciones', 'presupuestos', 'publicaciones', 'solicitudes_material', 'agenda'];
      const pares = await Promise.all(nombres.map(async (nombre) => {
        const snapshot = await coleccionAdmin(nombre).get();
        return [nombre, snapshot.docs.map(serializarDocumento).filter((item) => !item.eliminado)];
      }));
      const aprobaciones = await coleccionAdmin('aprobaciones').get();
      res.json({
        ...Object.fromEntries(pares),
        aprobaciones: aprobaciones.docs.map(serializarDocumento),
      });
    } catch (error) {
      console.error('Admin global vision', error);
      errorHttp(res, 500, 'No se pudo consultar la visión global', 'ADMIN_GLOBAL_VIEW_ERROR');
    }
  });

  return router;
};

module.exports.ROLES_ADMIN = ROLES_ADMIN;
module.exports.RECURSOS_ADMIN = RECURSOS;
