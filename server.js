require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Data helpers ───────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { exercises: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return { exercises: {} }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── API Routes ──────────────────────────────────────────────────

// Create exercise
app.post('/api/exercises', (req, res) => {
  const { title, description, groups } = req.body;
  if (!title || !groups || groups.length === 0)
    return res.status(400).json({ error: 'Missing required fields' });

  const data = loadData();
  const exerciseId = uuidv4();
  const adminCode = generateCode();

  const processedGroups = groups.map(g => ({
    id: uuidv4(),
    name: g.name,
    description: g.description || '',
    perspective: g.perspective,
    code: generateCode()
  }));

  data.exercises[exerciseId] = {
    id: exerciseId,
    title,
    description: description || '',
    adminCode,
    groups: processedGroups,
    responses: {},
    analysis: null,
    createdAt: new Date().toISOString()
  };

  saveData(data);
  res.json({ exerciseId, adminCode, groups: processedGroups.map(g => ({ id: g.id, name: g.name, code: g.code })) });
});

// Admin – get exercise data
app.get('/api/admin/:adminCode', (req, res) => {
  const data = loadData();
  const exercise = Object.values(data.exercises).find(e => e.adminCode === req.params.adminCode);
  if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
  res.json(exercise);
});

// Group – lookup by code
app.get('/api/group/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const data = loadData();
  for (const exercise of Object.values(data.exercises)) {
    const group = exercise.groups.find(g => g.code === code);
    if (group) {
      return res.json({
        exerciseId: exercise.id,
        exerciseTitle: exercise.title,
        exerciseDescription: exercise.description,
        group,
        hasResponse: !!exercise.responses[group.id]
      });
    }
  }
  res.status(404).json({ error: 'Code not found' });
});

// Submit group response
app.post('/api/responses', (req, res) => {
  const { exerciseId, groupId, answers } = req.body;
  const data = loadData();
  const exercise = data.exercises[exerciseId];
  if (!exercise) return res.status(404).json({ error: 'Exercise not found' });

  exercise.responses[groupId] = { answers, submittedAt: new Date().toISOString() };
  saveData(data);
  res.json({ success: true });
});

// Admin – trigger AI analysis (streaming response to avoid timeouts)
app.post('/api/admin/:adminCode/analyze', async (req, res) => {
  const data = loadData();
  const exercise = Object.values(data.exercises).find(e => e.adminCode === req.params.adminCode);
  if (!exercise) return res.status(404).json({ error: 'Exercise not found' });

  const groupResponses = exercise.groups
    .filter(g => exercise.responses[g.id])
    .map(g => ({ groupName: g.name, perspective: g.description, answers: exercise.responses[g.id].answers }));

  if (groupResponses.length === 0)
    return res.status(400).json({ error: 'No responses yet' });

  const prompt = buildAnalysisPrompt(exercise, groupResponses);

  // Set SSE headers so the browser gets chunks as they arrive
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullText = '';

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }]
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text;
        res.write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
      }
    }

    // Save analysis
    const reloaded = loadData();
    const ex = Object.values(reloaded.exercises).find(e => e.adminCode === req.params.adminCode);
    if (ex) {
      ex.analysis = { content: fullText, generatedAt: new Date().toISOString() };
      saveData(reloaded);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Claude API error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── Analysis prompt builder ─────────────────────────────────────
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

**המשימה שלך:** זהה 3 צירי מתח מרכזיים שעולים מהשוואת תשובות הקבוצות.

**הנחיות קפדניות:**
1. הוצא ONLY JSON בתוך triple backticks
2. כל שדה בstring תקין (אין newlines, אין HTML, אין emojis)
3. לכל ציר: title, description, 4 questions עם text ו-targetGroup

**תבנית (תעתק אותה בדיוק):**

\`\`\`json
{
  "tensions": [
    {
      "id": 1,
      "title": "זהוי של שני קטבים",
      "description": "משפט אחד המתאר את המתח",
      "questions": [
        {
          "text": "שאלה ראשונה לכלל הקבוצות",
          "target": "all"
        },
        {
          "text": "שאלה שנייה לקבוצה ראשונה",
          "target": "group1"
        },
        {
          "text": "שאלה שלישית לקבוצה שנייה",
          "target": "group2"
        },
        {
          "text": "שאלה רביעית לכלל הקבוצות",
          "target": "all"
        }
      ]
    }
  ]
}
\`\`\`

**כללי יצירת תוכן:**
- title: 4-5 מילים בלבד, מתח בין שני קטבים
- description: משפט קצר, ללא נקודה בסוף
- כל question: עד 20 מילים, שאלה פתוחה שמדלקת דיון
- target: "all" או "group1" או "group2" או "group3" (תלבד בכמות הקבוצות)

**DEF אל תוסף:**
- emojis, HTML, markdown
- newlines פנימיים בשדות
- סוגריים מסולסלים או מרובעים מעבר ל-JSON

**אחרי הניתוח - יציאה:**
אחרי ה-JSON, אתה יכול לכתוב שורה אחת: "Done"`;
}

// ─── Serve SPA ───────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅  שרת פועל: http://localhost:${PORT}`);
  console.log(`   ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓ מוגדר' : '✗ חסר!'}\n`);
});
