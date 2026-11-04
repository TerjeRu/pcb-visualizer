import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTER_LINES, BENCH_PINS, BOOT_MS, createBench } from '../js/core/tutorial/bench.js';

function make(values = [0.5]) {
  const clock = { t: 1_000_000 };
  let i = 0;
  const bench = createBench({ now: () => clock.t, random: () => values[i++ % values.length] });
  return { bench, clock };
}

test('continuity on an unplugged board: pin 4 beeps, the others read OL', () => {
  const { bench } = make();
  bench.setMode('continuity');
  bench.setProbe(4);
  assert.deepEqual(bench.read(), { text: 'beep  0.0 Ω', kind: 'beep', mode: 'continuity', value: 0, unit: 'Ω', recordable: true, jumpy: false });
  for (const pin of [1, 2, 3]) {
    bench.setProbe(pin);
    assert.equal(bench.read().text, 'OL');
    assert.equal(bench.read().kind, 'ol');
  }
});

test('continuity on a powered board is refused and cannot be recorded', () => {
  const { bench } = make();
  bench.setMode('continuity');
  bench.setProbe(4);
  bench.setPower(true);
  const shown = bench.read();
  assert.equal(shown.text, 'Unplug the board first');
  assert.equal(shown.recordable, false);
  assert.equal(bench.reading(), null);
});

test('no pin chosen: the meter asks for one', () => {
  const { bench } = make();
  assert.equal(bench.read().text, 'Choose a pin');
  assert.equal(bench.reading(), null);
  bench.setProbe(9);
  bench.setProbe(0);
  bench.setProbe('2');
  assert.equal(bench.state().probe, null, 'only pins 1 to 4 are accepted');
});

test('DC volts: an unplugged board reads 0.00 V everywhere', () => {
  const { bench } = make();
  bench.setMode('dc');
  for (const pin of BENCH_PINS) {
    bench.setProbe(pin);
    assert.equal(bench.read().text, '0.00 V');
  }
});

test('DC volts on a powered board: 3.30 V, idle 3.30 V, 3.28 V and ground', () => {
  const { bench } = make();
  bench.setMode('dc');
  bench.setPower(true);
  const text = (pin) => { bench.setProbe(pin); return bench.read().text; };
  assert.deepEqual(BENCH_PINS.map(text), ['3.30 V', '3.30 V', '3.28 V', '0.00 V']);
});

test('pin 2 is jumpy for three seconds after a power cycle and then settles at 3.30 V', () => {
  const { bench, clock } = make([0, 1, 0.5]);
  bench.setMode('dc');
  bench.setProbe(2);
  bench.powerCycle();
  assert.equal(bench.settling(), true);
  const first = bench.read();
  assert.equal(first.jumpy, true);
  assert.equal(first.text, '2.00 V', 'random 0 gives the low end');
  assert.equal(bench.read().text, '3.30 V', 'random 1 gives the high end');
  assert.equal(bench.read().text, '2.65 V');
  clock.t += BOOT_MS - 1;
  assert.equal(bench.read().jumpy, true);
  clock.t += 1;
  assert.equal(bench.settling(), false);
  assert.deepEqual([bench.read().text, bench.read().jumpy], ['3.30 V', false]);
});

test('the other pins stay steady during the boot window, and unplugging ends it', () => {
  const { bench } = make([0]);
  bench.setMode('dc');
  bench.powerCycle();
  for (const [pin, text] of [[1, '3.30 V'], [3, '3.28 V'], [4, '0.00 V']]) {
    bench.setProbe(pin);
    assert.equal(bench.read().text, text);
    assert.equal(bench.read().jumpy, false);
  }
  bench.setPower(false);
  assert.equal(bench.settling(), false);
  bench.setProbe(2);
  assert.equal(bench.read().text, '0.00 V');
});

test('the recorded reading has the shape the board stores', () => {
  const { bench, clock } = make();
  bench.setProbe(4);
  assert.deepEqual(bench.reading(), { ts: new Date(clock.t).toISOString(), mode: 'continuity', value: 0, unit: 'Ω', text: 'beep', powered: false, source: 'tutorial' });
  bench.setProbe(1);
  assert.deepEqual(bench.reading(), { ts: new Date(clock.t).toISOString(), mode: 'ohm', value: null, unit: 'Ω', text: 'OL', powered: false, source: 'tutorial' });
  bench.setMode('dc');
  bench.setPower(true);
  assert.deepEqual(bench.reading(), { ts: new Date(clock.t).toISOString(), mode: 'dc', value: 3.3, unit: 'V', text: '3.30 V', powered: true, source: 'tutorial' });
});

test('a mode that does not exist is ignored', () => {
  const { bench } = make();
  bench.setMode('ohms');
  assert.equal(bench.state().mode, 'continuity');
});

// Wiring: every combination of the four adapter lines on the four pins or open.
test('wiring flags for every combination', () => {
  const { bench } = make();
  const options = [null, 1, 2, 3, 4];
  let combinations = 0;
  for (const VCC of options) for (const TXD of options) for (const RXD of options) for (const GND of options) {
    for (const [line, pin] of Object.entries({ VCC, TXD, RXD, GND })) bench.wire(line, pin);
    const flags = bench.flags();
    assert.equal(flags.rxGetsTx, RXD === 2);
    assert.equal(flags.txReachesRx, TXD === 3);
    assert.equal(flags.grounded, GND === 4);
    assert.equal(flags.vccConnected, VCC !== null);
    assert.equal(flags.txdOnTx, TXD === 2);
    assert.equal(flags.wiringCorrect, VCC === null && TXD === 3 && RXD === 2 && GND === 4);
    combinations += 1;
  }
  assert.equal(combinations, 625);
});

test('wire ignores unknown lines and pins', () => {
  const { bench } = make();
  bench.wire('VCC', 7);
  bench.wire('CTS', 1);
  bench.wire('TXD', '3');
  assert.deepEqual(bench.state().wiring, { VCC: null, TXD: null, RXD: null, GND: null });
  assert.deepEqual(ADAPTER_LINES, ['VCC', 'TXD', 'RXD', 'GND']);
});

test('setup puts the bench in a known state and touches wiring only when told to', () => {
  const { bench } = make();
  bench.wire('TXD', 3);
  bench.setup({ powered: true, mode: 'dc', probe: 2 });
  assert.deepEqual(bench.state(), { powered: true, mode: 'dc', probe: 2, cycledAt: null, wiring: { VCC: null, TXD: 3, RXD: null, GND: null } });
  bench.setup({ wiring: 'correct' });
  assert.equal(bench.flags().wiringCorrect, true);
  bench.setup({ wiring: 'open' });
  assert.deepEqual(bench.state().wiring, { VCC: null, TXD: null, RXD: null, GND: null });
  bench.setup(null);
  bench.setup(undefined);
});

test('state() is a copy', () => {
  const { bench } = make();
  bench.state().wiring.VCC = 1;
  assert.equal(bench.state().wiring.VCC, null);
});
