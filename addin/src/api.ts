export interface WordTiming {
  index: number;
  text: string;
  start_ms: number;
  end_ms: number;
  alignment: "phoneme" | "fallback";
}

export interface TtsResponse {
  audio_base64: string;
  mime_type: string;
  duration_ms: number;
  words: WordTiming[];
}

export async function synthesize(
  text: string,
  speed: number
) {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      speed,
    }),
  });

  const p = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw new Error(
      p.detail ||
        `TTS request failed (${r.status})`
    );
  }

  return p as TtsResponse;
}

export async function health() {
  const r = await fetch("/api/health");

  if (!r.ok) {
    throw new Error(
      "خدمة الصوت المحلية غير متاحة."
    );
  }
}

/**
 * بناء SSML مع وقفات طبيعية بين الجمل.
 *
 * - يقسّم النص إلى جمل بناءً على علامات الترقيم
 * - يضيف <break time="250ms"/> بين كل جملتين
 * - يغلّف الكل بـ <speak>
 *
 * Piper يدعم: <speak>, <break>, <prosody> فقط.
 */
function buildSSML(text: string): string {
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  const withBreaks = safe.replace(
    /([.!؟؛۔])\s+/g,
    '$1<break time="250ms"/>'
  );

  return `<speak>${withBreaks}</speak>`;
}

/**
 * توليد صوت مع دعم SSML.
 *
 * عند تفعيل SSML، يُغلّف النص بـ <speak> ويضيف
 * وقفات طبيعية <break> بين الجمل.
 *
 * ملاحظة: سرعة النطق تُتحكم عبر `speed` (وليس
 * عبر <prosody>)، لأن الـBackend يستخدم length_scale.
 */
export async function synthesizeWithSSML(
  text: string,
  speed: number,
  options?: {
    ssml?: boolean;
  }
): Promise<TtsResponse> {
  const useSSML = options?.ssml ?? false;

  const payloadText = useSSML
    ? buildSSML(text)
    : text;

  // === MERTRIC: Fetch timing ===
  const tFetchStart = performance.now();

  const r = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: payloadText,
      speed,
      ssml: useSSML,
    }),
  });

  const tFetchEnd = performance.now();

  const p = await r.json().catch(() => ({}));

  const tParseEnd = performance.now();

  console.log(
    "[AWR]",
    `[PERF] tts: fetch=${(tFetchEnd - tFetchStart).toFixed(0)}ms`,
    `parse=${(tParseEnd - tFetchEnd).toFixed(0)}ms`,
    `status=${r.status}`,
    `audioDuration=${p.duration_ms || "?"}ms`,
    `textLen=${text.length}`,
    `words=${p.words ? p.words.length : "?"}`
  );

  if (!r.ok) {
    throw new Error(
      p.detail ||
        `TTS request failed (${r.status})`
    );
  }

  return p as TtsResponse;
}