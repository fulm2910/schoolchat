'use strict';

/*
 * Word filter.
 *
 * Both the message and every listed word are reduced to the same canonical form,
 * so look-alike characters compare equal:
 *   - Unicode compatibility forms and accents are folded (ｂáｄ -> bad)
 *   - case is folded
 *   - common substitutions map to one letter: 0->o, 1/l/!/|->i, 3->e, 4/@->a,
 *     5/$->s, 7/+->t, 8->b, 9->g
 *   - zero-width characters are removed
 * Matching is by whole word (or whole phrase for multi-word entries), so "class"
 * does not trip a filter on "ass". Runs of single letters are also joined, so
 * "b a d" and "b.a.d" match "bad".
 */

const LETTER_CLASSES = {
  0: 'o', 1: 'i', l: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g',
};
const SYMBOL_CLASSES = { '!': 'i', '|': 'i', '@': 'a', $: 's', '+': 't' };

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

function fold(text) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').replace(INVISIBLE, '').toLowerCase();
}

/** Returns arrays of canonical tokens. Symbols are tried both as letters and as separators. */
function tokenVariants(text) {
  const folded = fold(text);
  const variants = [];
  for (const symbolsAsLetters of [true, false]) {
    let out = '';
    for (const ch of folded) {
      if (symbolsAsLetters && SYMBOL_CLASSES[ch]) out += SYMBOL_CLASSES[ch];
      else out += LETTER_CLASSES[ch] || ch;
    }
    const tokens = out.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    variants.push(tokens);
    // Join runs of single characters: "b a d" -> "bad"
    const joined = [];
    let run = '';
    for (const t of tokens) {
      if ([...t].length === 1) { run += t; continue; }
      if (run) { joined.push(run); run = ''; }
      joined.push(t);
    }
    if (run) joined.push(run);
    variants.push(joined);
  }
  return variants;
}

function canonicalWord(word) {
  // Words are canonicalised the same way as messages (symbols as letters).
  return tokenVariants(word)[0].join(' ');
}

function createFilter() {
  let entries = []; // canonical forms

  return {
    setWords(words) {
      entries = [...new Set(words.map(canonicalWord).filter(Boolean))];
    },
    /** Returns true if the text contains a filtered word. */
    check(text) {
      if (!entries.length || !text) return false;
      for (const tokens of tokenVariants(text)) {
        const set = new Set(tokens);
        const padded = ` ${tokens.join(' ')} `;
        for (const entry of entries) {
          if (entry.includes(' ') ? padded.includes(` ${entry} `) : set.has(entry)) return true;
        }
      }
      return false;
    },
  };
}

module.exports = { createFilter, canonicalWord };
