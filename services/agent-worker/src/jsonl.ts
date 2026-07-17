import { StringDecoder } from "node:string_decoder";

export interface JsonLineBatch {
  readonly lines: readonly string[];
  readonly dropped: number;
}

/** UTF-8 aware, bounded JSONL splitter. Oversized lines are discarded in full. */
export class BoundedJsonLineDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxLineLength: number;
  #buffer = "";
  #bufferBytes = 0;
  #discarding = false;

  constructor(maxLineLength: number) {
    if (!Number.isSafeInteger(maxLineLength) || maxLineLength < 128) {
      throw new Error("JSON line limit is invalid");
    }
    this.#maxLineLength = maxLineLength;
  }

  write(chunk: Buffer | string): JsonLineBatch {
    return this.#consume(typeof chunk === "string" ? chunk : this.#decoder.write(chunk));
  }

  end(): JsonLineBatch {
    const decoded = this.#consume(this.#decoder.end());
    const lines = [...decoded.lines];
    let dropped = decoded.dropped;
    if (this.#discarding) {
      dropped += 1;
    } else if (this.#buffer.trim()) {
      lines.push(stripCarriageReturn(this.#buffer));
    }
    this.#buffer = "";
    this.#bufferBytes = 0;
    this.#discarding = false;
    return Object.freeze({ lines: Object.freeze(lines), dropped });
  }

  #consume(value: string): JsonLineBatch {
    const lines: string[] = [];
    let dropped = 0;
    for (const character of value) {
      if (this.#discarding) {
        if (character === "\n") {
          this.#discarding = false;
          dropped += 1;
        }
        continue;
      }
      if (character === "\n") {
        lines.push(stripCarriageReturn(this.#buffer));
        this.#buffer = "";
        this.#bufferBytes = 0;
        continue;
      }
      this.#buffer += character;
      this.#bufferBytes += Buffer.byteLength(character, "utf8");
      if (this.#bufferBytes > this.#maxLineLength) {
        this.#buffer = "";
        this.#bufferBytes = 0;
        this.#discarding = true;
      }
    }
    return Object.freeze({ lines: Object.freeze(lines), dropped });
  }
}

function stripCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}
