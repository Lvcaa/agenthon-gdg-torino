const DEFAULT_MODEL = "gemini-3-flash-preview";
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateJson(prompt: string, system?: string): Promise<unknown> {
  const key = process.env.GEMINI_GDG_KEY;
  if (!key) throw new Error("GEMINI_GDG_KEY mancante in .env.local");
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  };

  // 503/429 sono picchi temporanei: riprova con backoff (1s, 2s, 4s).
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    const body = await res.json();
    if (res.ok) {
      const text: string | undefined = body?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Risposta Gemini vuota");
      return JSON.parse(text);
    }
    const retryable = res.status === 503 || res.status === 429;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Gemini ${res.status} (${model}, tentativo ${attempt}): ${body?.error?.message ?? "errore"}`);
    }
    await sleep(1000 * 2 ** (attempt - 1));
  }
}
