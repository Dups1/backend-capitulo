require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const admin = require('firebase-admin');
const cors = require('cors');
const multer = require('multer');
const { Resend } = require('resend');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

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

function normalizarEmail(email = '') {
  return String(email ?? '').trim().toLowerCase();
}

function validarEmailBasico(email = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizarEmail(email));
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
    return false;
  }
  return true;
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
const MAX_PROFILE_IMAGE_BYTES = 1 * 1024 * 1024; // 1 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PROFILE_IMAGE_BYTES,
    files: 1,
    fields: 0,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) {
      return cb(new Error('Solo se permiten archivos de imagen'));
    }
    cb(null, true);
  },
});

console.log('B2 config:', {
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  bucket: process.env.B2_BUCKET_NAME,
  publicBaseUrl: process.env.B2_PUBLIC_BASE_URL,
});

// ─── Variables de entorno Firebase Auth ──────────────────────────────────────
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL?.replace(/\/$/, '') || 'https://backend-capitulo.onrender.com';
const FRONTEND_PUBLIC_URL = process.env.FRONTEND_PUBLIC_URL?.replace(/\/$/, '') || 'https://capitulo-orange.web.app';

const AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE !== 'false';
const AUTH_COOKIE_SAME_SITE = process.env.AUTH_COOKIE_SAME_SITE || 'lax';
const AUTH_REFRESH_COOKIE_MAX_AGE_MS = Number(process.env.AUTH_REFRESH_COOKIE_MAX_AGE_MS || 1000 * 60 * 60 * 24 * 30);

const firebaseAuthUrl = (path) => {
  if (!FIREBASE_API_KEY) return '';
  return `https://identitytoolkit.googleapis.com/v1/${path}?key=${FIREBASE_API_KEY}`;
};

// ─── Resend (API HTTP, no SMTP) ───────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Capítulo ISC <onboarding@resend.dev>';

let resendClient = null;
if (RESEND_API_KEY) {
  resendClient = new Resend(RESEND_API_KEY);
  console.log('Resend: cliente inicializado');
} else {
  console.log('Resend: no configurado (falta RESEND_API_KEY)');
}

// ─── Mercado Pago Checkout Pro ───────────────────────────────────────────────
const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || '';

let mercadoPagoPreferenceClient = null;
if (MERCADOPAGO_ACCESS_TOKEN) {
  const mercadoPagoClient = new MercadoPagoConfig({ accessToken: MERCADOPAGO_ACCESS_TOKEN });
  mercadoPagoPreferenceClient = new Preference(mercadoPagoClient);
  console.log('Mercado Pago: cliente Checkout Pro inicializado');
} else {
  console.log('Mercado Pago: no configurado (falta MERCADOPAGO_ACCESS_TOKEN)');
}

// ─── Envío de correo de verificación con Resend ──────────────────────────────
async function enviarCorreoVerificacionResend(email) {
  if (!resendClient) throw new Error('Resend no configurado');

  const token = crypto.randomBytes(32).toString('hex');
  const callbackUrl = new URL(`${BACKEND_PUBLIC_URL}/auth/verify-email`);
  callbackUrl.searchParams.set('token', token);
  callbackUrl.searchParams.set('email', email);

  await db.collection('email_verifications').add({
    email: normalizarEmail(email),
    token,
    used: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: new Date(Date.now() + 86400000),
  });

  const link = escaparHtml(callbackUrl.toString());
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:520px;margin:24px auto;background:rgba(15,23,42,.78);border:1px solid rgba(148,163,184,.24);border-radius:28px;padding:32px;">
<p style="color:#67e8f9;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin:0 0 16px;">Capítulo ISC</p>
<h1 style="color:#e2e8f0;font-size:28px;margin:0 0 12px;">Confirma tu correo</h1>
<p style="color:#94a3b8;font-size:15px;line-height:1.65;margin:0 0 24px;">Haz clic para confirmar tu correo y completar tu registro.</p>
<a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#8b5cf6,#06b6d4);color:#fff;font-weight:800;text-decoration:none;padding:14px 24px;border-radius:16px;">Confirmar mi correo</a>
<p style="color:#64748b;font-size:12px;margin:24px 0 0;">O copia: ${link}</p>
</div></body></html>`;

  const { data, error } = await resendClient.emails.send({
    from: RESEND_FROM,
    to: email,
    subject: 'Confirma tu correo - Capítulo ISC',
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }

  return { token, callbackUrl: callbackUrl.toString() };
}

// ─── Envío de correo de verificación (solo Resend) ──────────────────────────
async function enviarCorreoVerificacion(email) {
  return enviarCorreoVerificacionResend(email);
}

function escaparHtml(valor = '') {
  const amp = '&#38;';
  const lt = '&#60;';
  const gt = '&#62;';
  const quot = '&#34;';
  const apos = '&#39;';
  return String(valor ?? '')
    .replace(/&/g, amp)
    .replace(/</g, lt)
    .replace(/>/g, gt)
    .replace(/"/g, quot)
    .replace(/'/g, apos);
}

function crearHtmlEmailLink({ titulo, mensaje, detalle = '', usuario = null, exito = true }) {
  const color = exito ? '#22c55e' : '#f43f5e';
  const estado = exito ? 'Autenticación completada' : 'No se pudo completar la autenticación';
  const usuarioHtml = usuario
    ? `<dl class="details"><dt>Correo</dt><dd>${escaparHtml(usuario.email)}</dd><dt>Número de control</dt><dd>${escaparHtml(usuario.numeroControl || 'No disponible')}</dd></dl>`
    : '';

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escaparHtml(titulo)}</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: radial-gradient(circle at top, #1e1b4b, #020617 58%); color: #e2e8f0; }
      main { width: min(92vw, 520px); border: 1px solid rgba(148, 163, 184, .24); border-radius: 28px; padding: 32px; background: rgba(15, 23, 42, .78); box-shadow: 0 24px 80px rgba(2, 6, 23, .5); }
      .badge { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 8px 12px; background: ${color}22; color: ${color}; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 18px 0 10px; font-size: clamp(26px, 5vw, 38px); line-height: 1.05; }
      p { margin: 0; color: #94a3b8; line-height: 1.65; }
      .details { display: grid; gap: 8px; margin-top: 22px; padding: 16px; border-radius: 18px; background: rgba(15, 23, 42, .9); border: 1px solid rgba(148, 163, 184, .16); }
      dt { color: #67e8f9; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
      dd { margin: 0 0 8px; color: #e2e8f0; word-break: break-word; }
      small { display: block; margin-top: 18px; color: #64748b; }
    </style>
  </head>
  <body>
    <main>
      <span class="badge">${escaparHtml(estado)}</span>
      <h1>${escaparHtml(titulo)}</h1>
      <p>${escaparHtml(mensaje)}</p>
      ${detalle ? `<small>${escaparHtml(detalle)}</small>` : ''}
      ${usuarioHtml}
    </main>
  </body>
</html>`;
}

function obtenerParametroEntrada(origen = {}, nombre = '') {
  const valor = origen[nombre];
  return Array.isArray(valor) ? valor[0] : valor;
}

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

    if (!decoded.email_verified) {
      return res.status(403).json({
        error: 'Debes confirmar tu correo institucional antes de acceder al sistema',
        emailVerificationRequired: true,
      });
    }

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
app.post('/auth/register', ensureApiKey, async (req, res) => {
  if (!rechazarEmailManual(req, res)) return;

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
      emailVerified: false,
      semestre: semestre ?? null,
      categoria: categoria ?? null,
      subcategoria: subcategoria ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('usuarios').doc(userRecord.uid).set(perfilUsuario);

    try {
      await enviarVinculoAccesoEmail(email, { numeroControl, flujo: 'registro' });
      res.status(201).json({
        uid: userRecord.uid,
        email,
        numeroControl,
        nombre: perfilUsuario.nombre,
        rol,
        requiereVerificacion: true,
        emailLinkSent: true,
        message: 'Cuenta creada. Revisa tu correo institucional para confirmar el acceso antes de iniciar sesión.',
      });
    } catch (errorEmailLink) {
      console.error('Register email link error', errorEmailLink);
      return res.status(201).json({
        uid: userRecord.uid,
        email,
        numeroControl,
        nombre: perfilUsuario.nombre,
        rol,
        requiereVerificacion: true,
        emailLinkSent: false,
        warning: 'Cuenta creada, pero no se pudo enviar el vínculo de verificación. Intenta solicitarlo nuevamente.',
        firebaseError: errorEmailLink.firebaseError,
      });
    }
  } catch (err) {
    console.error('Auth register error', err);

    if (err.code === 'auth/email-already-exists') {
      try {
        const userRecord = await admin.auth().getUserByEmail(email);

        if (!userRecord.emailVerified) {
          await enviarVinculoAccesoEmail(email, { numeroControl, flujo: 'registro-reenvio' });
          return res.status(200).json({
            uid: userRecord.uid,
            email,
            numeroControl,
            nombre: userRecord.displayName || null,
            rol,
            requiereVerificacion: true,
            emailLinkSent: true,
            message: 'La cuenta ya existía y aún no está verificada. Te enviamos un nuevo vínculo de confirmación.',
          });
        }
      } catch (errorReenvio) {
        console.error('Register resend email link error', errorReenvio);
      }

      return res.status(409).json({ error: 'Número de control ya registrado' });
    }

    res.status(500).json({ error: mapearErrorAdminAuth(err), code: err.code });
  }
});

// ─── Auth: Login exclusivo con número de control ─────────────────────────────
app.post('/auth/login', ensureApiKey, async (req, res) => {
  if (!rechazarEmailManual(req, res)) return;

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

    const userRecord = data.localId
      ? await admin.auth().getUser(data.localId)
      : await admin.auth().getUserByEmail(email);

    if (!userRecord.emailVerified) {
      let emailSent = false;
      let emailError = null;

      try {
        await enviarVinculoAccesoEmail(email, { numeroControl, flujo: 'login-reenvio' });
        emailSent = true;
      } catch (errorEmailLink) {
        console.error('Login resend email link error', errorEmailLink);
        emailError = errorEmailLink.message || errorEmailLink.firebaseError || 'Error desconocido';
      }

      return res.status(403).json({
        error: emailSent
          ? 'Debes confirmar tu correo institucional antes de iniciar sesión. Te enviamos un nuevo vínculo de verificación.'
          : `Debes confirmar tu correo institucional antes de iniciar sesión. No se pudo enviar el vínculo de verificación: ${emailError}`,
        emailVerificationRequired: true,
        emailSent,
        ...(emailError ? { emailError } : {}),
        email,
        numeroControl,
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

// ─── Auth: Verificar correo con token (Resend) ───────────────────────────────
app.get('/auth/verify-email', async (req, res) => {
  const token = obtenerParametroEntrada(req.query, 'token') || '';
  const email = normalizarEmail(obtenerParametroEntrada(req.query, 'email') || '');

  if (!token || !email) {
    return res.status(400).send(crearHtmlEmailLink({
      titulo: 'Vínculo incompleto',
      mensaje: 'Falta el token o el correo electrónico en el vínculo.',
      exito: false,
    }));
  }

  try {
    const snapshot = await db.collection('email_verifications')
      .where('token', '==', token)
      .where('email', '==', email)
      .where('used', '==', false)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(400).send(crearHtmlEmailLink({
        titulo: 'Vínculo inválido',
        mensaje: 'El token no existe, ya fue utilizado o expiró.',
        exito: false,
      }));
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    if (data.expiresAt && data.expiresAt.toDate() < new Date()) {
      return res.status(400).send(crearHtmlEmailLink({
        titulo: 'Vínculo expirado',
        mensaje: 'El vínculo de verificación expiró. Solicita uno nuevo.',
        exito: false,
      }));
    }

    await doc.ref.update({ used: true, verifiedAt: admin.firestore.FieldValue.serverTimestamp() });

    const userRecord = await admin.auth().getUserByEmail(email);
    if (!userRecord.emailVerified) {
      await admin.auth().updateUser(userRecord.uid, { emailVerified: true });
    }

    await db.collection('usuarios').doc(userRecord.uid).update({
      emailVerified: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).send(crearHtmlEmailLink({
      titulo: 'Correo confirmado',
      mensaje: 'Tu correo institucional fue confirmado correctamente. Ya puedes iniciar sesión.',
      detalle: 'Cierra esta pestaña y entra al sistema con tu número de control y contraseña.',
      exito: true,
    }));
  } catch (err) {
    console.error('Verify email error', err);
    return res.status(500).send(crearHtmlEmailLink({
      titulo: 'Error',
      mensaje: err.message || 'No se pudo verificar el correo.',
      exito: false,
    }));
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

// ─── Pagos: Mercado Pago Checkout Pro ────────────────────────────────────────
app.post('/pagos/mercado-pago/preferencia', async (req, res) => {
  if (!mercadoPagoPreferenceClient) {
    return res.status(500).json({
      error: 'Mercado Pago no está configurado. Falta MERCADOPAGO_ACCESS_TOKEN en el backend.',
    });
  }

  const { evento = {}, cantidad, comprador, correo } = req.body || {};
  const eventoId = String(evento.id || '').trim();
  const nombreEvento = String(evento.nombre || '').trim();
  const costoUnitario = Number(evento.costo);
  const cantidadNumerica = Number(cantidad);
  const compradorNormalizado = String(comprador || '').trim();
  const correoNormalizado = normalizarEmail(correo || '');

  if (!nombreEvento) return res.status(400).json({ error: 'El evento es obligatorio' });
  if (!Number.isFinite(costoUnitario) || costoUnitario <= 0) return res.status(400).json({ error: 'El costo del evento no es válido' });
  if (!Number.isInteger(cantidadNumerica) || cantidadNumerica < 1 || cantidadNumerica > 10) return res.status(400).json({ error: 'La cantidad debe estar entre 1 y 10' });
  if (!compradorNormalizado) return res.status(400).json({ error: 'El nombre del comprador es obligatorio' });
  if (!validarEmailBasico(correoNormalizado)) return res.status(400).json({ error: 'El correo del comprador no es válido' });

  const externalReference = `capitulo-${eventoId || 'evento'}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const retornoFacturacion = `${FRONTEND_PUBLIC_URL}/app/facturacion`;

  try {
    const preferencia = await mercadoPagoPreferenceClient.create({
      body: {
        items: [
          {
            id: eventoId || undefined,
            title: `Asistencia - ${nombreEvento}`,
            description: 'Compra de asistencia para evento del Capítulo ISC',
            quantity: cantidadNumerica,
            unit_price: costoUnitario,
            currency_id: 'MXN',
          },
        ],
        payer: {
          name: compradorNormalizado,
          email: correoNormalizado,
        },
        back_urls: {
          success: `${retornoFacturacion}?estado_pago=aprobado`,
          failure: `${retornoFacturacion}?estado_pago=fallido`,
          pending: `${retornoFacturacion}?estado_pago=pendiente`,
        },
        auto_return: 'approved',
        external_reference: externalReference,
        statement_descriptor: 'CAPITULO ISC',
        metadata: {
          evento_id: eventoId,
          evento_nombre: nombreEvento,
          comprador: compradorNormalizado,
          correo: correoNormalizado,
          cantidad: cantidadNumerica,
          entorno: 'prueba',
        },
      },
    });

    res.status(201).json({
      id: preferencia.id,
      initPoint: preferencia.init_point,
      sandboxInitPoint: preferencia.sandbox_init_point,
      checkoutUrl: preferencia.sandbox_init_point || preferencia.init_point,
      externalReference,
    });
  } catch (err) {
    console.error('Mercado Pago preference error', err);
    res.status(500).json({ error: err.message || 'No se pudo crear la preferencia de Mercado Pago' });
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

// ─── Helpers: compresión de imagen de perfil ────────────────────────────────
const PROFILE_IMAGE_SIZE = Number(process.env.PROFILE_IMAGE_SIZE || 512);
const PROFILE_IMAGE_QUALITY = Number(process.env.PROFILE_IMAGE_QUALITY || 78);

function calcularReduccionPorcentaje(originalSize, compressedSize) {
  if (!originalSize || !compressedSize || compressedSize >= originalSize) return 0;
  return Math.round((1 - compressedSize / originalSize) * 100);
}

async function comprimirImagenPerfil(file) {
  const resultado = await sharp(file.buffer, { failOn: 'none' })
    .rotate()
    .resize({
      width: PROFILE_IMAGE_SIZE,
      height: PROFILE_IMAGE_SIZE,
      fit: 'cover',
      position: 'attention',
    })
    .webp({
      quality: PROFILE_IMAGE_QUALITY,
      effort: 4,
    })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: resultado.data,
    size: resultado.data.length,
    width: resultado.info.width,
    height: resultado.info.height,
    contentType: 'image/webp',
    extension: 'webp',
  };
}

// ─── Backblaze B2: Subir imagen de perfil comprimida ─────────────────────────
app.post('/storage/upload', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibio archivo' });

  if (!req.file.mimetype?.startsWith('image/')) {
    return res.status(400).json({ error: 'Solo se permiten archivos de imagen' });
  }

  console.log('Upload profile image start:', {
    uid: req.firebaseUid,
    name: req.file.originalname,
    originalSize: req.file.size,
    mimeType: req.file.mimetype,
  });

  try {
    const imagenComprimida = await comprimirImagenPerfil(req.file);
    const key = `perfiles/${req.firebaseUid}-${Date.now()}-${crypto.randomUUID()}.${imagenComprimida.extension}`;

    await s3.send(new PutObjectCommand({
      Bucket: B2_BUCKET,
      Key: key,
      Body: imagenComprimida.buffer,
      ContentType: imagenComprimida.contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    const url = `${B2_PUBLIC_BASE_URL}/${key}`;
    const reduccionPorcentaje = calcularReduccionPorcentaje(req.file.size, imagenComprimida.size);

    const docRef = await db.collection('laboratorio_uploads').add({
      tipo: 'foto_perfil',
      uid: req.firebaseUid,
      numeroControl: req.numeroControl,
      key,
      url,
      originalName: req.file.originalname,
      originalMimeType: req.file.mimetype,
      mimeType: imagenComprimida.contentType,
      originalSize: req.file.size,
      compressedSize: imagenComprimida.size,
      reduccionPorcentaje,
      width: imagenComprimida.width,
      height: imagenComprimida.height,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('Profile image uploaded', {
      id: docRef.id,
      url,
      originalSize: req.file.size,
      compressedSize: imagenComprimida.size,
      reduccionPorcentaje,
    });

    res.json({
      key,
      url,
      docId: docRef.id,
      originalSize: req.file.size,
      compressedSize: imagenComprimida.size,
      reduccionPorcentaje,
    });
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

// ─── Manejo de errores de multer ────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'La imagen debe pesar máximo 1 MB' });
  }

  if (err.message === 'Solo se permiten archivos de imagen') {
    return res.status(400).json({ error: err.message });
  }

  next(err);
});

// ─── Servidor ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Puerto: ${PORT}`);
});