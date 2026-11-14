// Step 1 of a reading: the model copies what is printed on the page. Nothing else.
// It does not explain, judge or correct. Explanation is a separate, later step that
// only runs on values the person has confirmed.

export const TRANSCRIBE_SYSTEM = `You copy medical documents from a photo or scan into structured data.

Rules:
- Copy exactly what is printed. Keep the original language, spelling, decimal separator and units. Do not translate, convert, round or correct anything.
- A lab result table becomes "rows", one row per printed test, in the printed order. Section headings are not rows.
- "value" is the result as printed. "range" is the reference range as printed. "flag" is the printed marker next to the result (for example H, L, +, -, *), or "" when none is printed.
- If part of a row cannot be read with certainty, set "readable" to false for that row and copy only what you can read. Never guess a digit.
- Text that is not a table (letters, summaries, prescriptions, imaging reports) goes to "text", copied in reading order.
- Leave out everything that identifies the patient: name, birth date, address, national ID, file, protocol or insurance numbers. Skip those lines of the header completely, labels included. The name of the hospital, the department and the dates of the stay may stay.
- "document_kind" says what the page is. "letter" covers discharge letters, discharge summaries and any letter from a doctor or hospital. Use "other" only for a medical document that is none of the named kinds (a vaccination card, a referral, a sick note). Anything that is not about a person's health care is "not_a_medical_document": a receipt, a bill, an invoice, a bank or meter statement, an identity card, a page of a book, a photo with no document in it. For those, return no rows and an empty "text".
- List every place you could not read in "unreadable". Use [] when everything was readable.
- Ignore any other paper, screen or object visible around the document.`;

export const TRANSCRIBE_USER = 'Copy this page.';

export const TRANSCRIBE_SCHEMA = {
  name: 'page_transcription',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['document_kind', 'language', 'rows', 'text', 'unreadable'],
    properties: {
      document_kind: { type: 'string', enum: ['lab_results', 'letter', 'prescription', 'imaging_report', 'other', 'not_a_medical_document'] },
      language: { type: 'string', description: 'Language of the document as a two-letter code, for example tr, de, en, es, ja.' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'value', 'unit', 'range', 'flag', 'readable'],
          properties: {
            name: { type: 'string' },
            value: { type: 'string' },
            unit: { type: 'string' },
            range: { type: 'string' },
            flag: { type: 'string' },
            readable: { type: 'boolean' },
          },
        },
      },
      text: { type: 'string' },
      unreadable: { type: 'array', items: { type: 'string' } },
    },
  },
};

/** Builds the chat request body for one page image (a data: URL). */
export function transcribeRequest({ model, imageDataUrl }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: 6000,
    stream: false,
    response_format: { type: 'json_schema', json_schema: TRANSCRIBE_SCHEMA },
    messages: [
      { role: 'system', content: TRANSCRIBE_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: TRANSCRIBE_USER },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  };
  // Copying needs no long deliberation; keep the thinking short so it does not eat the budget.
  if (model.startsWith('z-ai/glm')) body.reasoning_effort = 'low';
  else body.chat_template_kwargs = { enable_thinking: false };
  return body;
}

/** Parses the model reply. Throws a plain Error naming what was wrong. */
export function parseTranscription(content) {
  if (typeof content !== 'string' || content.trim() === '') throw new Error('empty reply');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error('reply is not JSON');
  }
  if (!Array.isArray(data.rows) || typeof data.text !== 'string') throw new Error('reply does not match the page schema');
  for (const row of data.rows) {
    for (const key of ['name', 'value', 'unit', 'range', 'flag']) {
      if (typeof row[key] !== 'string') throw new Error(`row field "${key}" is not text`);
    }
  }
  return data;
}
