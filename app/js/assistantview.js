// The Agent panel: ask the bench assistant about the board, see what it looked at, and approve or decline
// the commands it suggests. Everything the model says is untrusted text and is only set with textContent.
// The assistant cannot run anything: a suggested command waits here for a click from the person, and the
// service checks it again before it is typed into the open console. Replies are Markdown, rendered by
// core/markdown.js, which builds DOM nodes and never HTML.

import { createLinkOpener } from './core/links.js';
import { renderMarkdown } from './core/markdown.js';
import { showInvisible } from './core/visible.js';
import { setGuided } from './guidance.js';
import { dom } from './dom.js';

// The two cloud slots are identical and named by the user; the ids stay because keys and usage are filed under them.
const DEFAULT_NAMES = { tutor: 'Quick', analyst: 'Thorough' };

/** What the user sees for a profile: the saved name of a cloud slot, or Local. */
export function profileLabel(id, settings) {
  if (id === 'local') return 'Local';
  return settings?.profiles?.[id]?.name || DEFAULT_NAMES[id] || id;
}
// From the photo trial in docs/SERVICE.md; shown as placeholders, never saved on their own.
const SUGGESTED_MODELS = { tutor: 'anthropic/claude-haiku-5.5', analyst: 'anthropic/claude-sonnet-5.5', local: '' };

/** A reset warning; the service already starts most messages with the profile's name. */
function warningText({ profile, message }, settings) {
  const label = profile === 'default' ? 'Default profile' : profileLabel(profile, settings);
  return `${message.startsWith(`${label}: `) ? message : `${label}: ${message}`}.`;
}

export function createAssistantView(doc, handlers) {
  const { $, el, options } = dom(doc);

  let settings = null;      // last GET /api/assistant
  let busy = false;
  let loaded = false;
  let history = null;       // promise for the redrawn conversation; questions wait for it so the order holds
  let editable = false;
  let proposalsLoaded = false;
  let generation = 0;       // bumped by reset(), so answers for the previous board are dropped
  const seenProposals = new Map();

  const status = (text) => { $('assistant-status').textContent = text; };
  const money = (n) => `$${Number(n || 0).toFixed(n < 0.01 && n > 0 ? 4 : 2)}`;
  let chosen = null;        // the profile that answers; the Settings dialog edits the same one
  const current = () => chosen || settings?.default || 'tutor';

  // The panel chooses the profile that answers; the Settings dialog chooses the one being edited. They follow each other.
  function choose(id) {
    const focused = $('assistant-profile').contains(doc.activeElement);
    chosen = id;
    $('assistant-config-profile').value = id;
    drawSwitch();
    if (focused) $('assistant-profile').querySelector(`[data-profile="${id}"]`)?.focus();
    fillSettings();
    if (!settings?.profiles?.[id]?.base_url) setGuided($('assistant-status'), 'Open Settings to add a server address, model and key for this profile.', 'No server address set.');
    else status('');
  }
  $('assistant-config-profile').addEventListener('change', () => choose($('assistant-config-profile').value));

  /** The switch in the Agent panel: one radio per profile, arrow keys move between them. */
  function drawSwitch() {
    const ids = Object.keys(settings?.profiles ?? {});
    const buttons = ids.map((id) => {
      const ready = Boolean(settings.profiles[id].base_url);
      const button = el('button', '', profileLabel(id, settings));
      button.type = 'button';
      button.dataset.profile = id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(id === current()));
      button.tabIndex = id === current() ? 0 : -1;
      if (!ready) {
        button.classList.add('not-set');
        button.append(el('span', 'visually-hidden', ' (not set up)'));
        button.title = 'Not set up yet: open Settings, Assistant';
      }
      button.addEventListener('click', () => choose(id));
      button.addEventListener('keydown', (event) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const next = ids[(ids.indexOf(id) + step + ids.length) % ids.length];
        choose(next);
        $('assistant-profile').querySelector(`[data-profile="${next}"]`)?.focus();
      });
      return button;
    });
    $('assistant-profile').replaceChildren(...buttons);
    const unset = ids.filter((id) => !settings.profiles[id].base_url).map((id) => profileLabel(id, settings));
    $('assistant-unset').hidden = unset.length === 0;
    setGuided($('assistant-unset'), `Not set up yet: ${unset.join(', ')}. Add them in Settings, Assistant.`, `Not set up: ${unset.join(', ')}.`);
  }
  $('assistant-reset').addEventListener('click', async () => {
    const started = generation;
    try { await handlers.assistantReset?.(); }
    catch (error) { if (started === generation) status(`Could not start a new conversation: ${error.message}`); return; }
    if (started !== generation) return;
    $('assistant-log').replaceChildren();
    $('assistant-proposals').replaceChildren();
    seenProposals.clear();
    status('New conversation.');
  });
  // Consent to send photos belongs to one server: a different address starts unticked.
  $('assistant-base').addEventListener('change', () => {
    const origin = (text) => { try { return new URL(text).origin; } catch { return ''; } };
    if (origin($('assistant-base').value) !== origin(settings?.profiles?.[current()]?.base_url ?? '')) $('assistant-photos').checked = false;
  });
  $('assistant-settings').addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveSettings();
  });
  $('assistant-key-clear').addEventListener('click', async () => {
    try { await handlers.assistantKey(current(), null); await refresh(); status('Key removed.'); }
    catch (error) { status(error.message); }
  });
  $('assistant-test').addEventListener('click', async () => {
    const button = $('assistant-test');
    const result = $('assistant-test-result');
    const started = generation;
    const name = current();
    button.disabled = true;
    result.textContent = 'The app asks the server.';
    try {
      const answer = await handlers.assistantTest(name);
      if (answer.totals && settings) { settings.usage = { ...settings.usage, [name]: answer.totals }; }
      if (started !== generation || name !== current()) return;
      drawUsage();
      result.textContent = answer.ok ? `It works: the server answered with ${answer.model}.${answer.note ? ` ${answer.note}` : ''}` : answer.message;
    } catch (error) {
      if (started === generation && name === current()) result.textContent = error.message;
    } finally { button.disabled = false; }
  });
  $('assistant-form').addEventListener('submit', (event) => { event.preventDefault(); ask($('assistant-input').value); });
  $('assistant-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); ask($('assistant-input').value); }
  });

  function showWarnings() {
    const reset = settings?.settings_warnings ?? [];
    const note = $('assistant-warnings');
    note.hidden = reset.length === 0;
    note.textContent = reset.length
      ? `Some saved settings were not valid. They show their defaults until you save them again. ${reset.map((w) => warningText(w, settings)).join(' ')}`
      : '';
  }

  function fillSettings() {
    showWarnings();
    const p = settings?.profiles?.[current()];
    if (!p) return;
    $('assistant-name-field').hidden = current() === 'local';
    $('assistant-name').value = current() === 'local' ? '' : profileLabel(current(), settings);
    $('assistant-base').value = p.base_url ?? '';
    $('assistant-model').value = p.model ?? '';
    $('assistant-model').placeholder = SUGGESTED_MODELS[current()] ?? '';
    $('assistant-price-in').value = p.price_in ?? 0;
    $('assistant-price-out').value = p.price_out ?? 0;
    $('assistant-photos').checked = p.photos === true;      // a missing value means off
    $('assistant-budget').value = p.budget === 'deep' ? 'deep' : 'normal';
    $('assistant-key').value = '';
    const ring = settings.keyring ?? {};
    $('assistant-key').disabled = !ring.available;
    $('assistant-key-state').textContent = !ring.available
      ? `The system keyring is not available, so the app cannot store a key${ring.detail ? ` (${ring.detail})` : ''}. On Plasma, open KWallet Manager. Make sure a wallet exists and is open, or log out and in again. A local model works without a key.`
      : p.key_set ? 'A key is stored in your system keyring.' : 'No key stored for this profile.';
    const local = current() === 'local';
    $('assistant-guide').querySelector('[data-guide="cloud"]').hidden = local;
    $('assistant-guide').querySelector('[data-guide="local"]').hidden = !local;
    $('assistant-test-result').textContent = '';
    $('assistant-key-clear').disabled = !p.key_set;
    drawUsage();
  }

  function drawUsage() {
    const u = settings?.usage?.[current()];
    $('assistant-usage').textContent = u
      ? `This profile so far: ${u.requests} questions, ${u.prompt_tokens + u.completion_tokens} tokens, about ${money(u.cost)}.`
      : '';
  }

  async function refresh() {
    try {
      settings = await handlers.assistantGet();
    } catch (error) { status(error.message); return; }
    const keep = chosen || settings.default;
    const choices = Object.keys(settings.profiles).map((name) => ({ value: name, label: profileLabel(name, settings) }));
    options($('assistant-config-profile'), choices);
    chosen = settings.profiles[keep] ? keep : settings.default;
    $('assistant-config-profile').value = chosen;
    drawSwitch();
    fillSettings();
    const p = settings.profiles[current()];
    if (!p.base_url) { setGuided($('assistant-status'), 'Choose a profile and open Settings to add a server address, model and key.', 'No server address set.'); }
  }

  async function saveSettings() {
    const name = current();
    try {
      const profiles = { [name]: {
        base_url: $('assistant-base').value.trim(), model: $('assistant-model').value.trim(),
        price_in: Number($('assistant-price-in').value) || 0, price_out: Number($('assistant-price-out').value) || 0,
        photos: $('assistant-photos').checked, budget: $('assistant-budget').value,
        ...(name === 'local' ? {} : { name: $('assistant-name').value.trim() }) } };
      const saved = await handlers.assistantSettings({ default: name, profiles });
      const cleared = saved?.keys_cleared?.includes(name);
      const key = $('assistant-key').value.trim();
      if (key) await handlers.assistantKey(name, key);
      $('assistant-key').value = '';          // the key is not kept on the page
      chosen = name;                           // saving makes this the profile that answers
      await refresh();
      status(cleared && !key ? 'Saved. The server address changed, so the app removed the stored key. Enter the key for the new server.' : 'Saved.');
    } catch (error) { status(error.message); }
  }

  function openExternal(href) {
    const win = doc.defaultView;
    const desktop = createLinkOpener(win, { question: "The assistant's reply links to:", report: (message) => addMessage('error', message) });
    if (desktop) return desktop(href);
    if (win.confirm(`The assistant's reply links to:\n\n${href}\n\nOpen it in a new tab?`)) win.open(href, '_blank', 'noopener,noreferrer');
  }

  function addMessage(role, text) {
    const item = el('div', `assistant-msg ${role}`);
    item.append(el('div', 'who', role === 'user' ? 'You' : role === 'error' ? 'Problem' : 'Assistant'));
    if (role === 'assistant') {
      const body = el('div', 'md');
      body.append(renderMarkdown(doc, text, { onWikiLink: (name) => handlers.onOpenWiki?.(name), confirmExternal: openExternal }));
      item.append(body);
    } else {
      item.append(el('p', '', text));
    }
    $('assistant-log').append(item);
    $('assistant-log').scrollTop = $('assistant-log').scrollHeight;
    return item;
  }

  /** Draw the conversation the service still holds, so a reload or a new window shows it again. */
  async function loadConversation() {
    const started = generation;
    let messages;
    try { messages = (await handlers.assistantConversation?.())?.messages ?? []; } catch { return; }
    if (started === generation && $('assistant-log').childElementCount === 0) for (const m of messages) addMessage(m.role, m.text);
  }

  async function ask(text, context) {
    text = (text ?? '').trim();
    if (!text || busy) return;
    busy = true;
    const started = generation;
    $('assistant-send').disabled = true;
    $('assistant-input').value = '';
    await history;
    if (started !== generation) return;      // reset() already freed Send; a question for the new board may hold it now
    addMessage('user', text);
    const thinking = addMessage('pending', 'The assistant writes an answer.');
    status('');
    try {
      const reply = await handlers.assistantChat({ message: text, profile: current(), ...(context ? { context } : {}) });
      if (started !== generation) return;
      thinking.remove();
      const item = addMessage('assistant', reply.reply);
      if (reply.tools?.length) {
        const box = el('details', 'assistant-tools');
        const list = el('ul');
        for (const t of reply.tools) list.append(el('li', t.error ? 'bad' : '', t.summary || t.name));
        box.append(el('summary', '', `What it did (${reply.tools.length})`), list);
        item.append(box);
      }
      const u = reply.usage;
      status(u ? `${reply.model}: ${u.prompt_tokens + u.completion_tokens} tokens, about ${money(u.cost)}.` : '');
      if (settings && reply.totals) { settings.usage = { ...settings.usage, [reply.profile]: reply.totals }; drawUsage(); }
      await loadProposals();
    } catch (error) {
      if (started !== generation) return;
      thinking.remove();
      addMessage('error', error.message);
      status('');
    } finally {
      if (started === generation) {
        busy = false;
        $('assistant-send').disabled = false;
      }
    }
  }

  async function loadProposals() {
    const started = generation;
    proposalsLoaded = true;
    let list;
    try { list = (await handlers.assistantProposals()).proposals; } catch {
      if (started === generation) proposalsLoaded = false;   // try again the next time the panel is shown
      return;
    }
    if (started !== generation) return;
    const box = $('assistant-proposals');
    box.replaceChildren(...list.filter((p) => p.status === 'pending' || p.status === 'refused' || p.status === 'failed' || seenProposals.has(p.id)).map(card));
    for (const p of list) seenProposals.set(p.id, p.status);
  }

  const STATUS_TEXT = { accepted: 'added as an AI guess', sent: 'sent to the console', declined: 'declined', refused: 'refused', failed: 'could not be added' };

  function card(p) {
    const kind = p.kind ?? 'command';
    const session = kind === 'command' ? handlers.serialIdentity?.() : null;
    const node = el('div', `assistant-card ${p.status}`);
    const title = { command: 'Suggested command', label: 'Suggested label', pins: `Suggested pin roles for ${p.header_label || 'a header'}` }[kind] ?? 'Suggestion';
    node.append(el('p', 'hint', p.status === 'pending' ? title : `${title}, ${STATUS_TEXT[p.status] ?? p.status}`));
    if (kind === 'command') {
      node.append(el('code', '', showInvisible(p.command)));
      if (session) node.append(el('p', 'hint', `Board: ${session.board}. Port: ${session.port}. Speed: ${session.baud} baud.`));
      if (p.reason) node.append(el('p', '', showInvisible(p.reason)));
    } else if (kind === 'label') {
      const line = el('p');
      line.append(el('strong', '', showInvisible(p.text)), ` · ${p.confidence} certainty`);
      node.append(line, el('p', 'evidence', showInvisible(p.evidence)));
    } else if (kind === 'pins') {
      const list = el('ul', 'guess-list');
      for (const pin of p.pins ?? []) {
        const row = el('li');
        row.append(el('strong', '', `Pin ${pin.pin}: ${showInvisible(pin.role)}`), ` · ${pin.confidence}. `, el('span', 'evidence', showInvisible(pin.evidence)));
        list.append(row);
      }
      node.append(list);
    }
    if (p.detail) node.append(el('p', 'hint', showInvisible(p.detail)));
    if (p.status === 'pending') {
      const row = el('div', 'assistant-actions');
      const yes = el('button', 'primary', kind === 'command' ? 'Send to console' : kind === 'pins' ? 'Add as AI guesses' : 'Add as AI guess');
      const no = el('button', '', 'Decline');
      yes.type = no.type = 'button';
      yes.disabled = !editable || (kind === 'command' && (!session || session.recordingError) && Boolean(handlers.serialIdentity));
      for (const [button, action] of [[yes, 'approve'], [no, 'decline']]) {
        button.addEventListener('click', async () => {
          const started = generation;
          row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          try {
            const receipt = await handlers.assistantDecide(p.id, action, session);
            if (started !== generation) return;
            if (receipt?.alreadyAccepted) seenProposals.delete(p.id);
            status(action === 'decline' ? 'Declined.' : kind === 'command' ? 'Sent to the console.' : 'Added as an AI guess. It stays marked as unverified until you check it.');
          } catch (error) { if (started !== generation) return; status(error.message); }
          await loadProposals();
        });
      }
      row.append(yes, no);
      node.append(row);
    }
    return node;
  }

  return {
    ensure() {
      if (!loaded) { loaded = true; refresh(); history = loadConversation(); }
      if (!proposalsLoaded) loadProposals();
    },
    render(_project, canEdit) { editable = canEdit; },
    serialChanged() { if (loaded) loadProposals(); },
    /** From "ask about this" buttons: show the question with its context and send it. */
    ask(text, context) { this.ensure(); return ask(text, context); },
    reset() {
      generation += 1;
      loaded = false; proposalsLoaded = false; settings = null; history = null; busy = false;
      $('assistant-send').disabled = false;
      $('assistant-log').replaceChildren();
      $('assistant-proposals').replaceChildren();
      seenProposals.clear();
      status('');
    },
  };
}
