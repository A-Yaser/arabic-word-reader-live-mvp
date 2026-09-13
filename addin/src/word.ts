const log = (...args: unknown[]) =>
  console.log("[AWR]", ...args);

// ═══════════════════════════════════════════════════════════
// [PERF] Highlight performance counters (reset per session)
// ═══════════════════════════════════════════════════════════
let _perfWordRunCount = 0;
let _perfSyncCount = 0;
let _perfSearchCount = 0;

export function getHighlightPerfStats() {
  return {
    wordRunCalls: _perfWordRunCount,
    syncCalls: _perfSyncCount,
    searchCalls: _perfSearchCount,
  };
}

export function resetHighlightPerfStats() {
  _perfWordRunCount = 0;
  _perfSyncCount = 0;
  _perfSearchCount = 0;
}

export interface PreparedReading {
  text: string;
  bookmarkName: string;
  chunks: string[];
  wordIndex: { text: string; start: number; end: number }[];
}

const ENDING_MARKS = [".", "!", "؟", "؛", "۔", "\r"];
const ENDING_SET = new Set(ENDING_MARKS);
const MAX_CHUNK_CHARS = 150;

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
  log("[PERF] prepare: started");

  return Word.run(async (context) => {
    // === MERTRIC: Range Construction ===
    const tRanges = performance.now();

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

    const rangeConstructionMs = performance.now() - tRanges;
    log(`[PERF] prepare: rangeConstruction = ${rangeConstructionMs.toFixed(1)}ms`);

    // === MERTRIC: getTextRanges + load ===
    const tGetRanges = performance.now();

    readingRange.load("text");

    const wordRanges = readingRange.getTextRanges(
      [" "],
      true
    );

    wordRanges.load("items/text");

    const getRangesSetupMs = performance.now() - tGetRanges;
    log(`[PERF] prepare: getTextRanges setup = ${getRangesSetupMs.toFixed(1)}ms`);

    // === MERTRIC: Sync #1 ===
    const tSync1 = performance.now();
    await context.sync();
    const sync1Ms = performance.now() - tSync1;
    log(`[PERF] prepare: sync #1 = ${sync1Ms.toFixed(1)}ms`);

    const fullText = readingRange.text
      .replace(/\u00a0/g, " ")
      .trim();

    if (!fullText) {
      throw new Error(
        "لا يوجد نص بعد موضع مؤشر الكتابة للقراءة."
      );
    }

    // === MERTRIC: wordIndex Construction ===
    const tWordIndex = performance.now();

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

    const wordIndexMs = performance.now() - tWordIndex;
    log(`[PERF] prepare: wordIndex build = ${wordIndexMs.toFixed(1)}ms, words=${wordIndex.length}`);

    // === MERTRIC: Chunking ===
    const tChunking = performance.now();

    const sentences = splitIntoSentences(fullText);
    let chunks: string[] = [];

    for (const s of sentences) {
      chunks.push(...splitLongText(s));
    }

    if (!chunks.length) {
      chunks = splitLongText(fullText);
    }

    const chunkingMs = performance.now() - tChunking;
    log(`[PERF] prepare: chunking = ${chunkingMs.toFixed(1)}ms, chunks=${chunks.length}`);

    // === MERTRIC: Bookmark Creation + Sync #2 ===
    const tBookmark = performance.now();

    const bookmarkName = `_AWR_${Date.now().toString(36)}`;

    readingRange.insertBookmark(bookmarkName);

    const tSync2 = performance.now();
    await context.sync();
    const sync2Ms = performance.now() - tSync2;
    const bookmarkTotalMs = performance.now() - tBookmark;
    log(`[PERF] prepare: bookmark + sync #2 = ${bookmarkTotalMs.toFixed(1)}ms (sync=${sync2Ms.toFixed(1)}ms)`);

    // === MERTRIC: Chunk size statistics ===
    const chunkSizes = chunks.map(c => c.length);
    const avgChunkSize = chunkSizes.length > 0
      ? chunkSizes.reduce((a, b) => a + b, 0) / chunkSizes.length
      : 0;
    const minChunkSize = chunkSizes.length > 0 ? Math.min(...chunkSizes) : 0;
    const maxChunkSize = chunkSizes.length > 0 ? Math.max(...chunkSizes) : 0;

    const totalTimeMs = performance.now() - t0;
    log(
      `[PERF] prepare: TOTAL = ${totalTimeMs.toFixed(0)}ms | ` +
      `textChars=${fullText.length} | ` +
      `wordRanges=${wordRanges.items.length} | ` +
      `wordIndex=${wordIndex.length} | ` +
      `chunks=${chunks.length} | ` +
      `avgChunkSize=${avgChunkSize.toFixed(0)} min=${minChunkSize} max=${maxChunkSize} | ` +
      `rangeConstruction=${rangeConstructionMs.toFixed(0)}ms | ` +
      `sync#1=${sync1Ms.toFixed(0)}ms | ` +
      `wordIndex=${wordIndexMs.toFixed(0)}ms | ` +
      `sync#2=${sync2Ms.toFixed(0)}ms`
    );

    return {
      text: fullText,
      bookmarkName,
      chunks,
      wordIndex,
    };
  });
}

// ═══════════════════════════════════════════════════════════
// [FIX] تتبع التظليل الحالي عبر bookmark مستقل
// ═══════════════════════════════════════════════════════════
let _currentHighlightBookmark: string | null = null;

/**
 * إزالة التظليل الحالي باستخدام bookmark النطاق
 * (بدون بحث نصي — يعمل حتى لو تغيّر النص).
 */
async function clearCurrentHighlight(): Promise<void> {
  if (!_currentHighlightBookmark) return;

  const bookmarkName = _currentHighlightBookmark;
  _currentHighlightBookmark = null;

  await Word.run(async (context) => {
    try {
      const range =
        context.document.getBookmarkRange(bookmarkName);

      range.font.highlightColor = "";
      context.document.deleteBookmark(bookmarkName);

      await context.sync();
    } catch {
      // الـbookmark قد يكون حُذف تلقائيًا عند تعديل النص
    }
  });
}

/**
 * تحديث التظليل: إزالة السابق + إضافة الجديد
 * في Word.run واحد.
 *
 * - الإزالة تتم عبر bookmark النطاق (مضمون 100%)
 * - الإضافة تتم عبر search + insertBookmark جديد
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

  _perfWordRunCount++;

  await Word.run(async (context) => {
    try {
      // ─── 1. إزالة التظليل السابق عبر bookmark (بدون بحث) ───
      if (_currentHighlightBookmark) {
        try {
          const prevRange =
            context.document.getBookmarkRange(
              _currentHighlightBookmark
            );

          prevRange.font.highlightColor = "";
          context.document.deleteBookmark(
            _currentHighlightBookmark
          );
        } catch {
          // الـbookmark غير صالح — تجاهل
        }

        _currentHighlightBookmark = null;
      }

      // ─── 2. إذا لم تكن هناك كلمة جديدة، انتهِ ───
      if (!next) {
        _perfSyncCount++;
        await context.sync();
        return;
      }

      // ─── 3. البحث عن الكلمة الجديدة ───
      const scope =
        context.document.getBookmarkRange(bookmark);

      _perfSearchCount++;
      const matches = scope.search(next.text, {
        matchWholeWord: true,
        ignorePunct: true,
        ignoreSpace: true,
        matchCase: false,
      });

      matches.load("items/text");

      _perfSyncCount++;
      await context.sync();

      if (!matches.items.length) {
        for (const item of matches.items) item.untrack();
        matches.untrack();
        return;
      }

      const idx = Math.min(
        next.occurrence,
        matches.items.length - 1
      );

      const target = matches.items[idx];

      // ─── 4. تظليل الكلمة الجديدة ───
      target.font.highlightColor = "#FFFF00";

      // ─── 5. إدراج bookmark على النطاق المُظلَّل ───
      const hlBookmarkName = `_AWR_HL_${Date.now().toString(36)}`;
      target.insertBookmark(hlBookmarkName);

      _perfSyncCount++;
      await context.sync();

      _currentHighlightBookmark = hlBookmarkName;

      // تنظيف المراجع
      for (const item of matches.items) item.untrack();
      matches.untrack();
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
 * 1. إزالة تظليل الكلمة الحالية (عبر bookmark)
 * 2. إزالة أي تظليل متبقٍ في نطاق القراءة الرئيسي
 * 3. حذف كل الـbookmarks
 */
export async function clearPlayback(bookmark: string) {
  // ─── 1. إزالة تظليل الكلمة الحالية ───
  await clearCurrentHighlight();

  // ─── 2. إزالة أي تظليل متبقٍ + حذف bookmark الرئيسي ───
  await Word.run(async (context) => {
    try {
      const range =
        context.document.getBookmarkRange(bookmark);

      range.font.highlightColor = "";
      context.document.deleteBookmark(bookmark);

      await context.sync();
    } catch {
      // الـbookmark قد يكون محذوفًا
    }
  });
}