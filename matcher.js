// MirrorCue Web — script tracking engine.
// A faithful port of the iOS ScriptMatcher: aligns live speech transcripts
// against the script, tolerating ad-libs, skipped words, and jumps back to
// an earlier point. Also detects the voice commands ("go start" etc.).
(function (root) {
  'use strict';

  const WORD_CHARS = /[\p{L}\p{N}]/gu;

  function normalizeWord(w) {
    const m = w.toLowerCase().match(WORD_CHARS);
    return m ? m.join('') : '';
  }
  function normalize(text) {
    return text.split(/\s+/).map(normalizeWord).filter(Boolean);
  }

  function editDistanceAtMostOne(a, b) {
    if (a.length === b.length) {
      let diffs = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diffs > 1) return false;
      return true;
    }
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    let i = 0, j = 0, skipped = false;
    while (i < s.length && j < l.length) {
      if (s[i] === l[j]) { i++; j++; }
      else { if (skipped) return false; skipped = true; j++; }
    }
    return true;
  }

  function fuzzyEqual(a, b) {
    if (a === b) return true;
    if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) return true;
    if (a.length >= 5 && b.length >= 5 && Math.abs(a.length - b.length) <= 1) return editDistanceAtMostOne(a, b);
    return false;
  }

  function lcsLength(a, b) {
    const dp = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let prevDiag = 0;
      for (let j = 1; j <= b.length; j++) {
        const temp = dp[j];
        if (fuzzyEqual(a[i - 1], b[j - 1])) dp[j] = prevDiag + 1;
        else dp[j] = Math.max(dp[j], dp[j - 1]);
        prevDiag = temp;
      }
    }
    return dp[b.length];
  }

  const TARGET_WORDS = 8, HARD_CAP = 11;
  function chunkParagraph(words) {
    const chunks = []; let cur = [];
    const flush = () => { if (cur.length) { chunks.push(cur); cur = []; } };
    for (const word of words) {
      cur.push(word);
      const trimmed = word.replace(/["'”’)\]]+$/, '');
      const last = trimmed.slice(-1);
      const endsSentence = '.!?…'.includes(last) && last !== '';
      const endsClause = ',;:—'.includes(last) && last !== '';
      if (endsSentence) flush();
      else if (cur.length >= TARGET_WORDS && (endsClause || cur.length >= HARD_CAP)) flush();
    }
    flush();
    return chunks;
  }

  class ScriptMatcher {
    constructor(script) {
      this.lines = []; this.lineTokenRanges = []; this.lineParagraphs = [];
      this.tokens = []; this.tokenLine = [];
      // Display structure: paragraphs of {text, token|null} cells.
      this.paragraphs = [];
      this.current = -1; this.missStreak = 0;

      let tokenIdx = 0, paragraphIdx = -1;
      for (const paragraph of script.split(/\r?\n/)) {
        const words = paragraph.split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        paragraphIdx++;
        const cells = [];
        for (const lineWords of chunkParagraph(words)) {
          const lineIndex = this.lines.length;
          const lineTokens = lineWords.map(normalizeWord).filter(Boolean);
          if (!lineTokens.length) {
            for (const w of lineWords) cells.push({ text: w, token: null });
            continue;
          }
          this.lines.push(lineWords.join(' '));
          this.lineTokenRanges.push([tokenIdx, tokenIdx + lineTokens.length]);
          this.lineParagraphs.push(paragraphIdx);
          for (const w of lineWords) {
            const t = normalizeWord(w);
            if (t) { cells.push({ text: w, token: tokenIdx++ }); this.tokens.push(t); this.tokenLine.push(lineIndex); }
            else cells.push({ text: w, token: null });
          }
        }
        this.paragraphs.push(cells);
      }
    }

    reset() { this.current = -1; this.missStreak = 0; }
    seek(tokenIndex) { this.current = Math.max(-1, Math.min(tokenIndex, this.tokens.length - 1)); this.missStreak = 0; }

    /** Feed the latest (partial) transcript; returns {lineIndex, tokenIndex} or null. */
    update(transcript) {
      const spoken = normalize(transcript);
      if (!spoken.length || !this.tokens.length) return null;

      // Fast path: newest heard word is one of the next few expected words.
      const last = spoken[spoken.length - 1];
      for (let step = 1; step <= 3; step++) {
        const idx = this.current + step;
        if (idx >= this.tokens.length) break;
        if (fuzzyEqual(last, this.tokens[idx])) {
          if (step > 1 && last.length < 4) continue;
          this.current = idx; this.missStreak = 0;
          return { lineIndex: this.tokenLine[idx], tokenIndex: idx };
        }
      }
      if (spoken.length < 2) return null;

      const tail = spoken.slice(-10), k = tail.length;
      let lo, hi;
      if (this.missStreak >= 4 || this.current < 0) { lo = 0; hi = this.tokens.length - 1; }
      else { lo = Math.max(0, this.current - 80); hi = Math.min(this.tokens.length - 1, this.current + 200); }

      let bestScore = 0, bestEnd = -1;
      for (let end = lo; end <= hi; end++) {
        const start = Math.max(0, end - k - 2);
        const overlap = lcsLength(tail, this.tokens.slice(start, end + 1));
        let score = overlap / k;
        // Prefer the end that actually IS the last word heard, so a full
        // match can't overshoot into the words that follow it.
        if (fuzzyEqual(tail[k - 1], this.tokens[end])) score += 0.05;
        if (this.current >= 0) score -= 0.0006 * Math.abs(end - this.current);
        if (score > bestScore) { bestScore = score; bestEnd = end; }
      }
      if (bestScore < 0.55 || bestEnd < 0) { this.missStreak++; return null; }
      this.missStreak = 0; this.current = bestEnd;
      return { lineIndex: this.tokenLine[bestEnd], tokenIndex: bestEnd };
    }
  }

  const COMMANDS = [
    ['start', [['go','start'], ['go','to','start'], ['go','to','the','start'], ['go','beginning'], ['go','to','the','beginning']]],
    ['end',   [['go','end'], ['go','to','end'], ['go','to','the','end']]],
    ['back',  [['go','back'], ['go','backward'], ['go','backwards']]],
  ];
  class VoiceCommandDetector {
    constructor() { this.lastTriggerAt = 0; }
    reset() { this.lastTriggerAt = 0; }
    detect(transcript) {
      const words = normalize(transcript);
      if (!words.length) return null;
      if (Date.now() - this.lastTriggerAt < 2000) return null;
      for (const [cmd, patterns] of COMMANDS) {
        for (const p of patterns) {
          if (words.length >= p.length && p.every((w, i) => words[words.length - p.length + i] === w)) {
            this.lastTriggerAt = Date.now();
            return cmd;
          }
        }
      }
      return null;
    }
  }

  const api = { ScriptMatcher, VoiceCommandDetector, normalize, normalizeWord, fuzzyEqual };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MirrorCueMatcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
