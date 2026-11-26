// CIF read as bytes as they arrive: its tokens, which are whitespace-separated words, quoted strings and semicolon text
// fields, with comments skipped, and the text and numbers they hold. A token may straddle the chunks the bytes come
// in, so the tokenizer carries what it was in the middle of from one chunk to the next: a comment, a word cut short, a
// quoted string and whether the quote just read may be the one that closes it, a text field and whether the byte just
// read ended a line, and the byte before the next token, which says whether a semicolon there starts a line. The
// bytes are UTF-8, whose characters of more than one byte hold no byte CIF gives a meaning to, so every token ends
// where the text's would

// What a tokenizer hands each token to: its bytes, from start up to end, and whether it was quoted or a text field.
// The bytes are the chunk's own, or a copy of a token that straddled chunks, and are never written again, so a token
// may be kept after the call
export interface TokenSink {
  token(bytes: Uint8Array, start: number, end: number, quoted: boolean): void
}

const tab = 9
const newline = 10
const carriageReturn = 13
const space = 32
const doubleQuote = 34
const hash = 35
const plus = 43
const minus = 45
const dot = 46
const zero = 48
const nine = 57
const semicolon = 59
const question = 63
const singleQuote = 39

export function isSpace(code: number) {
  return code === space || code === tab || code === newline || code === carriageReturn
}

// 1 for each byte that's whitespace, read in the loops over a chunk's bytes
const spaces = Uint8Array.from({ length: 256 }, (_, code) => (isSpace(code) ? 1 : 0))

// What the tokenizer is in the middle of between bytes: whitespace, a comment, a word, a quoted string, a quoted
// string whose quote was the last byte read, a text field, and a text field whose last byte read ended a line
const between = 0
const comment = 1
const word = 2
const quoted = 3
const quoteRead = 4
const textField = 5
const lineEnded = 6

export class CifTokenizer {
  private readonly sink: TokenSink
  private mode = between
  private quote = 0
  // The byte before the next token, the file's start counting as a line's end
  private previous = newline
  // The bytes of a token cut short at a chunk's end, so far
  private carry = new Uint8Array(256)
  private carried = 0

  constructor(sink: TokenSink) {
    this.sink = sink
  }

  // Reads the next chunk of the file
  feed(bytes: Uint8Array) {
    const length = bytes.length
    let p = 0
    // Where the token under way starts in this chunk: at its start where it began in an earlier one, which is carried
    let start = 0
    while (p < length) {
      switch (this.mode) {
        case between: {
          let previous = this.previous
          while (p < length && spaces[bytes[p]] === 1) previous = bytes[p++]
          this.previous = previous
          if (p === length) break
          const code = bytes[p++]
          start = p
          // A semicolon opens a text field only at the start of a line, and a quote a string only at a token's start
          if (code === hash) this.mode = comment
          else if (code === semicolon && (previous === newline || previous === carriageReturn)) this.mode = textField
          else if (code === singleQuote || code === doubleQuote) {
            this.mode = quoted
            this.quote = code
          } else {
            // A word, almost every token, is read through at once where it ends in this chunk
            start = p - 1
            while (p < length && spaces[bytes[p]] === 0) p++
            if (p < length) this.sink.token(bytes, start, p, false)
            else this.mode = word
          }
          break
        }
        case comment:
          while (p < length && bytes[p] !== newline && bytes[p] !== carriageReturn) p++
          if (p < length) this.mode = between
          break
        case word:
          while (p < length && spaces[bytes[p]] === 0) p++
          if (p < length) this.emit(bytes, start, p, false, 0)
          break
        case quoted: {
          const quote = this.quote
          while (p < length && bytes[p] !== quote) p++
          if (p < length) {
            p++
            this.mode = quoteRead
          }
          break
        }
        case quoteRead: {
          // A quote closes the string only when whitespace or the end follows it, and is otherwise part of it
          const code = bytes[p]
          if (isSpace(code)) this.emit(bytes, start, p, true, 1)
          else {
            if (code !== this.quote) this.mode = quoted
            p++
          }
          break
        }
        case textField:
          while (p < length && bytes[p] !== newline) p++
          if (p < length) {
            p++
            this.mode = lineEnded
          }
          break
        case lineEnded: {
          // A text field runs to the next line that starts with a semicolon, and holds neither that line's end nor
          // the semicolon
          const code = bytes[p++]
          if (code === semicolon) {
            this.emit(bytes, start, p - 1, true, 1)
            this.previous = semicolon
          } else if (code !== newline) this.mode = textField
          break
        }
      }
    }
    if (this.mode !== between && this.mode !== comment) this.keep(bytes, start, length)
  }

  // Ends the file, and with it the token under way: a word or a string at its last byte, a quote there closing its
  // string, and a text field holding everything to the end
  end() {
    const none = new Uint8Array(0)
    if (this.mode === word) this.emit(none, 0, 0, false, 0)
    else if (this.mode === quoted || this.mode === textField || this.mode === lineEnded) this.emit(none, 0, 0, true, 0)
    else if (this.mode === quoteRead) this.emit(none, 0, 0, true, 1)
    this.mode = between
  }

  // Hands on the token under way, which ends at end in these bytes, less the bytes to drop at its end: its closing
  // quote, or the line's end before a text field's closing semicolon. A text field also drops a carriage return
  // left at its end
  private emit(bytes: Uint8Array, start: number, end: number, isQuoted: boolean, drop: number) {
    const field = this.mode === textField || this.mode === lineEnded
    this.mode = between
    if (this.carried === 0) {
      let last = end - drop
      if (field && last > start && bytes[last - 1] === carriageReturn) last--
      this.sink.token(bytes, start, last, isQuoted)
      return
    }
    this.keep(bytes, start, end)
    let last = this.carried - drop
    if (field && last > 0 && this.carry[last - 1] === carriageReturn) last--
    const token = this.carry.slice(0, last)
    this.carried = 0
    this.sink.token(token, 0, token.length, isQuoted)
  }

  // Keeps bytes of the token under way, to be joined by the next chunk's
  private keep(bytes: Uint8Array, start: number, end: number) {
    const needed = this.carried + end - start
    if (needed > this.carry.length) {
      const grown = new Uint8Array(Math.max(needed, this.carry.length * 2))
      grown.set(this.carry.subarray(0, this.carried))
      this.carry = grown
    }
    this.carry.set(bytes.subarray(start, end), this.carried)
    this.carried = needed
  }
}

const decoder = new TextDecoder()

// The text of a token's bytes, read as UTF-8
export function decodeText(bytes: Uint8Array, start: number, end: number) {
  if (end - start > 64) return decoder.decode(bytes.subarray(start, end))
  let text = ''
  for (let p = start; p < end; p++) {
    const code = bytes[p]
    if (code >= 0x80) return decoder.decode(bytes.subarray(start, end))
    text += String.fromCharCode(code)
  }
  return text
}

// Whether an unquoted token is ? (unknown) or . (not applicable), which both read as empty
export function isUnknown(bytes: Uint8Array, start: number, end: number, isQuoted: boolean) {
  return !isQuoted && end - start === 1 && (bytes[start] === question || bytes[start] === dot)
}

// Exact powers of ten, as far as a double holds every one of them and every whole number below the largest
const powers = Array.from({ length: 16 }, (_, k) => 10 ** k)
// The most digits a plain decimal's whole number of digits may have and stay exact in a double
const exactDigits = 15

// The number a token's text reads as, as Number reads it. A plain decimal, an optional sign, digits and at most one
// point, of no more digits than a double holds exactly, is read from its bytes: its digits as a whole number over a
// power of ten, both exact, whose quotient is the decimal rounded once to the nearest double, as Number rounds it.
// Anything else, such as an exponent, is read by Number from the token's text
export function readNumber(bytes: Uint8Array, start: number, end: number) {
  let p = start
  const first = bytes[p]
  const negative = first === minus
  if (negative || first === plus) p++
  let whole = 0
  let digits = 0
  let decimals = 0
  let point = false
  for (; p < end; p++) {
    const code = bytes[p]
    if (code >= zero && code <= nine) {
      whole = whole * 10 + (code - zero)
      digits++
      if (point) decimals++
    } else if (code === dot && !point) point = true
    else return Number(decodeText(bytes, start, end))
  }
  if (digits === 0 || digits > exactDigits) return Number(decodeText(bytes, start, end))
  const value = decimals === 0 ? whole : whole / powers[decimals]
  return negative ? -value : value
}

// Whether a token is a whole number as its digits alone write it, with no sign and no leading zero, short enough to
// be exact, so that two such tokens are the same text exactly when they're the same number
export function isPlainWhole(bytes: Uint8Array, start: number, end: number) {
  const length = end - start
  if (length === 0 || length > exactDigits || (length > 1 && bytes[start] === zero)) return false
  for (let p = start; p < end; p++) if (bytes[p] < zero || bytes[p] > nine) return false
  return true
}
