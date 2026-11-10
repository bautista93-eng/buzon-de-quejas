/**
 * Cloudflare Pages Function — /api/quejas
 *
 * POST: recibe { texto, categoria }, pide a Workers AI una prioridad
 *       ("alta" | "media" | "baja") y guarda la queja en D1 (env.DB).
 *       Si la IA falla o no hay binding, usa heurística por palabras clave.
 * GET:  devuelve las quejas en JSON, ordenadas por prioridad y fecha.
 *
 * Bindings esperados:
 *   env.DB -> D1 database
 *   env.AI -> Workers AI (opcional, con fallback por palabras clave)
 */

const MAX_LEN = 500;
const PRIORITIES = ['alta', 'media', 'baja'];
const PRIORITY_ORDER = { alta: 0, media: 1, baja: 2 };
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

const KEYWORDS = {
  alta: [
    'peligro', 'peligroso', 'peligrosa', 'urgente', 'emergencia', 'emergencias',
    'inseguridad', 'robo', 'robaron', 'asalto', 'asalto', 'violencia', 'agresión',
    'agresion', 'golpe', 'golpes', 'amenaza', 'amenazas', 'arma', 'incendio', 'fuego',
    'humo', 'inundación', 'inundacion', 'inundado', 'fuga de gas', 'gas', 'electrocución',
    'electrocucion', 'cables pelados', 'cable pelado', 'cortocircuito', 'derrumbe',
    'se derrumbó', 'se derrumbo', 'vidrio roto', 'ascensor roto', 'ascensor trabado',
    'persona atrapada', 'atrapado', 'atrapada', 'sin luz', 'sin agua', 'inundación',
    'discriminación', 'discriminacion', 'acoso', 'abuso', 'maltrato', 'violación', 'violacion'
  ],
  media: [
    'no funciona', 'roto', 'rota', 'falla', 'fallando', 'desperfecto', 'problema',
    'problemas', 'ruido', 'ruidos', 'molestia', 'molesto', 'sucio', 'suciedad',
    'basura', 'olor', 'olores', 'humedad', 'filtración', 'filtracion', 'pérdida de agua',
    'perdida de agua', 'gotera', 'puerta', 'cerradura', 'ventana', 'luz quemada',
    'lámpara', 'lampara', 'timbre', 'interruptor', 'enchufe', 'calefacción', 'calefaccion',
    'aire acondicionado', 'calentador', 'demora', 'demoras', 'tardanza', 'incumplimiento'
  ]
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra
    }
  });
}

function dbError() {
  return json({
    error: 'Falta el binding de base de datos (env.DB). Configurá una base D1 en Cloudflare Pages y volvé a desplegar.',
    code: 'DB_BINDING_MISSING'
  }, 500);
}

function normalizePriority(raw) {
  const s = String(raw == null ? '' : raw).toLowerCase();
  for (const p of PRIORITIES) {
    if (s.includes(p)) return p;
  }
  return null;
}

/** Heurística por palabras clave cuando la IA no está disponible o falla. */
function keywordPriority(texto) {
  const t = ' ' + texto.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') + ' ';

  let altaHits = 0;
  for (const w of KEYWORDS.alta) {
    const needle = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.includes(needle)) altaHits++;
  }
  if (altaHits > 0) return 'alta';

  let mediaHits = 0;
  for (const w of KEYWORDS.media) {
    const needle = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.includes(needle)) mediaHits++;
  }
  if (mediaHits > 0) return 'media';

  return 'baja';
}

async function aiPriority(env, texto, categoria) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') return null;

  const system =
    'Sos un clasificador de quejas de un edificio o grupo. ' +
    'Respondé ÚNICAMENTE con una de estas tres palabras, en minúsculas y sin puntuación: ' +
    'alta, media o baja. ' +
    'alta = riesgo para la seguridad, salud o integridad, o emergencia. ' +
    'media = falla o molestia que afecta la vida diaria pero no es urgente. ' +
    'baja = sugerencia, queja menor o estética. ' +
    'No agregues explicaciones ni texto adicional.';

  const user =
    'Categoría: ' + categoria + '\n' +
    'Queja: ' + texto + '\n\n' +
    'Prioridad:';

  try {
    const out = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      max_tokens: 8,
      temperature: 0
    });

    let text = '';
    if (typeof out === 'string') {
      text = out;
    } else if (out && typeof out.response === 'string') {
      text = out.response;
    } else if (out && typeof out.result === 'string') {
      text = out.result;
    } else if (out && out.choices && out.choices[0] && out.choices[0].message) {
      text = out.choices[0].message.content || '';
    }

    return normalizePriority(text);
  } catch (err) {
    console.error('Workers AI falló, usando palabras clave:', err && err.message ? err.message : err);
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.DB) return dbError();

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'El cuerpo debe ser JSON válido.' }, 400);
  }

  const rawTexto = typeof body?.texto === 'string' ? body.texto : '';
  const texto = rawTexto.trim();
  const categoria = (typeof body?.categoria === 'string' ? body.categoria.trim() : '') || 'Otro';

  if (texto.length < 5) {
    return json({ error: 'La queja debe tener al menos 5 caracteres.' }, 400);
  }
  if (texto.length > MAX_LEN) {
    return json({ error: `La queja no puede superar los ${MAX_LEN} caracteres.` }, 400);
  }
  if (categoria.length > 60) {
    return json({ error: 'Categoría inválida.' }, 400);
  }

  let prioridad = await aiPriority(env, texto, categoria);
  let fuente = 'ia';
  if (!prioridad) {
    prioridad = keywordPriority(texto);
    fuente = 'palabras-clave';
  }

  const creada = new Date().toISOString();

  try {
    const result = await env.DB.prepare(
      'INSERT INTO quejas (texto, categoria, prioridad, creada) VALUES (?, ?, ?, ?)'
    ).bind(texto, categoria, prioridad, creada).run();

    return json({
      ok: true,
      id: result?.meta?.last_row_id ?? null,
      prioridad,
      fuente,
      creada
    }, 201);
  } catch (err) {
    console.error('Error guardando en D1:', err);
    const hint = /no such table/i.test(String(err && err.message))
      ? 'La tabla "quejas" no existe. Ejecutá schema.sql en tu base D1.'
      : 'No se pudo guardar la queja.';
    return json({ error: hint, code: 'DB_WRITE_FAILED' }, 500);
  }
}

export async function onRequestGet({ env }) {
  if (!env || !env.DB) return dbError();

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, texto, categoria, prioridad, creada
         FROM quejas
        ORDER BY CASE LOWER(prioridad)
                   WHEN 'alta'  THEN 0
                   WHEN 'media' THEN 1
                   WHEN 'baja'  THEN 2
                   ELSE 3
                 END ASC,
                 datetime(creada) DESC,
                 id DESC`
    ).all();

    const quejas = (results || []).map((r) => ({
      id: r.id,
      texto: r.texto,
      categoria: r.categoria,
      prioridad: normalizePriority(r.prioridad) || 'baja',
      creada: r.creada
    }));

    // Respaldo de orden en JS (por si el driver devolviera distinto).
    quejas.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.prioridad] ?? 3;
      const pb = PRIORITY_ORDER[b.prioridad] ?? 3;
      if (pa !== pb) return pa - pb;
      return new Date(b.creada || 0) - new Date(a.creada || 0);
    });

    return json(quejas, 200);
  } catch (err) {
    console.error('Error leyendo de D1:', err);
    const hint = /no such table/i.test(String(err && err.message))
      ? 'La tabla "quejas" no existe. Ejecutá schema.sql en tu base D1.'
      : 'No se pudieron obtener las quejas.';
    return json({ error: hint, code: 'DB_READ_FAILED' }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { Allow: 'GET, POST, OPTIONS' }
  });
}

// Cualquier otro método.
export async function onRequest({ request }) {
  return json({ error: `Método ${request.method} no permitido. Usá GET o POST.` }, 405, {
    Allow: 'GET, POST, OPTIONS'
  });
}
