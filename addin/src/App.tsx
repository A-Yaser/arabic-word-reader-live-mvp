import { useEffect, useRef, useState } from "react";

import {
  health,
  synthesize,
  type TtsResponse,
  type WordTiming,
} from "./api";

import {
  clearPlayback,
  occurrence,
  prepareReadingPosition,
  updateWordHighlight,
} from "./word";

import "./styles.css";

const log = (...args: unknown[]) =>
  console.log("[AWR]", ...args);

function blob(base64: string, mime: string) {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);

  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));

  return `${Math.floor(
    value / 60
  )}:${String(value % 60).padStart(2, "0")}`;
}

export default function App() {
  const audioRef =
    useRef<HTMLAudioElement | null>(null);

  const animationRef =
    useRef<number | null>(null);

  const bookmarkRef =
    useRef<string | null>(null);

  const chunksRef =
    useRef<string[]>([]);

  const responsesRef =
    useRef<Array<TtsResponse | null>>([]);

  const pendingRef =
    useRef<Map<number, Promise<TtsResponse>>>(
      new Map()
    );

  const currentChunkRef = useRef(0);
  const sessionRef = useRef(0);
  const playingRef = useRef(false);
  const busyRef = useRef(false);

  const selectionTimerRef =
    useRef<number | null>(null);

  const suppressSelectionRef =
    useRef(false);

  const lastWordIndexRef = useRef(-1);

  const latestWordIndexRef = useRef(-1);

  const previousWordRef =
    useRef<{
      text: string;
      occurrence: number;
    } | null>(null);

  const spokenTokensRef =
    useRef<string[]>([]);

  const highlightQueueRef =
    useRef<Promise<void>>(
      Promise.resolve()
    );

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] =
    useState(false);
  const [hasSession, setHasSession] =
    useState(false);
  const [speed, setSpeed] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] =
    useState(0);

  const [status, setStatus] = useState(
    "ضع مؤشر الكتابة في المكان المطلوب ثم اضغط «ابدأ من المؤشر»"
  );

  const [current, setCurrent] = useState("");
  const [error, setError] = useState("");
  const [debugLog, setDebugLog] = useState<
    string[]
  >([]);

  // ─────────────────────────────────────────
  // التقاط سطور [AWR] لعرضها داخل الواجهة
  // ─────────────────────────────────────────
  useEffect(() => {
    const orig = console.log;

    console.log = (...args: unknown[]) => {
      orig(...args);

      try {
        const first = args[0];

        if (
          typeof first === "string" &&
          first.startsWith("[AWR]")
        ) {
          const msg = args
            .map((a) =>
              typeof a === "string"
                ? a
                : (() => {
                    try {
                      return JSON.stringify(a);
                    } catch {
                      return String(a);
                    }
                  })()
            )
            .join(" ");

          setDebugLog((prev) => [
            ...prev.slice(-14),
            msg,
          ]);
        }
      } catch {
        /* ignore */
      }
    };

    return () => {
      console.log = orig;
    };
  }, []);

  const stopAnimation = () => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(
        animationRef.current
      );

      animationRef.current = null;
    }
  };

  const resetReadingState = () => {
    chunksRef.current = [];
    responsesRef.current = [];
    pendingRef.current.clear();

    currentChunkRef.current = 0;
    lastWordIndexRef.current = -1;
    latestWordIndexRef.current = -1;

    previousWordRef.current = null;
    spokenTokensRef.current = [];

    highlightQueueRef.current =
      Promise.resolve();
  };

  const cleanupPlayback = async () => {
    stopAnimation();

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    playingRef.current = false;

    setPlaying(false);
    setElapsed(0);
    setDuration(0);
    setCurrent("");
    setHasSession(false);

    resetReadingState();

    if (bookmarkRef.current) {
      const bookmark = bookmarkRef.current;
      bookmarkRef.current = null;

      try {
        await clearPlayback(bookmark);
      } catch {
        /* ignore */
      }
    }
  };

  // ─────────────────────────────────────────
  // تظليل الكلمة الحالية (مع تجاهل المتأخر)
  // ─────────────────────────────────────────
  const queueHighlight = (
    session: number,
    word: WordTiming
  ) => {
    const bookmark = bookmarkRef.current;

    if (!bookmark) {
      log(
        "queueHighlight: SKIPPED (no bookmark)"
      );
      return;
    }

    const occurrenceIndex = occurrence(
      word.text,
      spokenTokensRef.current
    );

    const previous = previousWordRef.current;

    // لقطة من آخر كلمة طلبها الصوت
    const requestedAt =
      latestWordIndexRef.current;

    spokenTokensRef.current.push(word.text);

    previousWordRef.current = {
      text: word.text,
      occurrence: occurrenceIndex,
    };

    highlightQueueRef.current =
      highlightQueueRef.current.then(
        async () => {
          if (
            session !== sessionRef.current
          ) {
            return;
          }

          // تجاهل الكلمات التي فاتها الصوت بأكثر من كلمتين
          if (
            requestedAt <
            latestWordIndexRef.current - 2
          ) {
            log(
              `queueHighlight: SKIP stale word="${word.text}" at ${requestedAt} (latest=${latestWordIndexRef.current})`
            );
            return;
          }

          try {
            await updateWordHighlight(
              bookmark,
              previous,
              {
                text: word.text,
                occurrence: occurrenceIndex,
              }
            );

            log(
              `queueHighlight: OK word="${word.text}"`
            );
          } catch (e) {
            log(
              `queueHighlight: ERROR word="${word.text}" —`,
              e instanceof Error
                ? e.message
                : String(e)
            );
          }
        }
      );
  };

  const animationLoop = (session: number) => {
    const audio = audioRef.current;
    const index = currentChunkRef.current;

    const response =
      responsesRef.current[index];

    if (
      session !== sessionRef.current ||
      !audio ||
      !response ||
      audio.paused
    ) {
      return;
    }

    const currentMs = audio.currentTime * 1000;

    setElapsed(audio.currentTime);

    let wordIndex =
      response.words.findIndex(
        (word) =>
          currentMs >= word.start_ms &&
          currentMs < word.end_ms
      );

    if (
      wordIndex < 0 &&
      currentMs >=
        response.duration_ms - 80
    ) {
      wordIndex =
        response.words.length - 1;
    }

    if (
      wordIndex >= 0 &&
      wordIndex !==
        lastWordIndexRef.current
    ) {
      lastWordIndexRef.current = wordIndex;
      latestWordIndexRef.current =
        wordIndex;

      const word =
        response.words[wordIndex];

      setCurrent(word.text);

      queueHighlight(session, word);
    }

    animationRef.current =
      requestAnimationFrame(() =>
        animationLoop(session)
      );
  };

  const requestChunk = async (
    index: number,
    session: number
  ) => {
    if (session !== sessionRef.current) {
      throw new Error("READ_CANCELLED");
    }

    const existing =
      responsesRef.current[index];

    if (existing) return existing;

    const pending =
      pendingRef.current.get(index);

    if (pending) return pending;

    const text = chunksRef.current[index];

    if (!text) {
      throw new Error(
        "مقطع القراءة غير موجود."
      );
    }

    const promise = synthesize(text, speed).then(
      (response) => {
        if (
          session === sessionRef.current
        ) {
          responsesRef.current[index] =
            response;
        }

        return response;
      }
    );

    pendingRef.current.set(index, promise);

    try {
      return await promise;
    } finally {
      pendingRef.current.delete(index);
    }
  };

  const prefetch = (
    index: number,
    session: number
  ) => {
    if (
      index >= chunksRef.current.length ||
      session !== sessionRef.current
    ) {
      return;
    }

    void requestChunk(index, session).catch(
      (e) => {
        if (
          session === sessionRef.current
        ) {
          setError(
            e instanceof Error
              ? e.message
              : "تعذر تجهيز المقطع التالي."
          );
        }
      }
    );
  };

  const playChunk = async (
    index: number,
    response: TtsResponse,
    session: number
  ) => {
    if (session !== sessionRef.current) {
      return;
    }

    const audioUrl =
      URL.createObjectURL(
        blob(
          response.audio_base64,
          response.mime_type
        )
      );

    const audio =
      audioRef.current ?? new Audio();

    audioRef.current = audio;

    audio.onended = null;
    audio.onerror = null;

    audio.src = audioUrl;
    audio.preload = "auto";

    currentChunkRef.current = index;
    lastWordIndexRef.current = -1;

    setDuration(
      response.duration_ms / 1000
    );

    setElapsed(0);
    setCurrent("");

    setStatus(
      `يقرأ الآن — المقطع ${
        index + 1
      } من ${
        chunksRef.current.length
      }`
    );

    audio.onended = async () => {
      stopAnimation();
      URL.revokeObjectURL(audioUrl);

      if (
        session !== sessionRef.current
      ) {
        return;
      }

      const nextIndex = index + 1;

      if (
        nextIndex >=
        chunksRef.current.length
      ) {
        playingRef.current = false;

        setPlaying(false);
        setCurrent("");
        setStatus("اكتملت القراءة");

        if (bookmarkRef.current) {
          const bookmark =
            bookmarkRef.current;

          bookmarkRef.current = null;

          try {
            await clearPlayback(bookmark);
          } catch {
            /* ignore */
          }
        }

        setHasSession(false);
        resetReadingState();

        return;
      }

      try {
        const next = await requestChunk(
          nextIndex,
          session
        );

        if (
          session !== sessionRef.current
        ) {
          return;
        }

        prefetch(nextIndex + 1, session);
        prefetch(nextIndex + 2, session);

        await playChunk(
          nextIndex,
          next,
          session
        );
      } catch (e) {
        if (
          session === sessionRef.current
        ) {
          setError(
            e instanceof Error
              ? e.message
              : "تعذر تجهيز المقطع التالي."
          );

          playingRef.current = false;

          setPlaying(false);
          stopAnimation();
        }
      }
    };

    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);

      if (
        session === sessionRef.current
      ) {
        setError(
          "تعذر تشغيل الصوت داخل Word."
        );

        playingRef.current = false;

        setPlaying(false);
        stopAnimation();
      }
    };

    await audio.play();

    if (
      session !== sessionRef.current
    ) {
      audio.pause();
      return;
    }

    playingRef.current = true;
    setPlaying(true);

    animationRef.current =
      requestAnimationFrame(() =>
        animationLoop(session)
      );
  };

  const startReading = async () => {
    const session = ++sessionRef.current;

    log(`startReading: session=${session}`);

    suppressSelectionRef.current = true;

    setBusy(true);
    busyRef.current = true;
    setError("");
    setStatus("جارٍ تحضير النص…");

    try {
      await cleanupPlayback();

      window.setTimeout(() => {
        suppressSelectionRef.current = false;
      }, 600);

      const t0 = performance.now();

      const prepared =
        await prepareReadingPosition();

      log(
        `startReading: prepare = ${(
          performance.now() - t0
        ).toFixed(0)}ms`
      );

      if (
        session !== sessionRef.current
      ) {
        return;
      }

      bookmarkRef.current =
        prepared.bookmarkName;

      chunksRef.current = prepared.chunks;

      if (!chunksRef.current.length) {
        throw new Error(
          "لم يتم العثور على نص قابل للقراءة."
        );
      }

      responsesRef.current = new Array(
        chunksRef.current.length
      ).fill(null);

      setStatus("جارٍ توليد الصوت…");

      const t1 = performance.now();

      const first = await requestChunk(
        0,
        session
      );

      log(
        `startReading: TTS chunk 0 = ${(
          performance.now() - t1
        ).toFixed(0)}ms`
      );

      if (
        session !== sessionRef.current
      ) {
        return;
      }

      prefetch(1, session);
      prefetch(2, session);

      setHasSession(true);

      await playChunk(0, first, session);
    } catch (e) {
      if (
        e instanceof Error &&
        e.message === "READ_CANCELLED"
      ) {
        return;
      }

      if (
        session === sessionRef.current
      ) {
        setError(
          e instanceof Error
            ? e.message
            : "حدث خطأ غير متوقع."
        );

        await cleanupPlayback();
        setStatus("تعذر بدء القراءة");
      }
    } finally {
      if (
        session === sessionRef.current
      ) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  };

  const stopReading = async () => {
    ++sessionRef.current;

    suppressSelectionRef.current = true;

    await cleanupPlayback();

    window.setTimeout(() => {
      suppressSelectionRef.current = false;
    }, 300);

    setBusy(false);
    busyRef.current = false;
    setStatus("متوقف");
  };

  const pauseResume = async () => {
    const audio = audioRef.current;

    if (!audio) {
      log("pauseResume: NO AUDIO");
      return;
    }

    log(
      `pauseResume: paused=${audio.paused} src=${
        audio.src ? "yes" : "no"
      }`
    );

    if (audio.paused) {
      try {
        await audio.play();

        playingRef.current = true;
        setPlaying(true);

        setStatus(
          `يقرأ الآن — المقطع ${
            currentChunkRef.current + 1
          } من ${
            chunksRef.current.length
          }`
        );

        animationRef.current =
          requestAnimationFrame(() =>
            animationLoop(
              sessionRef.current
            )
          );
      } catch {
        setError("تعذر استئناف الصوت.");
      }
    } else {
      audio.pause();
      stopAnimation();

      playingRef.current = false;
      setPlaying(false);
      setStatus("متوقف مؤقتًا");
    }
  };

  const restartFromSelection =
    async () => {
      if (
        !playingRef.current ||
        busyRef.current ||
        suppressSelectionRef.current
      ) {
        return;
      }

      await startReading();
    };

  useEffect(() => {
    let mounted = true;

    const selectionChanged = () => {
      if (!mounted) return;

      if (
        !playingRef.current ||
        busyRef.current ||
        suppressSelectionRef.current
      ) {
        return;
      }

      if (
        selectionTimerRef.current !== null
      ) {
        window.clearTimeout(
          selectionTimerRef.current
        );
      }

      selectionTimerRef.current =
        window.setTimeout(() => {
          void restartFromSelection();
        }, 250);
    };

    Office.onReady(async () => {
      if (!mounted) return;

      try {
        await health();

        setReady(true);
        setStatus("جاهز للقراءة الحية");

        // تسخين TTS مسبقًا لتحميل نموذج Piper
        void synthesize("مرحبا", 1).catch(
          () => {
            /* تجاهل — مجرد تسخين */
          }
        );

        Office.context.document.addHandlerAsync(
          Office.EventType
            .DocumentSelectionChanged,
          selectionChanged
        );
      } catch {
        setError(
          "خدمة القراءة المحلية غير مفعلة. شغّل Backend أولًا."
        );
      }
    });

    return () => {
      mounted = false;

      if (
        selectionTimerRef.current !== null
      ) {
        window.clearTimeout(
          selectionTimerRef.current
        );
      }

      sessionRef.current++;
      stopAnimation();
      audioRef.current?.pause();
    };
  }, []);

  const canPause =
    hasSession &&
    (playing || audioRef.current !== null);

  return (
    <main className="app">
      <header>
        <div className="mark">ع</div>

        <div>
          <h1>القارئ العربي</h1>
          <p>
            قراءة حية داخل Microsoft Word
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="status">
          <i className={ready ? "ok" : ""} />
          {status}
        </div>

        <div className="current">
          {current || "—"}
        </div>

        <div className="bar">
          <span
            style={{
              width: `${
                duration
                  ? Math.min(
                      100,
                      (elapsed / duration) *
                        100
                    )
                  : 0
              }%`,
            }}
          />
        </div>

        <div className="times">
          <span>{formatTime(elapsed)}</span>
          <span>{formatTime(duration)}</span>
        </div>

        <div className="actions">
          <button
            className="primary"
            disabled={!ready || busy}
            onClick={() =>
              void startReading()
            }
          >
            {busy
              ? "جارٍ التحضير…"
              : "▶ ابدأ من المؤشر"}
          </button>

          <button
            disabled={!canPause}
            onClick={() =>
              void pauseResume()
            }
          >
            {playing
              ? "⏸ إيقاف مؤقت"
              : "▶ استئناف"}
          </button>

          <button
            disabled={!hasSession}
            onClick={() =>
              void stopReading()
            }
          >
            ■ إيقاف
          </button>
        </div>

        <div className="speed">
          <span>سرعة القراءة</span>

          <div>
            {[0.75, 1, 1.25, 1.5].map(
              (value) => (
                <button
                  key={value}
                  className={
                    value === speed
                      ? "sel"
                      : ""
                  }
                  disabled={playing}
                  onClick={() =>
                    setSpeed(value)
                  }
                >
                  {value}×
                </button>
              )
            )}
          </div>
        </div>
      </section>

      <section className="help">
        <b>طريقة الاستخدام</b>

        <p>
          ضع مؤشر الكتابة في أي موضع
          داخل المستند ثم اضغط «ابدأ من
          المؤشر». تبدأ القراءة من ذلك
          الموضع وتستمر تلقائيًا.
        </p>
      </section>

      {error && (
        <div className="error">{error}</div>
      )}

      <section className="debug">
        <details>
          <summary>
            سجل التشخيص ({debugLog.length})
          </summary>

          <pre
            style={{
              maxHeight: 200,
              overflow: "auto",
              fontSize: 10,
              direction: "ltr",
              textAlign: "left",
              background: "#111",
              color: "#0f0",
              padding: 6,
              borderRadius: 4,
            }}
          >
            {debugLog.join("\n") ||
              "(لا توجد رسائل بعد)"}
          </pre>
        </details>
      </section>
    </main>
  );
}