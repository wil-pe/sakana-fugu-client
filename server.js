import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import * as XLSX from 'xlsx';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

// pdf-parse is CommonJS. Import the inner module directly to avoid the
// debug self-test that runs when you import the package root.
const require = createRequire(import.meta.url);
let pdfParse = null;
try {
  pdfParse = require('pdf-parse/lib/pdf-parse.js');
} catch (e) {
  console.warn('[warn] pdf-parse indisponible, les PDF ne seront pas lus :', e.message);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.SAKANA_BASE_URL || 'https://api.sakana.ai/v1';
const PORT = process.env.PORT || 3000;
const ENV_KEY = process.env.SAKANA_API_KEY || '';

// Cap on extracted text injected per file (characters). The model has a 1M
// token window, but we keep things sane and predictable.
const MAX_FILE_TEXT_CHARS = 200_000;

const app = express();
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 12 }, // 25 MB / fichier
});

// ---- helpers --------------------------------------------------------------

function resolveKey(req) {
  // .env key wins (kept server-side). Otherwise accept a per-session key
  // sent by the UI so users don't have to edit files.
  return ENV_KEY || req.header('x-sakana-key') || '';
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|tiff)$/i;
const TEXT_LIKE_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.swift', '.sh', '.bash', '.zsh', '.sql', '.toml', '.ini', '.env',
  '.log', '.tex', '.r', '.lua', '.pl', '.dart', '.vue', '.svelte', '.graphql',
]);

function looksTextual(buf) {
  // Heuristic: sample the first 4 KB, reject if it contains a NUL byte or too
  // many non-printable bytes (likely binary).
  const sample = buf.subarray(0, 4096);
  let bad = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / Math.max(sample.length, 1) < 0.1;
}

// Spreadsheets (xlsx/xls/xlsb/ods/…) -> a readable, tab-separated text dump per sheet.
// Powered by SheetJS, which reads a broad range of legacy and modern formats.
function extractSpreadsheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  let sheets = 0;
  for (const name of wb.SheetNames) {
    sheets++;
    const ws = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(ws, { FS: '\t', blankrows: false }).trim();
    parts.push(`## Feuille : ${name}\n${csv}`);
  }
  return { text: parts.join('\n\n').trim(), sheets };
}

// Formats handled by SheetJS that we expose as spreadsheet uploads.
const SPREADSHEET_EXT = new Set([
  '.xlsx', '.xlsm', '.xlsb', '.xls', '.xla', '.ods', '.fods', '.dbf', '.dif', '.prn', '.et', '.numbers',
]);
const SPREADSHEET_MIME = /(spreadsheetml|ms-excel|vnd\.ms-excel|opendocument\.spreadsheet)/i;

function truncate(text, name) {
  if (text.length <= MAX_FILE_TEXT_CHARS) return text;
  return (
    text.slice(0, MAX_FILE_TEXT_CHARS) +
    `\n\n[… fichier "${name}" tronqué à ${MAX_FILE_TEXT_CHARS.toLocaleString('fr-FR')} caractères]`
  );
}

async function processFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype || '';

  // Images -> base64 data URL for the vision input.
  if (IMAGE_MIME.test(mime) || /\.(png|jpe?g|gif|webp|bmp|tiff)$/i.test(ext)) {
    const b64 = file.buffer.toString('base64');
    const safeMime = IMAGE_MIME.test(mime) ? mime : `image/${ext.replace('.', '')}`;
    return {
      kind: 'image',
      name: file.originalname,
      size: file.size,
      dataUrl: `data:${safeMime};base64,${b64}`,
    };
  }

  // PDF -> extracted text.
  if (mime === 'application/pdf' || ext === '.pdf') {
    if (!pdfParse) {
      return { kind: 'error', name: file.originalname, message: 'Lecture PDF indisponible sur ce serveur.' };
    }
    try {
      const data = await pdfParse(file.buffer);
      const text = (data.text || '').trim();
      if (!text) {
        return {
          kind: 'error',
          name: file.originalname,
          message: 'PDF sans texte extractible (probablement scanné/image). Convertissez-le en image pour l’envoyer en vision.',
        };
      }
      return {
        kind: 'text',
        name: file.originalname,
        size: file.size,
        text: truncate(text, file.originalname),
        meta: { pages: data.numpages },
      };
    } catch (e) {
      return { kind: 'error', name: file.originalname, message: 'Échec de lecture du PDF : ' + e.message };
    }
  }

  // Spreadsheets (xlsx, xls, xlsb, ods, …) -> extracted text per sheet.
  if (SPREADSHEET_EXT.has(ext) || SPREADSHEET_MIME.test(mime)) {
    try {
      const { text, sheets } = extractSpreadsheet(file.buffer);
      if (!text) {
        return { kind: 'error', name: file.originalname, message: 'Classeur vide ou sans contenu lisible.' };
      }
      return {
        kind: 'text',
        name: file.originalname,
        size: file.size,
        text: truncate(text, file.originalname),
        meta: { sheets },
      };
    } catch (e) {
      return { kind: 'error', name: file.originalname, message: 'Échec de lecture du classeur : ' + e.message };
    }
  }

  // Text-like files (by extension or content sniffing).
  if (TEXT_LIKE_EXT.has(ext) || mime.startsWith('text/') || looksTextual(file.buffer)) {
    const text = file.buffer.toString('utf8');
    return { kind: 'text', name: file.originalname, size: file.size, text: truncate(text, file.originalname) };
  }

  return {
    kind: 'error',
    name: file.originalname,
    message: `Type non pris en charge (${mime || ext || 'inconnu'}). Formats acceptés : images, PDF, tableurs (xlsx, xls, xlsb, ods…), et fichiers texte/code.`,
  };
}

// ---- routes ---------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasEnvKey: Boolean(ENV_KEY), baseUrl: BASE_URL });
});

// Optional: verify a key actually works against the Sakana API.
app.post('/api/test-key', async (req, res) => {
  const apiKey = resolveKey(req);
  if (!apiKey) return res.status(400).json({ ok: false, error: 'Aucune clé API fournie.' });
  try {
    const client = new OpenAI({ apiKey, baseURL: BASE_URL });
    const models = await client.models.list();
    const ids = (models.data || []).map((m) => m.id);
    res.json({ ok: true, models: ids });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  try {
    const files = req.files || [];
    const results = await Promise.all(files.map(processFile));
    res.json({ files: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const apiKey = resolveKey(req);
  if (!apiKey) {
    return res.status(400).json({ error: 'Clé API manquante. Renseignez SAKANA_API_KEY dans .env ou saisissez-la dans l’interface.' });
  }

  const {
    model = 'fugu',
    effort = 'high',
    webSearch = false,
    instructions = '',
    skills = '',
    maxOutputTokens = null,
    messages = [],
  } = req.body || {};

  // Build the Responses-API `input` array from the UI conversation.
  const input = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.text || '' }] });
      continue;
    }
    // user turn
    const attachments = Array.isArray(m.attachments) ? m.attachments : [];
    let textPart = m.text || '';
    for (const a of attachments) {
      if (a.kind === 'text' && a.text) {
        textPart += `\n\n----- Fichier joint : ${a.name} -----\n${a.text}\n----- Fin : ${a.name} -----`;
      }
    }
    const content = [];
    if (textPart.trim() !== '') content.push({ type: 'input_text', text: textPart });
    for (const a of attachments) {
      if (a.kind === 'image' && a.dataUrl) {
        content.push({ type: 'input_image', image_url: a.dataUrl });
      }
    }
    if (content.length === 0) content.push({ type: 'input_text', text: ' ' });
    input.push({ role: 'user', content });
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const client = new OpenAI({ apiKey, baseURL: BASE_URL });

  const payload = {
    model,
    input,
    reasoning: { effort },
    stream: true,
  };
  const formattedSkills = formatSkills(skills);
  const combinedInstructions = [
    instructions && instructions.trim(),
    formattedSkills
      ? `Skills utilisateur à appliquer pendant toute la conversation :\n${formattedSkills}`
      : '',
  ].filter(Boolean).join('\n\n');
  if (combinedInstructions) payload.instructions = combinedInstructions;
  if (webSearch) payload.tools = [{ type: 'web_search' }];
  if (maxOutputTokens && Number(maxOutputTokens) > 0) payload.max_output_tokens = Number(maxOutputTokens);

  let stream;
  try {
    stream = await client.responses.create(payload);
  } catch (e) {
    send('error', { message: formatApiError(e) });
    return res.end();
  }

  // Abort the upstream request if the client disconnects.
  req.on('close', () => {
    try { stream?.controller?.abort?.(); } catch { /* noop */ }
  });

  try {
    for await (const ev of stream) {
      switch (ev.type) {
        case 'response.output_text.delta':
          send('delta', { text: ev.delta });
          break;
        case 'response.reasoning_summary_text.delta':
          send('reasoning', { text: ev.delta });
          break;
        case 'response.web_search_call.in_progress':
        case 'response.web_search_call.searching':
          send('status', { state: 'web_search', label: 'Recherche web en cours…' });
          break;
        case 'response.web_search_call.completed':
          send('status', { state: 'web_search_done', label: 'Recherche web terminée' });
          break;
        case 'response.completed':
          if (ev.response?.usage) send('usage', { usage: ev.response.usage });
          break;
        case 'response.failed':
        case 'error':
          send('error', { message: ev.response?.error?.message || ev.error?.message || 'Erreur de génération.' });
          break;
        default:
          break;
      }
    }
    send('done', {});
  } catch (e) {
    send('error', { message: formatApiError(e) });
  } finally {
    res.end();
  }
});

function formatSkills(skills) {
  if (Array.isArray(skills)) {
    return skills
      .map((skill, index) => {
        const text = String(skill || '').trim();
        return text ? `Skill ${index + 1}:\n${text}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return String(skills || '').trim();
}

function formatApiError(e) {
  const status = e?.status;
  const base = e?.message || String(e);
  if (status === 401) return 'Clé API invalide ou non autorisée (401). Vérifiez votre clé Sakana.';
  if (status === 429) return 'Limite de débit atteinte ou crédit insuffisant (429).';
  if (status === 404) return 'Modèle ou endpoint introuvable (404). Vérifiez le nom du modèle.';
  if (status) return `Erreur API ${status} : ${base}`;
  return base;
}

app.listen(PORT, () => {
  console.log('\n  Sakana Fugu — client local');
  console.log('  ────────────────────────────');
  console.log(`  ▸ Interface : http://localhost:${PORT}`);
  console.log(`  ▸ API cible : ${BASE_URL}`);
  console.log(`  ▸ Clé .env  : ${ENV_KEY ? 'chargée ✓' : 'absente (saisie possible dans l’UI)'}`);
  console.log('');
});
