const log = (...args: unknown[]) =>
  console.log("[AWR]", ...args);

export interface PreparedReading {
  text: string;
  bookmarkName: string;
  chunks: string[];
  wordIndex: { text: string; start: number; end: number }[];
}

const ENDING_MARKS = [".", "!", "؟", "؛", "۔", "\r"];
const ENDING_SET = new Set(ENDING_MARKS);
const MAX_CHUNK_CHARS = 300;

function key(v: string) {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[^\p{L}\p{N}\u0600-\u06FF]/gu, "")
    .toLocaleLowerCase("ar");
}

export function occurrence(
  token: string,
  prev: string[]
) {
  const k = key(token);
  return prev.reduce(
    (n, x) => n + (key(x) === k ? 1 : 0),
    0
  );
}

function splitLongText(text: string) {
  const value = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

  if (!value) return [];
  if (value.length <= MAX_CHUNK_CHARS) return [value];

  const words = value.split(/\s+/u);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current
      ? `${current} ${word}`
      : word;

    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = word;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  let buffer = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buffer += ch;

    if (ENDING_SET.has(ch)) {
      const trimmed = buffer.trim();
      if (trimmed) sentences.push(trimmed);
      buffer = "";
    }
  }

  const tail = buffer.trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/**
 * يستخرج النص من موضع المؤشر حتى نهاية المستند،
 * ويبني فهرساً كاملاً للكلمات باستخدام getTextRanges.
 *
 * syncs: 2 فقط
 */
export async function prepareReadingPosition(): Promise<PreparedReading> {
  const t0 = performance.now();
  log("prepareReadingPosition: started");

  return Word.run(async (context) => {
    const selection =
      context.document.getSelection();

    const start = selection.getRange(
      Word.RangeLocation.start
    );

    const documentEnd =
      context.document.body.getRange(
        Word.RangeLocation.end
      );

    const readingRange =
      start.expandTo(documentEnd);

    // ---- SYNC #1: تحميل النص + بناء فهرس الكلمات ----
    readingRange.load("text");

    const wordRanges = readingRange.getTextRanges(
      [" "],
      true
    );

    wordRanges.load("items/text");

    await context.sync();

    const fullText = readingRange.text
      .replace(/\u00a0/g, " ")
      .trim();

    if (!fullText) {
      throw new Error(
        "لا يوجد نص بعد موضع مؤشر الكتابة للقراءة."
      );
    }

    // بناء فهرس الكلمات
    const wordIndex: { text: string; start: number; end: number }[] = [];
    let searchOffset = 0;

    for (const item of wordRanges.items) {
      const wordText = item.text.trim();
      if (!wordText) continue;

      const idx = fullText.indexOf(
        wordText,
        searchOffset
      );

      if (idx >= 0) {
        wordIndex.push({
          text: wordText,
          start: idx,
          end: idx + wordText.length,
        });

        searchOffset = idx + wordText.length;
      }
    }

    log(
      `prepareReadingPosition: wordIndex built, ${wordIndex.length} words`
    );

    // تقسيم إلى مقاطع للـTTS
    const sentences = splitIntoSentences(fullText);
    let chunks: string[] = [];

    for (const s of sentences) {
      chunks.push(...splitLongText(s));
    }

    if (!chunks.length) {
      chunks = splitLongText(fullText);
    }

    // ---- SYNC #2: إنشاء bookmark ----
    const bookmarkName = `_AWR_${Date.now().toString(36)}`;

    readingRange.insertBookmark(bookmarkName);

    await context.sync();

    log(
      `prepareReadingPosition: TOTAL = ${(
        performance.now() - t0
      ).toFixed(0)}ms, words=${wordIndex.length}, chunks=${chunks.length}`
    );

    return {
      text: fullText,
      bookmarkName,
      chunks,
      wordIndex,
    };
  });
}

/**
 * تحديث التظليل: إزالة السابق + إضافة الجديد
 * في Word.run واحد.
 *
 * يستخدم font.highlightColor (الذي يعمل دائمًا)
 * مع إدارة دورة حياة التظليل يدويًا.
 */
export async function updateWordHighlight(
  bookmark: string,
  previous: {
    text: string;
    occurrence: number;
  } | null,
  next: {
    text: string;
    occurrence: number;
  } | null
): Promise<void> {
  if (!previous && !next) return;

  await Word.run(async (context) => {
    try {
      const scope =
        context.document.getBookmarkRange(bookmark);

      let prevMatches: Word.RangeCollection | null = null;
      let nextMatches: Word.RangeCollection | null = null;

      if (previous) {
        prevMatches = scope.search(previous.text, {
          matchWholeWord: true,
          ignorePunct: true,
          ignoreSpace: true,
          matchCase: false,
        });
        prevMatches.load("items/text");
      }

      if (next) {
        nextMatches = scope.search(next.text, {
          matchWholeWord: true,
          ignorePunct: true,
          ignoreSpace: true,
          matchCase: false,
        });
        nextMatches.load("items/text");
      }

      await context.sync(); // SYNC #1: البحثان

      // ✅ إزالة التظليل عن الكلمة السابقة
      if (prevMatches && prevMatches.items.length) {
        const idx = Math.min(
          previous!.occurrence,
          prevMatches.items.length - 1
        );
        prevMatches.items[idx].font.highlightColor = "";
      }

      // ✅ إضافة التظليل للكلمة الجديدة (مؤقتاً)
      if (nextMatches && nextMatches.items.length) {
        const idx = Math.min(
          next!.occurrence,
          nextMatches.items.length - 1
        );
        nextMatches.items[idx].font.highlightColor = "#FFFF00";
      }

      await context.sync(); // SYNC #2: التعديلات

      // تنظيف المراجع لمنع تسرب الذاكرة
      if (prevMatches) {
        for (const item of prevMatches.items) item.untrack();
        prevMatches.untrack();
      }
      if (nextMatches) {
        for (const item of nextMatches.items) item.untrack();
        nextMatches.untrack();
      }
    } catch (e) {
      log(
        `updateWordHighlight: ERROR — ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  });
}

/**
 * تنظيف القراءة بالكامل:
 * - إزالة أي تظليل متبقٍ من النطاق بالكامل
 * - حذف الـbookmark
 */
export async function clearPlayback(bookmark: string) {
  await Word.run(async (context) => {
    try {
      const range =
        context.document.getBookmarkRange(bookmark);

      // ✅ إزالة أي تظليل متبقٍّ
      range.font.highlightColor = "";

      context.document.deleteBookmark(bookmark);
      await context.sync();
    } catch {
      /* bookmark قد يكون محذوفاً */
    }
  });
}