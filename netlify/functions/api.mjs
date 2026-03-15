import Anthropic from '@anthropic-ai/sdk';
import { getStore } from '@netlify/blobs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Helpers ─────────────────────────────────────────────────────
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateCode = (len = 6) =>
  Array.from({ length: len }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');

const jsonResp = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });

// ─── Blob storage helpers ─────────────────────────────────────────
const exercisesStore = () => getStore({ name: 'exercises', consistency: 'strong' });
const indexStore    = () => getStore({ name: 'idx',       consistency: 'strong' });

function verifyAdmin(req) {
  const pw = req.headers.get('x-admin-password');
  return pw && process.env.ADMIN_PASSWORD && pw === process.env.ADMIN_PASSWORD;
}

async function getExerciseByAdminCode(adminCode) {
  const exerciseId = await indexStore().get(`admin:${adminCode}`, { type: 'text' });
  if (!exerciseId) return null;
  return exercisesStore().get(exerciseId, { type: 'json' });
}

async function getExerciseById(exerciseId) {
  return exercisesStore().get(exerciseId, { type: 'json' });
}

async function saveExercise(exercise) {
  await exercisesStore().setJSON(exercise.id, exercise);
}

async function getGroupInfo(code) {
  const ref = await indexStore().get(`group:${code}`, { type: 'json' });
  if (!ref) return null;
  const exercise = await getExerciseById(ref.exerciseId);
  if (!exercise) return null;
  const group = exercise.groups.find(g => g.id === ref.groupId);
  if (!group) return null;
  return {
    exerciseId: exercise.id,
    exerciseTitle: exercise.title,
    exerciseDescription: exercise.description,
    exerciseLogo: exercise.logo || null,
    group,
    hasResponse: !!(exercise.responses?.[group.id])
  };
}

// ─── Main handler ─────────────────────────────────────────────────
export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  const url    = new URL(req.url);
  const path   = url.pathname;
  const method = req.method;

  try {
    // ── POST /api/exercises ──────────────────────────────────────
    if (path === '/api/exercises' && method === 'POST') {
      const { title, description, groups, logo } = await req.json();
      if (!title || !groups?.length)
        return jsonResp({ error: 'Missing required fields' }, 400);

      const exerciseId = crypto.randomUUID();
      const adminCode  = generateCode();

      const processedGroups = groups.map(g => ({
        id:          crypto.randomUUID(),
        name:        g.name,
        description: g.description || '',
        perspective: g.perspective,
        code:        generateCode()
      }));

      const exercise = {
        id: exerciseId, title, description: description || '',
        adminCode, groups: processedGroups, responses: {}, analysis: null,
        logo: logo || null,
        createdAt: new Date().toISOString()
      };

      await saveExercise(exercise);

      const idx = indexStore();
      await idx.set(`admin:${adminCode}`, exerciseId);
      for (const g of processedGroups) {
        await idx.setJSON(`group:${g.code}`, { exerciseId, groupId: g.id });
      }

      return jsonResp({
        exerciseId, adminCode,
        groups: processedGroups.map(g => ({ id: g.id, name: g.name, code: g.code }))
      });
    }

    // ── GET /api/admin/:code ─────────────────────────────────────
    const adminMatch   = path.match(/^\/api\/admin\/([A-Z0-9]+)$/);
    const analyzeMatch = path.match(/^\/api\/admin\/([A-Z0-9]+)\/analyze$/);

    if (adminMatch && method === 'GET') {
      const exercise = await getExerciseByAdminCode(adminMatch[1]);
      if (!exercise) return jsonResp({ error: 'Exercise not found' }, 404);
      return jsonResp(exercise);
    }

    // ── POST /api/admin/:code/analyze ────────────────────────────
    if (analyzeMatch && method === 'POST') {
      console.log('[analyze] hit, code:', analyzeMatch[1]);
      const exercise = await getExerciseByAdminCode(analyzeMatch[1]);
      if (!exercise) return jsonResp({ error: 'Exercise not found' }, 404);

      const groupResponses = exercise.groups
        .filter(g => exercise.responses?.[g.id])
        .map(g => ({
          groupName:   g.name,
          perspective: g.description,
          answers:     exercise.responses[g.id].answers
        }));

      if (!groupResponses.length)
        return jsonResp({ error: 'No responses yet' }, 400);

      const model = process.env.ANALYSIS_MODEL || 'claude-haiku-4-5-20251001';
      console.log('[analyze] calling Anthropic, model:', model, 'responses:', groupResponses.length);
      const message = await anthropic.messages.create({
        model,
        max_tokens: 1500,
        messages:   [{ role: 'user', content: buildAnalysisPrompt(exercise, groupResponses) }]
      });

      const analysisContent = message.content[0].text;
      exercise.analysis = { content: analysisContent, generatedAt: new Date().toISOString() };
      await saveExercise(exercise);

      // Return as SSE format so the browser's existing stream reader works unchanged
      const sseBody =
        `data: ${JSON.stringify({ chunk: analysisContent })}\n\n` +
        `data: ${JSON.stringify({ done:  true          })}\n\n`;

      return new Response(sseBody, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ── GET /api/group/:code ─────────────────────────────────────
    const groupMatch = path.match(/^\/api\/group\/([A-Z0-9]+)$/);
    if (groupMatch && method === 'GET') {
      const info = await getGroupInfo(groupMatch[1]);
      if (!info) return jsonResp({ error: 'Code not found' }, 404);
      return jsonResp(info);
    }

    // ── POST /api/responses ──────────────────────────────────────
    if (path === '/api/responses' && method === 'POST') {
      const { exerciseId, groupId, answers } = await req.json();
      const exercise = await getExerciseById(exerciseId);
      if (!exercise) return jsonResp({ error: 'Exercise not found' }, 404);

      exercise.responses          = exercise.responses || {};
      exercise.responses[groupId] = { answers, submittedAt: new Date().toISOString() };
      await saveExercise(exercise);

      return jsonResp({ success: true });
    }

    // ── GET /api/global-admin/exercises ──────────────────────────
    if (path === '/api/global-admin/exercises' && method === 'GET') {
      if (!verifyAdmin(req)) return jsonResp({ error: 'Unauthorized' }, 401);
      const { blobs } = await exercisesStore().list();
      const exercises = await Promise.all(blobs.map(b => exercisesStore().get(b.key, { type: 'json' })));
      const summary = exercises.filter(Boolean).map(ex => ({
        id: ex.id,
        title: ex.title,
        adminCode: ex.adminCode,
        createdAt: ex.createdAt,
        groups: ex.groups.length,
        responses: Object.keys(ex.responses || {}).length,
        hasAnalysis: !!ex.analysis,
        logo: ex.logo || null
      }));
      summary.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return jsonResp(summary);
    }

    // ── DELETE /api/global-admin/exercises/:id ────────────────────
    const gaDeleteMatch = path.match(/^\/api\/global-admin\/exercises\/([^/]+)$/);
    if (gaDeleteMatch && method === 'DELETE') {
      if (!verifyAdmin(req)) return jsonResp({ error: 'Unauthorized' }, 401);
      const exercise = await getExerciseById(gaDeleteMatch[1]);
      if (!exercise) return jsonResp({ error: 'Not found' }, 404);
      await exercisesStore().delete(gaDeleteMatch[1]);
      await indexStore().delete(`admin:${exercise.adminCode}`);
      for (const g of exercise.groups) {
        await indexStore().delete(`group:${g.code}`);
      }
      return jsonResp({ success: true });
    }

    return jsonResp({ error: 'Not found' }, 404);

  } catch (err) {
    console.error('API error:', err.message, err.status, err.constructor?.name);
    return jsonResp({ error: err.message }, 500);
  }
};

// Register this function for all /api/* paths — no redirect rules needed
export const config = {
  path: '/api/*'
};

// ─── Analysis prompt ──────────────────────────────────────────────
function buildAnalysisPrompt(exercise, groupResponses) {
  return `אתה מנחה בכיר של תהליכי פיתוח מנהיגות. תפקידך אינו לתת תשובות — תפקידך להציף מורכבות, לחשוף מתחים, ולייצר חומר שידלק דיון עמוק בקרב קבוצת מנהלים.

**שם התרגיל:** ${exercise.title}
${exercise.description ? `**הקשר:** ${exercise.description}` : ''}

**תשובות הקבוצות:**
${groupResponses.map((gr, i) => `
### קבוצה ${i + 1}: ${gr.groupName}
${gr.perspective ? `**מי הם:** ${gr.perspective}` : ''}

**מה זה מנהל מצטיין בעיניהם:**
${gr.answers.excellentManager}

**מה הכי חשוב להם:**
${gr.answers.mostImportant}

**מה נדרש מהמנהל:**
${gr.answers.requirements}
${gr.answers.additional ? `\n**הערות נוספות:** ${gr.answers.additional}` : ''}
`).join('\n---\n')}

---

**המשימה שלך:** צור ניתוח ממוקד שנועד להניע דיון, לא לסכם. אל תיתן פתרונות. חשוף מה קשה, מה סותר, מה מורכב.

## ⚡ צירי המתח המרכזיים
זהה 3–4 מתחים אמיתיים שעולים מהשוואת הנקודות — לא סתירות תיאורטיות, אלא מתחים חיים שמנהל פוגש יום-יום. לכל ציר: מנסח את שני הקטבים המנוגדים, ומסביר מה הופך אותו לאתגר בלתי-פתיר שדורש ניווט מתמיד — לא פתרון.

## 🔍 מה כל עין רואה — ומה היא מפספסת
לכל קבוצה בנפרד: מה הפרספקטיבה הייחודית שלה שהאחרות לא רואות? ומה "עיוורת" אליה כתוצאה מהמיקוד הזה?

## 💥 הפרדוקס הליבתי
מהו הפרדוקס העמוק ביותר שמנהל חייב לחיות איתו — מנוסח כמתח שאי-אפשר לפתור, רק לנווט? נסח אותו בחדות, ללא עמעום.

## ❓ שאלות לדיון קבוצתי
5–6 שאלות פתוחות וחדות שעולות ישירות מהנתונים. השאלות צריכות להיות מאתגרות, לא רטוריות — שאלות שאין להן תשובה נכונה אחת, ושמנהל חכם יתמודד איתן לאורך כל הקריירה.

כתוב בעברית ישירה ותכליתית. השתמש בדוגמאות ספציפיות מהתשובות. קצר ומדויק עדיף על ארוך ומנופח.`;
}
