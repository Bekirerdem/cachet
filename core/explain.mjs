// Step 2 of a reading: the model explains what the person has already confirmed.
// It never decides whether a value is inside its range (core/ranges.mjs does), and
// checkExplanation() below rejects any number that is not printed on the page.

export const LANGUAGES = {
  tr: 'Turkish',
  en: 'English',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  ar: 'Arabic',
  ru: 'Russian',
  ja: 'Japanese',
};

export const EXPLAIN_SYSTEM = `You explain a medical document to the person it belongs to, in plain words, in the language they ask for.

You receive what is printed on the page, already checked by the person. For each lab row you also receive "placement": where the value sits against the range printed on the same page ("in", "above", "below", "edge" when it is exactly on a printed limit, or "unknown" when the page gives no usable range). The placement was computed separately. Never contradict it and never decide it yourself.

Rules:
- Write everything in the requested language for a reader with no medical training. Short sentences, everyday words.
- Lab rows: return one entry per input row with the same "index". "plain_name" is the everyday name of the test in the requested language. "what_it_is" says in one sentence what the test measures. "note" is "" for rows placed "in", "edge" or "unknown"; for "above" or "below" it says in one or two sentences what results on that side are commonly associated with in general, worded as possibilities, never as a statement about this person.
- Letters, reports and prescriptions: return "sections", each with the printed heading translated and the content retold plainly in the requested language, keeping every fact, date, medicine and dose exactly as printed. "terms" explains the medical words that appear.
- No diagnosis. Do not say the person has or does not have a condition unless the document itself says so; then say that the document states it.
- No treatment advice. Never suggest starting, stopping or changing a medicine, dose, diet or supplement. A medicine printed in the document may be described: what kind of medicine it is and the schedule as printed.
- Never write a number that is not printed in the input. No typical values, no other ranges, no unit conversions, no statistics. Write small counts as words.
- Do not judge severity or urgency. No "nothing to worry about", no "dangerous".
- "questions" are 3 to 6 specific questions the person could ask their doctor about this document. Ask about what the document leaves open or mentions without explaining. Never ask whether a printed instruction (a dose, a schedule, an end date) should be changed, extended or stopped.
- "summary" is two or three sentences on what kind of document this is and what it covers. No names, no identifiers.`;

export const EXPLAIN_SCHEMA = {
  name: 'document_explanation',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'rows', 'sections', 'terms', 'questions'],
    properties: {
      summary: { type: 'string' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'plain_name', 'what_it_is', 'note'],
          properties: {
            index: { type: 'integer' },
            plain_name: { type: 'string' },
            what_it_is: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'plain'],
          properties: { title: { type: 'string' }, plain: { type: 'string' } },
        },
      },
      terms: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['term', 'meaning'],
          properties: { term: { type: 'string' }, meaning: { type: 'string' } },
        },
      },
      questions: { type: 'array', items: { type: 'string' } },
    },
  },
};

/** What the model is given: confirmed page content plus the placement computed in code. */
export function explainInput({ page, placements, targetLanguage }) {
  return {
    requested_language: LANGUAGES[targetLanguage] ?? targetLanguage,
    document_kind: page.document_kind,
    document_language: page.language,
    rows: page.rows.map((r, index) => ({ index, name: r.name, value: r.value, unit: r.unit, range: r.range, placement: placements[index] ?? 'unknown' })),
    text: page.text,
  };
}

export function explainRequest({ model, input }) {
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 6000,
    stream: false,
    response_format: { type: 'json_schema', json_schema: EXPLAIN_SCHEMA },
    messages: [
      { role: 'system', content: EXPLAIN_SYSTEM },
      { role: 'user', content: JSON.stringify(input) },
    ],
  };
  if (model.startsWith('z-ai/glm')) body.reasoning_effort = 'low';
  else body.chat_template_kwargs = { enable_thinking: false };
  return body;
}

export function parseExplanation(content) {
  if (typeof content !== 'string' || content.trim() === '') throw new Error('empty reply');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error('reply is not JSON');
  }
  for (const key of ['rows', 'sections', 'terms', 'questions']) {
    if (!Array.isArray(data[key])) throw new Error(`reply field "${key}" is not a list`);
  }
  if (typeof data.summary !== 'string') throw new Error('reply has no summary');
  return data;
}

const numbersIn = (text) => (String(text ?? '').normalize('NFKC').match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, '.'));

/**
 * Checks an explanation against what it was given. Returns a list of problems;
 * an empty list means it may be shown. No model is involved in this check.
 */
export function checkExplanation(explanation, input) {
  const problems = [];
  const printed = new Set(numbersIn(JSON.stringify([input.rows.map((r) => [r.name, r.value, r.unit, r.range]), input.text])));
  // A printed date may be retold with its month as a word ("10.11.2026" -> "10 November 2026"),
  // so the parts of a date count as printed. Plain decimals are not split.
  for (const n of [...printed]) {
    const parts = n.split('.');
    if (parts.length >= 3) for (const part of parts) printed.add(part);
  }

  const fields = [
    ['summary', explanation.summary],
    ...explanation.rows.flatMap((r) => [[`row ${r.index} name`, r.plain_name], [`row ${r.index} what`, r.what_it_is], [`row ${r.index} note`, r.note]]),
    ...explanation.sections.flatMap((s, i) => [[`section ${i} title`, s.title], [`section ${i}`, s.plain]]),
    ...explanation.terms.flatMap((t, i) => [[`term ${i}`, t.term], [`term ${i} meaning`, t.meaning]]),
    ...explanation.questions.map((q, i) => [`question ${i}`, q]),
  ];
  for (const [where, text] of fields) {
    for (const n of numbersIn(text)) {
      if (!printed.has(n)) problems.push(`${where}: number ${n} is not printed on the page`);
    }
  }

  const seen = new Set();
  for (const r of explanation.rows) {
    const source = input.rows[r.index];
    if (!source || seen.has(r.index)) {
      problems.push(`row ${r.index}: does not match a row on the page`);
      continue;
    }
    seen.add(r.index);
    const outside = source.placement === 'above' || source.placement === 'below';
    if (!outside && r.note.trim() !== '') problems.push(`row ${r.index}: has a note although the value is not outside its printed range`);
  }
  for (const r of input.rows) if (!seen.has(r.index)) problems.push(`row ${r.index}: no explanation returned`);
  return problems;
}
