require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Helpers generales ───────────────────────────────────────────────────────
const NUMERO_CONTROL_REGEX = /^\d{8}$/;
const CORREO_PREFIX = process.env.INSTITUTIONAL_EMAIL_PREFIX || 'alu';
const CORREO_DOMAIN = process.env.INSTITUTIONAL_EMAIL_DOMAIN || 'correo.itlalaguna.edu.mx';

function normalizarNumeroControl(numeroControl = '') {
  return String(numeroControl ?? '').trim();
}

function crearCorreoInstitucional(numeroControl = '') {
  const numeroLimpio = normalizarNumeroControl(numeroControl);
  return numeroLimpio ? `${CORREO_PREFIX}.${numeroLimpio}@${CORREO_DOMAIN}`.toLowerCase() : '';
}

function escaparRegex(valor = '') {
  return valor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function obtenerNumeroControlDesdeCorreoInstitucional(email = '') {
  const patron = new RegExp(
    `^${escaparRegex(CORREO_PREFIX)}\\.([^@]+)@${escaparRegex(CORREO_DOMAIN)}$`,
    'i'
  );
  const coincidencia = String(email || '').trim().match(patron);
  return coincidencia?.[1] || '';
}

function validarNumeroControl(numeroControl) {
  if (!numeroControl) return 'Número de control obligatorio';
  if (!NUMERO_CONTROL_REGEX.test(numeroControl)) return 'El número de control debe tener 8 dígitos';
  return null;
}

function obtenerNumeroControlObligatorio(body = {}) {
  return normalizarNumeroControl(body.numeroControl);
}

function rechazarEmailManual(req, res) {
  if (Object.prototype.hasOwnProperty.call(req.body, 'email')) {
    res.status(400).json({
      error: 'No envíes email manualmente. El correo institucional se genera automáticamente con el número de control.',
    });
    return true;
  }

  return false;
}

function crearIniciales(nombre = '') {
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return 'US';
  return partes.slice(0, 2).map((parte) => parte[0]?.toUpperCase()).join('');
}

function mapearErrorAdminAuth(err) {
  const mensajes = {
    'auth/email-already-exists': 'Número de control ya registrado',
    'auth/invalid-email': 'El correo institucional generado no es válido',
    'auth/invalid-password': 'La contraseña no es válida',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres',
    'auth/operation-not-allowed': 'El proveedor Email/Password no está habilitado en Firebase Authentication',
  };

  return mensajes[err.code] || err.message || 'Error de autenticación';
}

function mapearErrorIdentityToolkit(codigo = '') {
  const mensajes = {
    EMAIL_NOT_FOUND: 'No existe una cuenta con ese número de control',
    INVALID_PASSWORD: 'Contraseña incorrecta',
    INVALID_LOGIN_CREDENTIALS: 'Número de control o contraseña incorrectos',
    USER_DISABLED: 'Esta cuenta está deshabilitada',
    OPERATION_NOT_ALLOWED: 'El proveedor Email/Password no está habilitado en Firebase Authentication',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Demasiados intentos. Espera un momento e inténtalo nuevamente',
    API_KEY_INVALID: 'FIREBASE_API_KEY no es válida',
  };

  return mensajes[codigo] || 'No se pudo iniciar sesión';
}

// ─── Firebase Admin ───────────────────────────────────────────────────────────
function obtenerServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Falta FIREBASE_SERVICE_ACCOUNT');

  try {
    const serviceAccount = JSON.parse(raw);

    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    return serviceAccount;
  } catch (_) {
    const serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));

    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    return serviceAccount;
  }
}

admin.initializeApp({
  credential: admin.credential.cert(obtenerServiceAccount()),
});

const db = admin.firestore();
console.log('Firebase: Admin inicializado');

// ─── Backblaze B2 (S3-compatible) ────────────────────────────────────────────
const s3 = new S3Client({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
  forcePathStyle: true,
});

const B2_BUCKET = process.env.B2_BUCKET_NAME;
const B2_PUBLIC_BASE_URL = process.env.B2_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
const upload = multer({ storage: multer.memoryStorage() });

console.log('B2 config:', {
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  bucket: process.env.B2_BUCKET_NAME,
  publicBaseUrl: process.env.B2_PUBLIC_BASE_URL,
});

// ─── Variables de entorno Firebase Auth ──────────────────────────────────────
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

const firebaseAuthUrl = (path) => {
  if (!FIREBASE_API_KEY) return '';
  return `https://identitytoolkit.googleapis.com/v1/${path}?key=${FIREBASE_API_KEY}`;
};

function ensureApiKey(req, res, next) {
  if (!FIREBASE_API_KEY) {
    return res.status(500).json({ error: 'Falta FIREBASE_API_KEY' });
  }
  next();
}

// ─── Middleware: verificar token Firebase ────────────────────────────────────
async function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.toString().startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  const token = auth.toString().replace('Bearer ', '');

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const numeroControl = obtenerNumeroControlDesdeCorreoInstitucional(decoded.email);

    if (!numeroControl) {
      return res.status(403).json({
        error: 'El token no pertenece a un correo institucional válido',
      });
    }

    req.firebaseUid = decoded.uid;
    req.firebaseUser = decoded;
    req.numeroControl = numeroControl;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalido' });
  }
}

// ─── Auth: Registro exclusivo con número de control ──────────────────────────
app.post('/auth/register', async (req, res) => {
  if (rechazarEmailManual(req, res)) return;

  const {
    password,
    rol = 'estudiante',
    categoria,
    subcategoria,
    nombre,
    carrera = 'Ingeniería en Sistemas Computacionales',
    semestre,
  } = req.body;

  const numeroControl = obtenerNumeroControlObligatorio(req.body);
  const errorNumeroControl = validarNumeroControl(numeroControl);

  if (errorNumeroControl) {
    return res.status(400).json({ error: errorNumeroControl });
  }

  if (!password) {
    return res.status(400).json({ error: 'Password obligatorio' });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  const email = crearCorreoInstitucional(numeroControl);

  try {
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: nombre?.trim() || undefined,
    });

    const perfilUsuario = {
      uid: userRecord.uid,
      email,
      numeroControl,
      nombre: nombre?.trim() || null,
      avatar: crearIniciales(nombre),
      rol,
      carrera,
      semestre: semestre ?? null,
      categoria: categoria ?? null,
      subcategoria: subcategoria ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('usuarios').doc(userRecord.uid).set(perfilUsuario);

    res.status(201).json({
      uid: userRecord.uid,
      email,
      numeroControl,
      nombre: perfilUsuario.nombre,
      rol,
    });
  } catch (err) {
    console.error('Auth register error', err);

    if (err.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'Número de control ya registrado' });
    }

    res.status(500).json({ error: mapearErrorAdminAuth(err), code: err.code });
  }
});

// ─── Auth: Login exclusivo con número de control ─────────────────────────────
app.post('/auth/login', ensureApiKey, async (req, res) => {
  if (rechazarEmailManual(req, res)) return;

  const { password } = req.body;
  const numeroControl = obtenerNumeroControlObligatorio(req.body);
  const errorNumeroControl = validarNumeroControl(numeroControl);

  if (errorNumeroControl) {
    return res.status(400).json({ error: errorNumeroControl });
  }

  if (!password) {
    return res.status(400).json({ error: 'Password obligatorio' });
  }

  const email = crearCorreoInstitucional(numeroControl);

  try {
    const response = await fetch(firebaseAuthUrl('accounts:signInWithPassword'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });

    const data = await response.json();

    if (!response.ok) {
      const codigoFirebase = data?.error?.message;
      return res.status(response.status).json({
        error: mapearErrorIdentityToolkit(codigoFirebase),
        firebaseError: codigoFirebase,
      });
    }

    res.json({
      ...data,
      email,
      numeroControl,
    });
  } catch (err) {
    console.error('Auth login error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Auth: Custom token ───────────────────────────────────────────────────────
app.post('/auth/custom-token', authenticateToken, async (req, res) => {
  try {
    const customToken = await admin.auth().createCustomToken(req.firebaseUid);
    res.json({ customToken });
  } catch (err) {
    console.error('custom-token', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Firebase: Verificar token ───────────────────────────────────────────────
app.post('/firebase/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).send('Token requerido');

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const numeroControl = obtenerNumeroControlDesdeCorreoInstitucional(decoded.email);

    if (!numeroControl) {
      return res.status(403).json({
        error: 'El token no pertenece a un correo institucional válido',
      });
    }

    res.json({
      uid: decoded.uid,
      email: decoded.email,
      numeroControl,
    });
  } catch (err) {
    res.status(401).json({ error: 'Token invalido' });
  }
});

// ─── Firebase: Perfil del usuario autenticado ────────────────────────────────
app.get('/usuarios/me', authenticateToken, async (req, res) => {
  try {
    const uid = req.firebaseUid;
    if (!uid) {
      return res.status(401).json({ error: 'UID no encontrado' });
    }

    const doc = await db.collection('usuarios').doc(uid).get();

    if (doc.exists) {
      return res.json({ id: doc.id, ...doc.data() });
    }

    // Fallback solo para usuarios con correo institucional válido.
    const userRecord = await admin.auth().getUser(uid);
    const email = userRecord.email || '';
    const numeroControl = obtenerNumeroControlDesdeCorreoInstitucional(email);

    if (!numeroControl) {
      return res.status(403).json({
        error: 'El usuario no tiene un correo institucional válido',
      });
    }

    const nombre = userRecord.displayName || null;

    const perfilUsuario = {
      uid,
      email,
      numeroControl,
      nombre,
      avatar: crearIniciales(nombre),
      rol: 'estudiante',
      carrera: 'Ingeniería en Sistemas Computacionales',
      semestre: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('usuarios').doc(uid).set(perfilUsuario, { merge: true });
    res.json({ id: uid, ...perfilUsuario });
  } catch (err) {
    console.error('Perfil error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Firestore: Laboratorio uploads ─────────────────────────────────────────
// Importante: va antes de /firebase/:coleccion para que Express no lo capture como colección genérica.
app.get('/firebase/laboratorio', async (req, res) => {
  try {
    const snapshot = await db.collection('laboratorio_uploads').get();
    const entries = snapshot.docs.map(doc => {
      const data = doc.data();
      const createdAt = data.createdAt;
      return {
        id: doc.id,
        key: data.key,
        url: data.url,
        originalName: data.originalName,
        createdAt: createdAt && typeof createdAt.toDate === 'function'
          ? createdAt.toDate().toISOString()
          : null,
      };
    });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Firestore: Leer coleccion ───────────────────────────────────────────────
app.get('/firebase/:coleccion', async (req, res) => {
  try {
    let query = db.collection(req.params.coleccion);
    const skip = new Set(['limit', 'offset']);

    for (const [key, value] of Object.entries(req.query)) {
      if (!skip.has(key)) query = query.where(key, '==', value);
    }

    const snapshot = await query.get();
    const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Firestore: Insertar documento ──────────────────────────────────────────
app.post('/firebase/:coleccion', async (req, res) => {
  try {
    const ref = await db.collection(req.params.coleccion).add(req.body);
    res.json({ id: ref.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Firestore: Actualizar documento por ID ──────────────────────────────────
app.patch('/firebase/:coleccion/:id', async (req, res) => {
  try {
    await db.collection(req.params.coleccion).doc(req.params.id).update(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Firestore: Insertar multiples documentos en batch ───────────────────────
app.post('/firebase/:coleccion/batch', async (req, res) => {
  const { docs } = req.body;
  if (!Array.isArray(docs) || docs.length === 0) {
    return res.status(400).json({ error: 'Se requiere array "docs"' });
  }

  try {
    const collection = db.collection(req.params.coleccion);
    const batch = db.batch();

    docs.forEach(doc => {
      const ref = collection.doc();
      batch.set(ref, { ...doc, creado: admin.firestore.FieldValue.serverTimestamp() });
    });

    await batch.commit();
    res.json({ insertados: docs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backblaze B2: Subir archivo ─────────────────────────────────────────────
app.post('/storage/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio archivo' });

  const key = `${Date.now()}-${req.file.originalname}`;

  console.log('Upload request start:', {
    name: req.file.originalname,
    size: req.file.size,
    fieldname: req.file.fieldname,
  });

  try {
    console.log('Uploading to b2', key);

    await s3.send(new PutObjectCommand({
      Bucket: B2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const url = `${B2_PUBLIC_BASE_URL}/${key}`;
    const docRef = await db.collection('laboratorio_uploads').add({
      key,
      url,
      originalName: req.file.originalname,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('Upload saved to Firestore', { id: docRef.id, url, bucket: B2_BUCKET, key });
    res.json({ key, url, docId: docRef.id });
  } catch (err) {
    console.error('Upload failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Backblaze B2: Listar archivos ───────────────────────────────────────────
app.get('/storage', async (req, res) => {
  try {
    const data = await s3.send(new ListObjectsV2Command({ Bucket: B2_BUCKET }));
    const files = (data.Contents || []).map(f => ({
      key: f.Key,
      size: f.Size,
      modified: f.LastModified,
    }));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backblaze B2: URL firmada ───────────────────────────────────────────────
app.get('/storage/url/:key', async (req, res) => {
  try {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: B2_BUCKET, Key: req.params.key }),
      { expiresIn: 3600 }
    );
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backblaze B2: Eliminar archivo ─────────────────────────────────────────
app.delete('/storage/:key', async (req, res) => {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: req.params.key }));
    res.json({ message: 'Archivo eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Estado del backend ───────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Servidor ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Puerto: ${PORT}`);
});