/**
 * Throwaway empirical probe for the Daytona session-command log stream.
 *
 * This script is a spike. It is not production code. It answers four open
 * questions about the callback form of `getSessionCommandLogs` in SDK 0.203.0:
 *
 *   1. Disconnect recovery: what happens to the stream and the command when
 *      the log stream disconnects during a command?
 *   2. Retry behavior: when you call the log method again after a disconnect,
 *      does Daytona resume, replay, duplicate, or omit bytes?
 *   3. Duplicate chunks: does the stream deliver duplicate chunks in normal
 *      operation?
 *   4. Exit-code timing: after the stream ends, when does `getSessionCommand`
 *      first return the final exit code?
 *
 * A first probe run showed the callback stream does not settle on its own when
 * the command finishes. The SDK `stdDemuxStream` resolves only on the socket
 * `close` event, and the `follow=true` socket stays open after the command
 * exits. So the probe detects command completion out of band. The probe polls
 * `getSessionCommand`. When the exit code is present, the probe waits a short
 * grace period for trailing chunks, then it stops reading. The probe records
 * whether the SDK stream promise settled on its own.
 *
 * The probe reads the API key from the environment variable `DAYTONA_API_KEY`.
 * It never writes the key to a file and never prints the key.
 *
 * Run:
 *   DAYTONA_API_KEY=... node --experimental-strip-types stream-probe.ts
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Daytona } from '@daytonaio/sdk'
import type { Sandbox } from '@daytonaio/sdk'

type ChunkRecord = {
  seq: number
  stream: 'stdout' | 'stderr'
  tMs: number
  bytes: number
  offsetStart: number
  offsetEnd: number
  sha256: string
  hasReplacementChar: boolean
  text: string
}

type StreamAttempt = {
  label: string
  outcome: 'sdk-resolved' | 'sdk-rejected' | 'watcher-stopped' | 'hard-cap'
  sdkPromiseSettled: boolean // did the SDK stream promise settle on its own?
  errorName: string | null
  errorMessage: string | null
  exitCodeFirstSeenMs: number | null // relative to stream start
  exitCodeValue: number | null
  lastChunkTMs: number | null
  chunks: ChunkRecord[]
  stdoutText: string
  stderrText: string
  stdoutBytes: number
  stderrBytes: number
}

const records: Record<string, unknown> = {}
const log = (msg: string): void => console.log(`[probe] ${msg}`)
const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
const nowMs = (): number => Number(process.hrtime.bigint() / 1000000n)
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

type StreamOptions = {
  label: string
  disconnectAfterStdoutChunks: number | null
  graceMsAfterComplete: number
  hardCapMs: number
}

/**
 * Stream one command with the callback form of `getSessionCommandLogs`.
 *
 * The function races the SDK stream promise against a completion watcher. The
 * watcher polls `getSessionCommand`. When the exit code appears, the watcher
 * waits `graceMsAfterComplete` for trailing chunks, then it stops the read.
 *
 * `disconnectAfterStdoutChunks` forces a client-side disconnect. When the count
 * of received stdout chunks reaches the value, the stdout callback throws. The
 * SDK catches the throw, closes the socket, and rejects the stream promise.
 */
async function streamCommand(
  sandbox: Sandbox,
  sessionId: string,
  commandId: string,
  opts: StreamOptions,
): Promise<StreamAttempt> {
  const chunks: ChunkRecord[] = []
  let seq = 0
  let stdoutOffset = 0
  let stderrOffset = 0
  let stdoutChunkCount = 0
  let lastChunkTMs: number | null = null
  const startedAtMs = nowMs()

  const record = (stream: 'stdout' | 'stderr', text: string): void => {
    const bytes = Buffer.byteLength(text, 'utf8')
    const offsetStart = stream === 'stdout' ? stdoutOffset : stderrOffset
    if (stream === 'stdout') stdoutOffset += bytes
    else stderrOffset += bytes
    lastChunkTMs = nowMs() - startedAtMs
    chunks.push({
      seq: seq++,
      stream,
      tMs: lastChunkTMs,
      bytes,
      offsetStart,
      offsetEnd: offsetStart + bytes,
      sha256: sha256(text),
      hasReplacementChar: text.includes('�'),
      text,
    })
    log(`  ${opts.label} chunk#${seq} ${stream} +${bytes}B t=${lastChunkTMs}ms`)
  }

  const onStdout = (chunk: string): void => {
    record('stdout', chunk)
    stdoutChunkCount++
    if (
      opts.disconnectAfterStdoutChunks !== null &&
      stdoutChunkCount >= opts.disconnectAfterStdoutChunks
    ) {
      throw new Error('PROBE_FORCED_DISCONNECT')
    }
  }
  const onStderr = (chunk: string): void => record('stderr', chunk)

  // Track SDK promise settlement without letting it end the race silently.
  let sdkSettled = false
  let sdkOutcome: 'sdk-resolved' | 'sdk-rejected' | null = null
  let errorName: string | null = null
  let errorMessage: string | null = null
  const sdkPromise = sandbox.process
    .getSessionCommandLogs(sessionId, commandId, onStdout, onStderr)
    .then(() => {
      sdkSettled = true
      sdkOutcome = 'sdk-resolved'
    })
    .catch((err: unknown) => {
      sdkSettled = true
      sdkOutcome = 'sdk-rejected'
      errorName = err instanceof Error ? err.name : String(err)
      errorMessage = err instanceof Error ? err.message : String(err)
    })

  // The completion watcher.
  let exitCodeFirstSeenMs: number | null = null
  let exitCodeValue: number | null = null
  let watcherReason: 'watcher-stopped' | 'hard-cap' = 'hard-cap'
  const watcher = (async () => {
    while (nowMs() - startedAtMs < opts.hardCapMs) {
      if (sdkSettled) return // the SDK ended the stream itself
      const cmd = await sandbox.process.getSessionCommand(sessionId, commandId)
      if (
        cmd.exitCode !== undefined &&
        cmd.exitCode !== null &&
        exitCodeFirstSeenMs === null
      ) {
        exitCodeFirstSeenMs = nowMs() - startedAtMs
        exitCodeValue = cmd.exitCode
        log(`  ${opts.label} exitCode=${cmd.exitCode} first seen at ${exitCodeFirstSeenMs}ms`)
      }
      if (
        exitCodeFirstSeenMs !== null &&
        nowMs() - startedAtMs - exitCodeFirstSeenMs >= opts.graceMsAfterComplete
      ) {
        watcherReason = 'watcher-stopped'
        return
      }
      await sleep(150)
    }
  })()

  await Promise.race([sdkPromise, watcher])
  // Give the SDK promise a brief moment to settle if the watcher won.
  await Promise.race([sdkPromise, sleep(50)])

  let outcome: StreamAttempt['outcome']
  if (sdkOutcome === 'sdk-rejected') outcome = 'sdk-rejected'
  else if (sdkOutcome === 'sdk-resolved') outcome = 'sdk-resolved'
  else outcome = watcherReason

  const stdoutText = chunks
    .filter((c) => c.stream === 'stdout')
    .map((c) => c.text)
    .join('')
  const stderrText = chunks
    .filter((c) => c.stream === 'stderr')
    .map((c) => c.text)
    .join('')

  return {
    label: opts.label,
    outcome,
    sdkPromiseSettled: sdkSettled,
    errorName,
    errorMessage,
    exitCodeFirstSeenMs,
    exitCodeValue,
    lastChunkTMs,
    chunks,
    stdoutText,
    stderrText,
    stdoutBytes: Buffer.byteLength(stdoutText, 'utf8'),
    stderrBytes: Buffer.byteLength(stderrText, 'utf8'),
  }
}

async function pollExitCode(
  sandbox: Sandbox,
  sessionId: string,
  commandId: string,
  label: string,
  maxWaitMs: number,
): Promise<Record<string, unknown>> {
  const startedAtMs = nowMs()
  let firstExitCode: number | undefined
  let firstExitCodeTMs: number | null = null
  let pollCount = 0
  while (nowMs() - startedAtMs < maxWaitMs) {
    const cmd = await sandbox.process.getSessionCommand(sessionId, commandId)
    pollCount++
    if (cmd.exitCode !== undefined && cmd.exitCode !== null) {
      firstExitCode = cmd.exitCode
      firstExitCodeTMs = nowMs() - startedAtMs
      break
    }
    await sleep(150)
  }
  return { label, firstExitCode, firstExitCodeTMs, pollCount }
}

const deleteSession = async (
  sandbox: Sandbox,
  sessionId: string,
): Promise<void> => {
  try {
    await sandbox.process.deleteSession(sessionId)
  } catch {
    /* ignore */
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.DAYTONA_API_KEY
  if (!apiKey) {
    console.error('[probe] DAYTONA_API_KEY is not set. Stop.')
    process.exit(2)
  }
  const outDir = process.env.PROBE_OUT_DIR ?? process.cwd()

  const NUM_LINES = 8
  const DELAY_S = 0.4
  const EXIT_CODE = 7
  const multibyte = 'café-日本語-✓'
  // Run the loop in a child `bash` process. A bare `exit N` in a session command
  // exits the persistent session shell itself. Then the toolbox records no
  // per-command exit code and `getSessionCommand.exitCode` stays undefined. The
  // base64 wrapper avoids all quote conflicts and keeps the session shell alive.
  const cmdInner =
    `for i in $(seq 1 ${NUM_LINES}); do ` +
    `printf 'OUT %02d ${multibyte}\\n' "$i"; ` +
    `printf 'ERR %02d ${multibyte}\\n' "$i" 1>&2; ` +
    `sleep ${DELAY_S}; ` +
    `done; ` +
    `exit ${EXIT_CODE}`
  const cmdB64 = Buffer.from(cmdInner, 'utf8').toString('base64')
  const cmdScript = `printf %s '${cmdB64}' | base64 -d | bash`

  log('create sandbox (this can take up to ~90s)')
  const daytona = new Daytona({ apiKey })
  let sandbox: Sandbox | null = null
  try {
    sandbox = await daytona.create()
    log(`sandbox id: ${sandbox.id}`)
    records.sandboxId = sandbox.id
    records.sdkVersion = '0.203.0'
    records.command = cmdScript
    records.commandInner = cmdInner

    // ---- Step 1: normal streaming (offsets, hashes, interleave, multibyte) ----
    const s1 = 'probe-normal'
    await sandbox.process.createSession(s1)
    const r1 = await sandbox.process.executeSessionCommand(s1, {
      command: cmdScript,
      runAsync: true,
    })
    const cmd1 = r1.cmdId
    log(`normal: started command ${cmd1}`)
    const normal = await streamCommand(sandbox, s1, cmd1, {
      label: 'normal',
      disconnectAfterStdoutChunks: null,
      graceMsAfterComplete: 3000,
      hardCapMs: 40000,
    })
    log(
      `normal: outcome=${normal.outcome} sdkSettled=${normal.sdkPromiseSettled} ` +
        `chunks=${normal.chunks.length} stdout=${normal.stdoutBytes}B stderr=${normal.stderrBytes}B`,
    )

    // Exit-code timing right after the clean stream end.
    const exitClean = await pollExitCode(sandbox, s1, cmd1, 'after-clean-end', 15000)
    log(`exit (clean): code=${exitClean.firstExitCode} at ${exitClean.firstExitCodeTMs}ms`)

    // Authoritative full buffer (non-callback form) for the normal command.
    const fullLogs = await sandbox.process.getSessionCommandLogs(s1, cmd1)
    const fullStdout = fullLogs.stdout ?? ''
    const fullStderr = fullLogs.stderr ?? ''

    // ---- Step 2 + 3: disconnect during command, then retry ----
    const s2 = 'probe-disconnect'
    await sandbox.process.createSession(s2)
    const r2 = await sandbox.process.executeSessionCommand(s2, {
      command: cmdScript,
      runAsync: true,
    })
    const cmd2 = r2.cmdId
    log(`disconnect: started command ${cmd2}`)
    const attempt1 = await streamCommand(sandbox, s2, cmd2, {
      label: 'disconnect-attempt-1',
      disconnectAfterStdoutChunks: 3,
      graceMsAfterComplete: 3000,
      hardCapMs: 40000,
    })
    log(
      `disconnect: attempt1 outcome=${attempt1.outcome} ` +
        `err=${attempt1.errorMessage ?? '-'} received stdout=${attempt1.stdoutBytes}B`,
    )

    const statusAfter = await sandbox.process.getSessionCommand(s2, cmd2)
    log(`disconnect: command exitCode right after disconnect = ${statusAfter.exitCode}`)

    // Retry: call the log method again for the same command.
    log('retry: second getSessionCommandLogs for the same command')
    const attempt2 = await streamCommand(sandbox, s2, cmd2, {
      label: 'disconnect-attempt-2',
      disconnectAfterStdoutChunks: null,
      graceMsAfterComplete: 3000,
      hardCapMs: 40000,
    })
    log(`retry: attempt2 outcome=${attempt2.outcome} received stdout=${attempt2.stdoutBytes}B`)

    const exitAfterFail = await pollExitCode(sandbox, s2, cmd2, 'after-failed-end', 15000)
    log(`exit (after disconnect): code=${exitAfterFail.firstExitCode} at ${exitAfterFail.firstExitCodeTMs}ms`)

    const fullLogs2 = await sandbox.process.getSessionCommandLogs(s2, cmd2)
    const fullStdout2 = fullLogs2.stdout ?? ''

    // ---- Analysis ----
    const attempt1Received = attempt1.stdoutText
    const attempt2Full = attempt2.stdoutText
    const attempt2StartsWithAttempt1 =
      attempt1Received.length > 0 && attempt2Full.startsWith(attempt1Received)
    const attempt2EqualsFull = attempt2Full === fullStdout2
    const attempt2OnlyTail =
      attempt1Received.length > 0 &&
      fullStdout2.endsWith(attempt2Full) &&
      !attempt2Full.startsWith(attempt1Received) &&
      attempt2Full.length < fullStdout2.length

    const normalMatchesFull = normal.stdoutText === fullStdout
    const stdoutLines = normal.stdoutText.split('\n').filter((l) => l.length > 0)
    const uniqueStdoutLines = new Set(stdoutLines)
    const normalHasDuplicateLines = stdoutLines.length !== uniqueStdoutLines.size
    const anySplitChar = [...normal.chunks, ...attempt1.chunks, ...attempt2.chunks].some(
      (c) => c.hasReplacementChar,
    )

    let retryVerdict = 'unknown'
    if (attempt2StartsWithAttempt1 && attempt2EqualsFull) retryVerdict = 'replay-full'
    else if (attempt2EqualsFull) retryVerdict = 'replay-full'
    else if (attempt2OnlyTail) retryVerdict = 'resume-tail'
    else if (attempt2Full.length === 0) retryVerdict = 'omit-empty'

    records.stepNormal = normal
    records.stepExitClean = exitClean
    records.stepFullBuffer = { stdout: fullStdout, stderr: fullStderr }
    records.stepDisconnectAttempt1 = attempt1
    records.stepDisconnectStatusAfter = { exitCode: statusAfter.exitCode }
    records.stepDisconnectAttempt2 = attempt2
    records.stepExitAfterFail = exitAfterFail
    records.stepFullBuffer2 = { stdout: fullStdout2, stderr: fullLogs2.stderr ?? '' }
    records.analysis = {
      streamSelfClosesOnCommandExit: normal.sdkPromiseSettled,
      normalStreamOutcome: normal.outcome,
      normalMatchesFull,
      normalHasDuplicateLines,
      normalStdoutLineCount: stdoutLines.length,
      normalUniqueStdoutLineCount: uniqueStdoutLines.size,
      anySplitChar,
      disconnectAttempt1Outcome: attempt1.outcome,
      disconnectAttempt1Error: attempt1.errorMessage,
      commandExitCodeRightAfterDisconnect: statusAfter.exitCode,
      commandExitCodeEventuallyReached: exitAfterFail.firstExitCode,
      retryVerdict,
      retryAttempt2StartsWithAttempt1: attempt2StartsWithAttempt1,
      retryAttempt2EqualsFullBuffer: attempt2EqualsFull,
      retryAttempt1ReceivedBytes: attempt1.stdoutBytes,
      retryAttempt2ReceivedBytes: attempt2.stdoutBytes,
      fullBufferBytes: Buffer.byteLength(fullStdout2, 'utf8'),
      exitCodeCleanFirstMs: exitClean.firstExitCodeTMs,
      exitCodeAfterFailFirstMs: exitAfterFail.firstExitCodeTMs,
      exitCodeValueClean: exitClean.firstExitCode,
      exitCodeSeenDuringNormalStreamMs: normal.exitCodeFirstSeenMs,
      normalLastChunkTMs: normal.lastChunkTMs,
    }

    await deleteSession(sandbox, s1)
    await deleteSession(sandbox, s2)

    const jsonPath = join(outDir, 'stream-probe-records.json')
    writeFileSync(jsonPath, JSON.stringify(records, null, 2), 'utf8')
    log(`wrote raw records: ${jsonPath}`)

    const a = records.analysis as Record<string, unknown>
    const summary = [
      '# Daytona log-stream probe - raw answers',
      '',
      `SDK: 0.203.0   sandbox: ${sandbox.id}`,
      `command (child, run via base64+bash): ${cmdInner}`,
      '',
      '## Q1 Disconnect recovery',
      `- stream self-closes on command exit: ${a.streamSelfClosesOnCommandExit}`,
      `- normal stream outcome: ${a.normalStreamOutcome}`,
      `- attempt-1 (forced disconnect) outcome: ${a.disconnectAttempt1Outcome}`,
      `- attempt-1 error: ${a.disconnectAttempt1Error}`,
      `- command exitCode right after disconnect: ${a.commandExitCodeRightAfterDisconnect}`,
      `- command exitCode eventually reached: ${a.commandExitCodeEventuallyReached}`,
      '',
      '## Q2 Retry behavior',
      `- verdict: ${a.retryVerdict}`,
      `- attempt-2 starts with attempt-1 bytes: ${a.retryAttempt2StartsWithAttempt1}`,
      `- attempt-2 equals full buffer: ${a.retryAttempt2EqualsFullBuffer}`,
      `- attempt-1 received bytes: ${a.retryAttempt1ReceivedBytes}`,
      `- attempt-2 received bytes: ${a.retryAttempt2ReceivedBytes}`,
      `- full buffer bytes: ${a.fullBufferBytes}`,
      '',
      '## Q3 Duplicate chunks (normal operation)',
      `- callback stdout equals full buffer: ${a.normalMatchesFull}`,
      `- has duplicate lines: ${a.normalHasDuplicateLines}`,
      `- stdout line count / unique: ${a.normalStdoutLineCount} / ${a.normalUniqueStdoutLineCount}`,
      `- any chunk split a multibyte char (U+FFFD): ${a.anySplitChar}`,
      '',
      '## Q4 Exit-code timing',
      `- first exit code value (clean end): ${a.exitCodeValueClean}`,
      `- exit code seen during normal stream at: ${a.exitCodeSeenDuringNormalStreamMs}ms`,
      `- normal stream last chunk at: ${a.normalLastChunkTMs}ms`,
      `- first exit code after clean stream end: ${a.exitCodeCleanFirstMs}ms`,
      `- first exit code after failed stream end: ${a.exitCodeAfterFailFirstMs}ms`,
      '',
    ].join('\n')
    const sumPath = join(outDir, 'stream-probe-summary.md')
    writeFileSync(sumPath, summary, 'utf8')
    log(`wrote summary: ${sumPath}`)
    console.log('\n' + summary)
  } finally {
    if (sandbox) {
      try {
        log('deleting sandbox')
        await daytona.delete(sandbox)
      } catch (err) {
        log(`sandbox delete failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

main().catch((err) => {
  console.error('[probe] fatal:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
