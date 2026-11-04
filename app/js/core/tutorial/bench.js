// The tutorial's simulated bench: a multimeter and the adapter wiring for the practice board's J4.
// The app has no instrument and a pty has no pins, so these are small deterministic models. Pure: the
// clock and the random source are injected, there is no DOM and no service call.
//
// The practice board (pins are J4's: 1 3V3, 2 TX, 3 RX, 4 GND):
//   continuity, board unplugged: pin 4 beeps (0.0 Ω to the shell of the power jack), the others read OL.
//   continuity, board powered:   the meter refuses ("Unplug the board first"); nothing can be recorded.
//   DC volts, board unplugged:   0.00 V on every pin.
//   DC volts, board powered:     pin 1 a steady 3.30 V, pin 2 3.30 V while idle and a jumpy 2.0 to 3.3 V for
//                                three seconds after a power cycle (the boot messages), pin 3 a steady
//                                3.28 V (held high by a pull-up), pin 4 0.00 V.

export const BENCH_PINS = [1, 2, 3, 4];
export const ADAPTER_LINES = ['VCC', 'TXD', 'RXD', 'GND'];
export const MODES = ['continuity', 'dc'];
export const BOOT_MS = 3000;

const CORRECT = { VCC: null, TXD: 3, RXD: 2, GND: 4 };

const volts = (value) => ({ text: `${value.toFixed(2)} V`, kind: 'volts', mode: 'dc', value: Number(value.toFixed(2)), unit: 'V' });

export function createBench({ now = () => Date.now(), random = Math.random } = {}) {
  const state = { powered: false, mode: 'continuity', probe: null, cycledAt: null, wiring: { VCC: null, TXD: null, RXD: null, GND: null } };

  const settling = () => state.powered && state.cycledAt !== null && now() - state.cycledAt < BOOT_MS;

  /** What the meter shows now. `recordable` is false when there is nothing sensible to write down. */
  function read() {
    const pin = state.probe;
    if (!BENCH_PINS.includes(pin)) return { text: 'Choose a pin', kind: 'none', recordable: false, jumpy: false };
    if (state.mode === 'continuity') {
      if (state.powered) return { text: 'Unplug the board first', kind: 'warning', recordable: false, jumpy: false };
      return pin === 4
        ? { text: 'beep  0.0 Ω', kind: 'beep', mode: 'continuity', value: 0, unit: 'Ω', recordable: true, jumpy: false }
        : { text: 'OL', kind: 'ol', mode: 'ohm', value: null, unit: 'Ω', recordable: true, jumpy: false };
    }
    if (!state.powered || pin === 4) return { ...volts(0), recordable: true, jumpy: false };
    if (pin === 1) return { ...volts(3.3), recordable: true, jumpy: false };
    if (pin === 3) return { ...volts(3.28), recordable: true, jumpy: false };
    if (settling()) return { ...volts(2 + random() * 1.3), recordable: true, jumpy: true };
    return { ...volts(3.3), recordable: true, jumpy: false };
  }

  const wired = (line) => state.wiring[line];
  const flags = () => ({
    rxGetsTx: wired('RXD') === 2,
    txReachesRx: wired('TXD') === 3,
    grounded: wired('GND') === 4,
    vccConnected: wired('VCC') !== null,
    txdOnTx: wired('TXD') === 2,
    wiringCorrect: ADAPTER_LINES.every((line) => wired(line) === CORRECT[line]),
  });

  return {
    state: () => ({ ...state, wiring: { ...state.wiring } }),
    flags,
    read,
    settling,
    setPower(on) { state.powered = Boolean(on); if (!on) state.cycledAt = null; },
    /** Off and on again: the board boots, and pin 2 flickers for BOOT_MS. */
    powerCycle() { state.powered = true; state.cycledAt = now(); },
    setMode(mode) { if (MODES.includes(mode)) state.mode = mode; },
    setProbe(pin) { if (BENCH_PINS.includes(pin)) state.probe = pin; },
    /** Connect an adapter line to a header pin, or to nothing (null). */
    wire(line, pin) {
      if (!ADAPTER_LINES.includes(line)) return;
      if (pin !== null && !BENCH_PINS.includes(pin)) return;
      state.wiring[line] = pin;
    },
    /** The reading as the event a board stores it, or null when the meter shows nothing worth recording. */
    reading() {
      const shown = read();
      if (!shown.recordable) return null;
      return { ts: new Date(now()).toISOString(), mode: shown.mode, value: shown.value, unit: shown.unit, text: shown.kind === 'beep' ? 'beep' : shown.kind === 'volts' ? shown.text : 'OL', powered: state.powered, source: 'tutorial' };
    },
    /** Put the bench in the state a step starts from. Wiring is only touched where the step says so. */
    setup(spec) {
      if (!spec) return;
      if (spec.powered !== undefined) this.setPower(spec.powered);
      if (spec.mode) state.mode = spec.mode;
      if (spec.probe !== undefined) state.probe = spec.probe;
      if (spec.wiring === 'open') for (const line of ADAPTER_LINES) state.wiring[line] = null;
      if (spec.wiring === 'correct') Object.assign(state.wiring, CORRECT);
    },
  };
}

/** The bench as facts the lessons check, merged into the other facts. */
export function benchFacts(bench) {
  const state = bench.state();
  const flags = bench.flags();
  return {
    powered: state.powered,
    meterMode: state.mode,
    probe: state.probe,
    wiring: state.wiring,
    wiringCorrect: flags.wiringCorrect,
    rxGetsTx: flags.rxGetsTx,
    txReachesRx: flags.txReachesRx,
    grounded: flags.grounded,
    adapterVccConnected: flags.vccConnected,
    adapterTxdOnTx: flags.txdOnTx,
  };
}
