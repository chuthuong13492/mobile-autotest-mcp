/** Terminal I/O behind an interface, so commands can be tested without a real terminal. */
import readline from 'node:readline/promises';

export interface Io {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  out(text: string): void;
  err(text: string): void;
  /** Prompts and reads one line from the terminal. */
  ask(prompt: string): Promise<string>;
}

export function processIo(): Io {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    out: (t) => void process.stdout.write(`${t}\n`),
    err: (t) => void process.stderr.write(`${t}\n`),
    async ask(prompt) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  };
}
