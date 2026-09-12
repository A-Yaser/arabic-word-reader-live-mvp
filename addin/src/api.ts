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