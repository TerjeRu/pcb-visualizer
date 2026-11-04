// What the Console panel has shown during the tutorial, as facts for the lessons. Every fact comes from text the
// board sent, never from what the person typed: the board echoes typed characters after its prompt, and a prompt
// only counts when it starts a line, so typing a prompt does not fake one. Pure: the Console view reports
// events and this keeps the state. No DOM, no service calls.

import { createScreen } from '../terminal.js';

export const BOARD_BAUD = 115200;
export const UBOOT_PROMPT = 'ARC7621 # ';
export const SHELL_PROMPT = 'root@ARC-DEMO:/# ';
const GARBLE_CHARS = 5;                  // non-ASCII characters at a wrong speed before it counts as noise
const ENV_LINES = ['bootargs=', 'bootcmd=', 'baudrate=115200'];

// The results a recording can show; what describes the current session (Linux started, a line typed too early) is not among them.
const MERGED = ['portOpen', 'sawGarble', 'sawBanner', 'sawFlash', 'ubootPrompt', 'ranPrintenv', 'shellPrompt', 'ranShellCommand'];

const startsWith = (lines, prefix) => lines.some((line) => line.startsWith(prefix));

export function createConsoleFacts() {
  let screen = createScreen();           // text received at the board's own speed, for the current session
  let sessionId = null;
  let baud = 0;                          // the speed of the open session, else the one chosen in the select
  let open = false;
  let state = fresh();

  function fresh() {
    return { opened: false, junk: 0, sawBanner: false, sawFlash: false, sawKernel: false, ubootPrompt: false, ranPrintenv: false,
      shellPrompt: false, ranShellCommand: false, earlyLine: false, vdevRunning: false };
  }

  function look() {
    const lines = screen.lines();
    if (lines.some((line) => /^U-Boot \d{4}\.\d{2}/.test(line))) state.sawBanner = true;
    if (startsWith(lines, 'SF: Detected 25Q128')) state.sawFlash = true;
    if (startsWith(lines, 'Starting kernel')) state.sawKernel = true;
    if (startsWith(lines, UBOOT_PROMPT)) state.ubootPrompt = true;
    if (ENV_LINES.every((prefix) => startsWith(lines, prefix))) state.ranPrintenv = true;
    if (startsWith(lines, SHELL_PROMPT)) state.shellPrompt = true;
    // A command was run when a prompt line with the echoed command is followed by a fresh prompt line.
    const echoed = lines.findIndex((line) => line.startsWith(SHELL_PROMPT) && line.slice(SHELL_PROMPT.length).trim() !== '');
    if (echoed !== -1 && startsWith(lines.slice(echoed + 1), SHELL_PROMPT)) state.ranShellCommand = true;
  }

  return {
    /** The session changed: `info` is {captureId, baud} while a port is open, null when it closed. */
    session(info) {
      open = Boolean(info);
      if (!info) return;
      baud = info.baud;
      state.opened = true;
      if (info.captureId !== sessionId) {
        sessionId = info.captureId;
        screen = createScreen();
        state.earlyLine = false;
        state.sawKernel = false;         // the hints follow this boot, so Linux from an earlier session does not count
      }
    },
    /** The speed chosen in the select while no port is open. */
    chose(value) { if (!open) baud = value; },
    /** Text the board sent. At the wrong speed only the noise is counted. */
    data(text) {
      if (!open) return;
      if (baud !== BOARD_BAUD) {
        let junk = 0;
        for (const ch of String(text ?? '')) if (ch > '\x7f') junk += 1;
        state.junk += junk;
        return;
      }
      screen.write(text);
      look();
    },
    /** The session's recent text, which the service sends again on every reconnect: it replaces what was seen, so nothing is read twice. */
    backlog(text) {
      if (!open) return;
      screen = createScreen();
      this.data(text);
    },
    /** Something was sent to the board. A line before the U-Boot prompt is the mistake the hint is about. */
    sent(kind) { if (kind === 'line' && !state.ubootPrompt) state.earlyLine = true; },
    vdev(running) { state.vdevRunning = Boolean(running); },
    /** Results found elsewhere (the board's earlier recordings): they are added to what is known, never taken away. */
    merge(found) {
      if (!found || typeof found !== 'object') return;
      for (const name of MERGED) if (found[name] === true) {
        if (name === 'sawGarble') state.junk = Math.max(state.junk, GARBLE_CHARS);
        else if (name === 'portOpen') state.opened = true;
        else state[name] = true;
      }
    },
    reset() {
      screen = createScreen();
      sessionId = null;
      open = false;
      baud = 0;
      state = fresh();
    },
    facts() {
      return {
        baud, portOpen: state.opened, portIsOpen: open, vdevRunning: state.vdevRunning,
        sawGarble: state.junk >= GARBLE_CHARS, sawBanner: state.sawBanner, sawFlash: state.sawFlash, sawKernel: state.sawKernel,
        ubootPrompt: state.ubootPrompt, ranPrintenv: state.ranPrintenv, shellPrompt: state.shellPrompt,
        ranShellCommand: state.ranShellCommand, typedBeforePrompt: state.earlyLine && !state.ubootPrompt,
      };
    },
  };
}

/** What console recordings (`[{captureId, baud, text}]`, oldest first) showed, as the facts that last; text is only compared, never shown. */
export function factsFromRecordings(recordings) {
  const found = {};
  for (const { captureId, baud, text } of recordings) {
    const facts = createConsoleFacts();
    facts.session({ captureId, baud });
    facts.data(text);
    facts.session(null);
    const seen = facts.facts();
    for (const name of MERGED) if (seen[name]) found[name] = true;
  }
  return found;
}
