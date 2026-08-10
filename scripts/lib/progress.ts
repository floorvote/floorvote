/**
 * Progress output that survives being redirected to a file.
 *
 * The seeders report progress with `\r`-rewritten lines so a terminal shows a
 * single updating counter instead of hundreds of rows. That is right on a TTY
 * and actively harmful off one: `\r` is not a line terminator, so a run piped
 * to `tail`, redirected with `>`, or backgrounded produces *no complete line
 * at all* until the process exits. A multi-hour seed then looks completely
 * silent — indistinguishable from a hang.
 *
 * (Past bug: a background `seed-legiscan.ts ... | tail -60` on a 935-bill
 * session wrote an empty output file for its entire run while the seed was in
 * fact progressing normally. The only way to see progress was to poll central's
 * D1 from another shell.)
 *
 * So: rewrite in place when stdout is a TTY, and emit one newline-terminated
 * line per update otherwise, which is what a log file wants. The formatters are
 * kept pure and take `isTty` explicitly so they can be tested without faking
 * a terminal.
 */

/** Render a progress update: in-place rewrite on a TTY, one line per call in a log. */
export function formatProgress(line: string, isTty: boolean): string {
  return isTty ? `\r${line}` : `${line}\n`
}

/**
 * Render the line that closes a progress sequence.
 *
 * On a TTY the leading `\r` overwrites the last counter; in a log it would just
 * be a stray control character, so it is omitted.
 */
export function formatProgressDone(line: string, isTty: boolean): string {
  return isTty ? `\r${line}\n` : `${line}\n`
}

/** Write a progress update to stdout, adapting to whether stdout is a terminal. */
export function progress(line: string): void {
  process.stdout.write(formatProgress(line, Boolean(process.stdout.isTTY)))
}

/** Write the final line of a progress sequence to stdout. */
export function progressDone(line: string): void {
  process.stdout.write(formatProgressDone(line, Boolean(process.stdout.isTTY)))
}
