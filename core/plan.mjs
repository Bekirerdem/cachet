// Step 2b of a reading: the instructions a person takes home (medicines, follow-ups,
// cautions) pulled out of the copied text. The model may only point at what the text
// states: every entry carries the exact line it came from, and checkPlan() below drops
// nothing silently. An entry whose line is not on the page, or whose medicine, dose or
// date is not inside that line, is reported as a problem and must not be shown.

export const PLAN_SYSTEM = `You pull the instructions out of a medical document that a patient took home, so they can be shown as a checklist.

You receive the text of the document as it was copied from the page. Return only what that text itself states.

Rules:
- "medicines": one entry per medicine the patient is told to take after leaving. "name", "strength", "schedule" and "duration" are copied exactly as printed, in the original language. Use "" for a part the text does not state. Medicines that were only given during the stay are not listed.
- "follow_ups": appointments, checks or tests the text tells the patient to have later. "what" and "when" are copied as printed. Use "" when not stated.
- "cautions": things the text tells the patient to do, to avoid or to watch for, and when to come back or get help. "text" is copied as printed.
- Every entry has "source": the sentence or line of the text that states it, copied character for character.
- Do not add, complete, correct or translate anything. No typical doses, no advice of your own.
- If the text gives no instructions of a kind, return [] for that kind.`;

const entry = (fields) => ({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: [...fields, 'source'],
    properties: Object.fromEntries([...fields, 'source'].map((f) => [f, { type: 'string' }])),
  },
});

export const PLAN_SCHEMA = {
  name: 'home_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['medicines', 'follow_ups', 'cautions'],
    properties: {
      medicines: entry(['name', 'strength', 'schedule', 'duration']),
      follow_ups: entry(['what', 'when']),
      cautions: entry(['text']),
    },
  },
};

export function planRequest({ model, text }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: 4000,
    stream: false,
    response_format: { type: 'json_schema', json_schema: PLAN_SCHEMA },
    messages: [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: text },
    ],
  };
  if (model.startsWith('z-ai/glm')) body.reasoning_effort = 'low';
  else body.chat_template_kwargs = { enable_thinking: false };
  return body;
}

export function parsePlan(content) {
  if (typeof content !== 'string' || content.trim() === '') throw new Error('empty reply');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error('reply is not JSON');
  }
  for (const key of ['medicines', 'follow_ups', 'cautions']) {
    if (!Array.isArray(data[key])) throw new Error(`reply field "${key}" is not a list`);
  }
  return data;
}

// Line breaks and runs of spaces differ between the page and the reply; nothing else may.
const flat = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

const FIELDS = { medicines: ['name', 'strength', 'schedule', 'duration'], follow_ups: ['what', 'when'], cautions: ['text'] };

/**
 * Checks a plan against the page text it was made from. No model is involved.
 * Returns a list of problems; an entry named in a problem must not be shown.
 */
export function checkPlan(plan, pageText) {
  const page = flat(pageText);
  const problems = [];
  for (const [kind, fields] of Object.entries(FIELDS)) {
    plan[kind].forEach((item, i) => {
      const where = `${kind} ${i}`;
      const source = flat(item.source);
      if (source === '' || !page.includes(source)) {
        problems.push(`${where}: its source line is not on the page`);
        return;
      }
      for (const field of fields) {
        const value = flat(item[field]);
        if (value !== '' && !source.includes(value)) problems.push(`${where}: "${field}" is not inside its source line`);
      }
      if (fields.every((field) => flat(item[field]) === '')) problems.push(`${where}: empty entry`);
    });
  }
  return problems;
}

/**
 * "1-0-1" is a fixed notation: how many to take in the morning, at noon, in the evening
 * and, with a fourth number, at night. Code reads it; the model is never asked to.
 * Returns { morning, noon, evening, night, rest } with the counts as printed, or null.
 */
export function readSlots(schedule) {
  const count = '(\\d+(?:[.,/]\\d+)?|½|¼)';
  // not flat(): that would rewrite "½" as "1⁄2"
  const m = String(schedule ?? '').replace(/\s+/g, ' ').trim().match(new RegExp(`^${count}\\s*-\\s*${count}\\s*-\\s*${count}(?:\\s*-\\s*${count})?(?:\\s+(.*))?$`));
  if (!m) return null;
  return { morning: m[1], noon: m[2], evening: m[3], night: m[4] ?? null, rest: m[5] ?? '' };
}

// Step 2c: the checked plan retold in the reader's language.

export const PLAIN_SYSTEM = `You retell a take-home checklist from a medical document in plain words, in the language the reader asks for. The reader has no medical training.

You receive the entries that were copied from the document. Each has an "index" and the "source" line it came from.

Rules:
- Return one entry per input entry, with the same "index", in the same list.
- Medicines: "kind" says in a few words what kind of medicine this is in general (for example: pain reliever, antibiotic, blood pressure medicine). Use "" when you are not sure. "how" retells the schedule and duration exactly as the source line states them. When "slots" is given, the pattern of numbers is shown to the reader separately: do not retell it, retell only what else the line says, or use "".
- Follow-ups and cautions: "plain" retells the source line in everyday words.
- "questions": one short question for the doctor or pharmacist per entry in "open_points" (what the document does not state about a medicine), and nothing else.
- Never write a number that is not in the entry's own source line. Never add advice, reasons, typical doses or warnings of your own. Do not say whether anything is serious.`;

const plainEntry = (fields) => ({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['index', ...fields],
    properties: { index: { type: 'integer' }, ...Object.fromEntries(fields.map((f) => [f, { type: 'string' }])) },
  },
});

export const PLAIN_SCHEMA = {
  name: 'home_plan_plain',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['medicines', 'follow_ups', 'cautions', 'questions'],
    properties: {
      medicines: plainEntry(['kind', 'how']),
      follow_ups: plainEntry(['plain']),
      cautions: plainEntry(['plain']),
      questions: { type: 'array', items: { type: 'string' } },
    },
  },
};

/** What the model is given for the retelling: the checked plan, nothing from outside the page. */
export function plainInput({ plan, language }) {
  const list = (kind) => plan[kind].map((item, index) => ({ index, ...item }));
  return {
    requested_language: language,
    medicines: list('medicines').map((m) => ({ ...m, slots: readSlots(m.schedule) !== null })),
    follow_ups: list('follow_ups'),
    cautions: list('cautions'),
    open_points: openPoints(plan),
  };
}

export function plainRequest({ model, input }) {
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 4000,
    stream: false,
    response_format: { type: 'json_schema', json_schema: PLAIN_SCHEMA },
    messages: [
      { role: 'system', content: PLAIN_SYSTEM },
      { role: 'user', content: JSON.stringify(input) },
    ],
  };
  if (model.startsWith('z-ai/glm')) body.reasoning_effort = 'low';
  else body.chat_template_kwargs = { enable_thinking: false };
  return body;
}

export function parsePlain(content) {
  if (typeof content !== 'string' || content.trim() === '') throw new Error('empty reply');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error('reply is not JSON');
  }
  for (const key of ['medicines', 'follow_ups', 'cautions', 'questions']) {
    if (!Array.isArray(data[key])) throw new Error(`reply field "${key}" is not a list`);
  }
  return data;
}

const numbers = (text) => (flat(text).match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, '.'));

/**
 * Checks the retelling against the plan. No model is involved. Every entry must match
 * one plan entry, and may only contain numbers from that entry's own source line
 * (the parts of a printed date count, so "10.11.2026" may become "10 November 2026").
 */
export function checkPlain(plain, plan) {
  const problems = [];
  const texts = { medicines: (e) => [e.kind, e.how], follow_ups: (e) => [e.plain], cautions: (e) => [e.plain] };
  for (const [kind, parts] of Object.entries(texts)) {
    const seen = new Set();
    for (const e of plain[kind]) {
      const source = plan[kind][e.index];
      if (!source || seen.has(e.index)) {
        problems.push(`${kind} ${e.index}: does not match an entry of the plan`);
        continue;
      }
      seen.add(e.index);
      const allowed = new Set(numbers(source.source));
      for (const n of [...allowed]) if (n.split('.').length >= 3) for (const part of n.split('.')) allowed.add(part);
      for (const n of numbers(parts(e).join(' '))) {
        if (!allowed.has(n)) problems.push(`${kind} ${e.index}: number ${n} is not in its source line`);
      }
    }
    plan[kind].forEach((_, index) => {
      if (!seen.has(index)) problems.push(`${kind} ${index}: not retold`);
    });
  }
  plain.questions.forEach((q, i) => {
    if (numbers(q).length > 0) problems.push(`question ${i}: contains a number`);
  });
  return problems;
}

/** What the page leaves open about a medicine. These become questions for the doctor or pharmacist. */
export function openPoints(plan) {
  const open = [];
  plan.medicines.forEach((m, index) => {
    for (const field of ['strength', 'schedule', 'duration']) {
      if (flat(m[field]) === '') open.push({ index, name: m.name, missing: field });
    }
  });
  return open;
}
