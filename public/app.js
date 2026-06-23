/* ============================================================
   Fugu · Sakana AI — client logic
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const els = {
  stream: $('#stream'),
  welcome: $('#welcome'),
  input: $('#input'),
  send: $('#send'),
  attachBtn: $('#attachBtn'),
  fileInput: $('#fileInput'),
  attachments: $('#attachments'),
  dropzone: $('#dropzone'),
  model: $('#model'),
  effort: $('#effort'),
  webSearch: $('#webSearch'),
  usage: $('#usage'),
  historyBtn: $('#historyBtn'),
  newChat: $('#newChat'),
  settingsBtn: $('#settingsBtn'),
  themeToggle: $('#themeToggle'),
  settingsModal: $('#settingsModal'),
  closeSettings: $('#closeSettings'),
  historyModal: $('#historyModal'),
  closeHistory: $('#closeHistory'),
  historyList: $('#historyList'),
  keyRow: $('#keyRow'),
  apiKey: $('#apiKey'),
  saveKey: $('#saveKey'),
  instructions: $('#instructions'),
  skillInput: $('#skillInput'),
  addSkill: $('#addSkill'),
  skillsList: $('#skillsList'),
  maxTokens: $('#maxTokens'),
  testKey: $('#testKey'),
  testResult: $('#testResult'),
  wipe: $('#wipe'),
  toast: $('#toast'),
};

const state = {
  conversation: [],      // { role, text, attachments[], usage?, error? }
  pending: [],           // attachments staged for the next user message
  uploadingCount: 0,
  settings: { model: 'fugu', effort: 'high', webSearch: false, instructions: '', skills: [], maxTokens: '' },
  apiKey: '',
  hasEnvKey: false,
  chats: [],              // { id, title, updatedAt, messages[], totalTokens }
  currentChatId: null,
  totalTokens: 0,
  controller: null,      // AbortController for the in-flight generation
  generating: false,
};

/* ───────────────────────── icons ───────────────────────── */
const ICON = {
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.5 3.2-5.5 7-5.5s7 2 7 5.5"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3v5h5"/><path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 011-1h10"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 11a8 8 0 10-1.5 5"/><path d="M20 4v6h-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>',
  puffer: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="30" cy="34" r="17"/><path d="M30 17v-7M30 51v7M13 34h-7M47 34h7M18 22l-5-5M42 22l5-5M18 46l-5 5M42 46l5 5"/><path d="M47 30q9-5 11-1q-3 5 0 12q-5 1-11-5"/><circle cx="24" cy="30" r="2.4" fill="currentColor" stroke="none"/><path d="M36 38q4 2 7 0"/></svg>',
};

/* ───────────────────────── init ───────────────────────── */
async function init() {
  loadState();
  applySettingsToUI();
  bindEvents();
  renderConversation();
  updateUsageDisplay();

  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    state.hasEnvKey = h.hasEnvKey;
    if (!state.hasEnvKey && !state.apiKey) {
      els.keyRow.hidden = false;
      openSettings();
      toast('Ajoutez votre clé API Sakana pour commencer');
    } else if (!state.hasEnvKey) {
      els.keyRow.hidden = false; // allow editing the locally-stored key
    }
  } catch (e) {
    toast('Serveur injoignable');
  }
}

/* ───────────────────────── persistence ───────────────────────── */
function slimAttachment(a) {
  return { kind: a.kind, name: a.name, size: a.size, meta: a.meta || null };
}
function serializeConversation(conversation) {
  return conversation.map((m) => ({
    role: m.role,
    text: m.text,
    usage: m.usage || null,
    error: m.error || null,
    attachments: (m.attachments || []).map(slimAttachment),
  }));
}
function saveState() {
  try {
    persistCurrentChat();
    localStorage.setItem('fugu.chats', JSON.stringify(state.chats));
    if (state.currentChatId) localStorage.setItem('fugu.activeChat', state.currentChatId);
    else localStorage.removeItem('fugu.activeChat');
    localStorage.setItem('fugu.conv', JSON.stringify(serializeConversation(state.conversation)));
    localStorage.setItem('fugu.settings', JSON.stringify(state.settings));
    localStorage.setItem('fugu.total', String(state.totalTokens));
  } catch (e) {
    try {
      localStorage.setItem('fugu.settings', JSON.stringify(state.settings));
    } catch (_) { /* ignore */ }
  }
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('fugu.settings') || 'null');
    if (s) state.settings = { ...state.settings, ...s };
    const chats = JSON.parse(localStorage.getItem('fugu.chats') || 'null');
    if (Array.isArray(chats)) {
      state.chats = chats
        .filter((c) => c && c.id && Array.isArray(c.messages))
        .map((c) => ({
          id: c.id,
          title: c.title || 'Nouvelle discussion',
          updatedAt: Number(c.updatedAt) || Date.now(),
          messages: c.messages,
          totalTokens: Number(c.totalTokens) || 0,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const active = localStorage.getItem('fugu.activeChat');
    const activeChat = state.chats.find((c) => c.id === active) || state.chats[0];
    if (activeChat) {
      state.currentChatId = activeChat.id;
      state.conversation = activeChat.messages || [];
      state.totalTokens = activeChat.totalTokens || 0;
    } else {
      const c = JSON.parse(localStorage.getItem('fugu.conv') || 'null');
      if (Array.isArray(c) && c.length) {
        state.conversation = c;
        state.totalTokens = Number(localStorage.getItem('fugu.total') || 0) || 0;
        const migrated = buildChat(state.conversation, state.totalTokens);
        state.chats = [migrated];
        state.currentChatId = migrated.id;
      }
    }
    state.apiKey = localStorage.getItem('fugu.key') || '';
  } catch (_) { /* ignore */ }
}

function makeChatId() {
  try { return crypto.randomUUID(); } catch (_) { return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function buildChat(messages, totalTokens = 0) {
  return {
    id: makeChatId(),
    title: deriveChatTitle(messages),
    updatedAt: Date.now(),
    messages: serializeConversation(messages),
    totalTokens,
  };
}

function persistCurrentChat() {
  if (!state.conversation.length) return;
  if (!state.currentChatId) {
    const chat = buildChat(state.conversation, state.totalTokens);
    state.currentChatId = chat.id;
    state.chats.unshift(chat);
    return;
  }
  let chat = state.chats.find((c) => c.id === state.currentChatId);
  if (!chat) {
    chat = buildChat(state.conversation, state.totalTokens);
    chat.id = state.currentChatId;
    state.chats.unshift(chat);
  }
  chat.title = deriveChatTitle(state.conversation);
  chat.updatedAt = Date.now();
  chat.messages = serializeConversation(state.conversation);
  chat.totalTokens = state.totalTokens;
  state.chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

function deriveChatTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user' && (((m.text || '').trim()) || (m.attachments || []).length));
  if (!firstUser) return 'Nouvelle discussion';
  const text = (firstUser.text || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 56 ? `${text.slice(0, 55)}…` : text;
  const names = (firstUser.attachments || []).map((a) => a.name).filter(Boolean).slice(0, 2).join(', ');
  return names || 'Discussion avec fichiers';
}

function normalizeSkills(value) {
  if (Array.isArray(value)) return value.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function applySettingsToUI() {
  state.settings.skills = normalizeSkills(state.settings.skills);
  els.model.value = state.settings.model;
  els.effort.value = state.settings.effort;
  els.instructions.value = state.settings.instructions || '';
  els.skillInput.value = '';
  renderSkillsList();
  els.maxTokens.value = state.settings.maxTokens || '';
  setWebSearch(state.settings.webSearch, false);
  if (state.apiKey) els.apiKey.value = state.apiKey;
}

/* ───────────────────────── events ───────────────────────── */
function bindEvents() {
  els.send.addEventListener('click', () => (state.generating ? stopGeneration() : send()));
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  els.input.addEventListener('input', autoresize);

  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); els.fileInput.value = ''; });

  // drag & drop
  ['dragenter', 'dragover'].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === els.dropzone) els.dropzone.classList.remove('dragover'); }));
  els.dropzone.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });

  // paste images
  els.input.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgs = items.filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
    if (imgs.length) { e.preventDefault(); handleFiles(imgs); }
  });

  els.model.addEventListener('change', () => { state.settings.model = els.model.value; saveState(); });
  els.effort.addEventListener('change', () => { state.settings.effort = els.effort.value; saveState(); });
  els.webSearch.addEventListener('click', () => setWebSearch(!state.settings.webSearch, true));

  els.historyBtn.addEventListener('click', openHistory);
  els.newChat.addEventListener('click', newChat);

  els.settingsBtn.addEventListener('click', openSettings);
  els.themeToggle.addEventListener('click', toggleTheme);
  els.closeSettings.addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', (e) => { if (e.target === els.settingsModal) closeSettings(); });
  els.closeHistory.addEventListener('click', closeHistory);
  els.historyModal.addEventListener('click', (e) => { if (e.target === els.historyModal) closeHistory(); });
  els.instructions.addEventListener('input', () => { state.settings.instructions = els.instructions.value; saveState(); });
  els.addSkill.addEventListener('click', addSkillFromInput);
  els.skillInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') addSkillFromInput();
  });
  els.maxTokens.addEventListener('input', () => { state.settings.maxTokens = els.maxTokens.value; saveState(); });
  els.saveKey.addEventListener('click', saveApiKey);
  els.apiKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveApiKey(); });
  els.testKey.addEventListener('click', testConnection);
  els.wipe.addEventListener('click', wipeAll);

  document.querySelectorAll('.chip-suggest').forEach((b) =>
    b.addEventListener('click', () => { els.input.value = b.textContent.replace(/\s+\?$/, ' ?'); autoresize(); els.input.focus(); }));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.settingsModal.hidden) closeSettings();
    if (!els.historyModal.hidden) closeHistory();
  });
}

function setWebSearch(on, persist) {
  state.settings.webSearch = on;
  els.webSearch.setAttribute('aria-pressed', String(on));
  if (persist) saveState();
}

/* ───────────────────────── skills ───────────────────────── */
function addSkillFromInput() {
  const skill = els.skillInput.value.trim();
  if (!skill) return;
  state.settings.skills = normalizeSkills(state.settings.skills);
  state.settings.skills.push(skill);
  els.skillInput.value = '';
  renderSkillsList();
  saveState();
  toast('Skill ajouté');
}

function removeSkill(index) {
  state.settings.skills = normalizeSkills(state.settings.skills);
  state.settings.skills.splice(index, 1);
  renderSkillsList();
  saveState();
  toast('Skill supprimé');
}

function renderSkillsList() {
  state.settings.skills = normalizeSkills(state.settings.skills);
  els.skillsList.innerHTML = '';

  if (!state.settings.skills.length) {
    const empty = document.createElement('div');
    empty.className = 'skills-empty';
    empty.textContent = 'Aucun skill ajouté.';
    els.skillsList.appendChild(empty);
    return;
  }

  state.settings.skills.forEach((skill, index) => {
    const item = document.createElement('div');
    item.className = 'skill-item';

    const body = document.createElement('div');
    body.className = 'skill-body';
    const title = document.createElement('div');
    title.className = 'skill-title';
    title.textContent = firstSkillLine(skill);
    const preview = document.createElement('div');
    preview.className = 'skill-preview';
    preview.textContent = skill;
    body.append(title, preview);

    const del = document.createElement('button');
    del.className = 'skill-delete';
    del.type = 'button';
    del.title = 'Supprimer';
    del.setAttribute('aria-label', 'Supprimer le skill');
    del.innerHTML = ICON.trash;
    del.addEventListener('click', () => removeSkill(index));

    item.append(body, del);
    els.skillsList.appendChild(item);
  });
}

function firstSkillLine(skill) {
  const first = String(skill || '').split('\n').map((line) => line.trim()).find(Boolean) || 'Skill';
  return first.length > 68 ? `${first.slice(0, 67)}…` : first;
}

/* ───────────────────────── files ───────────────────────── */
async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  state.uploadingCount += files.length;
  renderAttachments();

  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const json = await res.json();
    state.uploadingCount = Math.max(0, state.uploadingCount - files.length);
    (json.files || []).forEach((p) => {
      if (p.kind === 'error') toast(`${p.name} — ${p.message}`);
      else state.pending.push(p);
    });
  } catch (e) {
    state.uploadingCount = Math.max(0, state.uploadingCount - files.length);
    toast('Échec du téléversement des fichiers');
  }
  renderAttachments();
}

function renderAttachments() {
  const has = state.pending.length || state.uploadingCount;
  els.attachments.hidden = !has;
  els.attachments.innerHTML = '';

  state.pending.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const thumb = a.kind === 'image' && a.dataUrl
      ? `<img src="${a.dataUrl}" alt="" />`
      : `<span class="chip-ic">${ICON.file}</span>`;
    const sub = a.kind === 'image' ? 'image' : (a.meta?.pages ? `${a.meta.pages} p.` : fmtSize(a.size));
    chip.innerHTML = `
      ${thumb}
      <div class="chip-meta">
        <div class="chip-name">${escapeHtml(a.name)}</div>
        <div class="chip-sub">${sub}</div>
      </div>
      <button class="chip-remove" title="Retirer">${ICON.close}</button>`;
    chip.querySelector('.chip-remove').addEventListener('click', () => { state.pending.splice(i, 1); renderAttachments(); });
    els.attachments.appendChild(chip);
  });

  if (state.uploadingCount) {
    const chip = document.createElement('div');
    chip.className = 'chip loading';
    chip.innerHTML = `<span class="chip-ic">${ICON.file}</span><div class="chip-meta"><div class="chip-name">Traitement…</div><div class="chip-sub">${state.uploadingCount} fichier(s)</div></div>`;
    els.attachments.appendChild(chip);
  }
}

/* ───────────────────────── send / generate ───────────────────────── */
function send() {
  const text = els.input.value.trim();
  if ((!text && !state.pending.length) || state.generating) return;

  const attachments = state.pending.slice();
  state.conversation.push({ role: 'user', text, attachments });
  state.pending = [];
  els.input.value = '';
  autoresize();
  renderAttachments();
  renderConversation();
  saveState();

  runGeneration();
}

function buildPayload() {
  return {
    model: state.settings.model,
    effort: state.settings.effort,
    webSearch: state.settings.webSearch,
    instructions: state.settings.instructions,
    skills: normalizeSkills(state.settings.skills),
    maxOutputTokens: state.settings.maxTokens ? Number(state.settings.maxTokens) : null,
    messages: state.conversation.map((m) => ({
      role: m.role,
      text: m.text || '',
      attachments: (m.attachments || []).map((a) => ({
        kind: a.kind, name: a.name, dataUrl: a.dataUrl, text: a.text,
      })),
    })),
  };
}

async function runGeneration() {
  const payload = buildPayload();

  const assistant = { role: 'assistant', text: '', usage: null, error: null };
  state.conversation.push(assistant);
  const view = appendAssistantView();

  state.generating = true;
  document.body.classList.add('generating');
  state.controller = new AbortController();

  let raw = '';
  let lastRender = 0;
  let renderTimer = null;
  const flush = (force) => {
    const now = performance.now();
    if (!force && now - lastRender < 70) {
      if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; flush(true); }, 70);
      return;
    }
    lastRender = now;
    view.content.innerHTML = renderMarkdown(raw);
    enhanceCode(view.content, false);
    view.content.classList.add('cursor');
    scrollToBottom();
  };

  const headers = { 'Content-Type': 'application/json' };
  if (state.apiKey) headers['x-sakana-key'] = state.apiKey;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers, body: JSON.stringify(payload), signal: state.controller.signal,
    });

    if (!res.ok) {
      let msg = `Erreur ${res.status}`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSSE(block);
        if (!ev) continue;

        if (ev.type === 'delta') {
          view.status.hidden = true;
          raw += ev.data.text || '';
          flush(false);
        } else if (ev.type === 'status') {
          showStatus(view, ev.data.label);
        } else if (ev.type === 'usage') {
          assistant.usage = ev.data.usage;
          if (ev.data.usage?.total_tokens) { state.totalTokens += ev.data.usage.total_tokens; updateUsageDisplay(); }
        } else if (ev.type === 'error') {
          throw new Error(ev.data.message || 'Erreur de génération');
        } else if (ev.type === 'done') {
          // handled after loop
        }
      }
    }

    assistant.text = raw;
    if (!raw.trim()) {
      view.content.innerHTML = '<div class="msg-error">Réponse vide reçue du modèle.</div>';
    } else {
      view.content.innerHTML = renderMarkdown(raw);
      enhanceCode(view.content, true);
    }
  } catch (err) {
    const aborted = err.name === 'AbortError';
    assistant.text = raw;
    if (aborted && raw.trim()) {
      view.content.innerHTML = renderMarkdown(raw);
      enhanceCode(view.content, true);
    } else if (aborted) {
      view.content.innerHTML = '<div class="msg-status">Génération interrompue.</div>';
    } else {
      assistant.error = err.message;
      view.content.innerHTML = `<div class="msg-error">${escapeHtml(err.message)}</div>`;
    }
  } finally {
    view.content.classList.remove('cursor');
    view.status.hidden = true;
    state.generating = false;
    document.body.classList.remove('generating');
    state.controller = null;
    renderTools(view, assistant);
    saveState();
    scrollToBottom();
  }
}

function stopGeneration() {
  if (state.controller) state.controller.abort();
}

function regenerateFrom(assistant) {
  if (state.generating) return;
  const i = state.conversation.indexOf(assistant);
  if (i < 0) return;
  state.conversation = state.conversation.slice(0, i); // drop this assistant turn (and anything after)
  saveState();
  renderConversation();
  runGeneration();
}

function parseSSE(block) {
  const lines = block.split('\n');
  let type = null, dataStr = null;
  for (const line of lines) {
    if (line.startsWith('event: ')) type = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataStr = line.slice(6);
  }
  if (!type || dataStr == null) return null;
  try { return { type, data: JSON.parse(dataStr) }; } catch (_) { return null; }
}

/* ───────────────────────── rendering ───────────────────────── */
function renderConversation() {
  els.stream.innerHTML = '';
  if (!state.conversation.length) {
    els.stream.appendChild(els.welcome);
    els.welcome.hidden = false;
    return;
  }
  for (const m of state.conversation) {
    if (m.role === 'user') renderUserMessage(m);
    else renderAssistantMessage(m);
  }
  scrollToBottom();
}

function renderUserMessage(m) {
  const msg = document.createElement('div');
  msg.className = 'msg user';
  let filesHtml = '';
  if (m.attachments && m.attachments.length) {
    filesHtml = '<div class="msg-files">' + m.attachments.map((a) => {
      if (a.kind === 'image' && a.dataUrl) return `<div class="msg-file"><img src="${a.dataUrl}" alt=""/>${escapeHtml(a.name)}</div>`;
      return `<div class="msg-file"><span class="ic">${ICON.file}</span>${escapeHtml(a.name)}</div>`;
    }).join('') + '</div>';
  }
  msg.innerHTML = `
    <div class="msg-avatar">${ICON.user}</div>
    <div class="msg-body">
      <div class="msg-role">Vous</div>
      ${filesHtml}
      <div class="msg-content"></div>
    </div>`;
  msg.querySelector('.msg-content').textContent = m.text || '';
  els.stream.appendChild(msg);
}

function renderAssistantMessage(m) {
  const view = appendAssistantView();
  if (m.error) {
    view.content.innerHTML = `<div class="msg-error">${escapeHtml(m.error)}</div>`;
  } else if (m.text) {
    view.content.innerHTML = renderMarkdown(m.text);
    enhanceCode(view.content, true);
  } else {
    view.content.innerHTML = '<div class="msg-status">—</div>';
  }
  renderTools(view, m);
}

function appendAssistantView() {
  els.welcome.hidden = true;
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  msg.innerHTML = `
    <div class="msg-avatar">${ICON.puffer}</div>
    <div class="msg-body">
      <div class="msg-role">Fugu</div>
      <div class="msg-status" hidden><span class="dot"></span><span class="status-label"></span></div>
      <div class="msg-content"></div>
      <div class="msg-tools"></div>
    </div>`;
  els.stream.appendChild(msg);
  return {
    msg,
    content: msg.querySelector('.msg-content'),
    status: msg.querySelector('.msg-status'),
    statusLabel: msg.querySelector('.status-label'),
    tools: msg.querySelector('.msg-tools'),
  };
}

function showStatus(view, label) {
  view.status.hidden = false;
  view.statusLabel.textContent = label;
  scrollToBottom();
}

function renderTools(view, m) {
  view.tools.innerHTML = '';
  if (m.error) {
    addTool(view.tools, ICON.refresh, 'Réessayer', () => regenerateFrom(m));
    return;
  }
  addTool(view.tools, ICON.copy, 'Copier', () => {
    navigator.clipboard.writeText(m.text || '');
    toast('Copié');
  });
  addTool(view.tools, ICON.refresh, 'Régénérer', () => regenerateFrom(m));
  if (m.usage) {
    const u = m.usage;
    const meta = document.createElement('span');
    meta.className = 'msg-meta';
    meta.textContent = `${u.input_tokens ?? '?'} ↑ · ${u.output_tokens ?? '?'} ↓ · ${u.total_tokens ?? '?'} tok`;
    meta.title = 'Tokens entrée / sortie / total (orchestration incluse)';
    view.tools.appendChild(meta);
  }
}

/* ───────────────────────── chat history ───────────────────────── */
function openHistory() {
  persistCurrentChat();
  renderHistory();
  els.historyModal.hidden = false;
}
function closeHistory() { els.historyModal.hidden = true; }

function renderHistory() {
  els.historyList.innerHTML = '';

  if (!state.chats.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Aucune discussion enregistrée.';
    els.historyList.appendChild(empty);
    return;
  }

  state.chats.forEach((chat) => {
    const row = document.createElement('div');
    row.className = 'history-item';
    if (chat.id === state.currentChatId) row.classList.add('active');

    const main = document.createElement('button');
    main.className = 'history-main';
    main.type = 'button';
    main.innerHTML = `
      <span class="history-title">${escapeHtml(chat.title || 'Nouvelle discussion')}</span>
      <span class="history-meta">${formatChatDate(chat.updatedAt)} · ${(chat.messages || []).length} message(s)</span>`;
    main.addEventListener('click', () => loadChat(chat.id));

    const del = document.createElement('button');
    del.className = 'history-delete';
    del.type = 'button';
    del.title = 'Supprimer';
    del.setAttribute('aria-label', 'Supprimer la discussion');
    del.innerHTML = ICON.trash;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });

    row.append(main, del);
    els.historyList.appendChild(row);
  });
}

function loadChat(id) {
  if (state.generating) stopGeneration();
  persistCurrentChat();
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  state.currentChatId = chat.id;
  state.conversation = chat.messages || [];
  state.pending = [];
  state.totalTokens = chat.totalTokens || 0;
  renderAttachments();
  renderConversation();
  updateUsageDisplay();
  saveState();
  closeHistory();
}

function deleteChat(id) {
  const wasActive = id === state.currentChatId;
  state.chats = state.chats.filter((c) => c.id !== id);
  if (wasActive) {
    state.currentChatId = null;
    state.conversation = [];
    state.pending = [];
    state.totalTokens = 0;
    renderAttachments();
    renderConversation();
    updateUsageDisplay();
  }
  saveState();
  renderHistory();
  toast('Discussion supprimée');
}

function addTool(container, icon, label, onClick) {
  const b = document.createElement('button');
  b.className = 'msg-tool';
  b.innerHTML = `<span class="ic">${icon}</span>${label}`;
  b.addEventListener('click', onClick);
  container.appendChild(b);
}

let markedReady = false;
function ensureMarked() {
  if (markedReady) return;
  marked.setOptions({ gfm: true, breaks: true });
  markedReady = true;
}
function renderMarkdown(text) {
  ensureMarked();
  const html = marked.parse(text || '');
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
}

function enhanceCode(container, highlight) {
  container.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;
    if (highlight && !code.dataset.hl) {
      try { hljs.highlightElement(code); } catch (_) {}
      code.dataset.hl = '1';
    }
    if (!pre.querySelector('.code-copy')) {
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.textContent = 'copier';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(code.innerText);
        btn.textContent = 'copié ✓';
        setTimeout(() => (btn.textContent = 'copier'), 1500);
      });
      pre.appendChild(btn);
    }
  });
  // open links in a new tab
  container.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}

/* ───────────────────────── settings actions ───────────────────────── */
function openSettings() { els.settingsModal.hidden = false; }
function closeSettings() { els.settingsModal.hidden = true; }

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('fugu.theme', next); } catch (_) { /* ignore */ }
}

function saveApiKey() {
  const key = els.apiKey.value.trim();
  state.apiKey = key;
  try { if (key) localStorage.setItem('fugu.key', key); else localStorage.removeItem('fugu.key'); } catch (_) {}
  toast(key ? 'Clé enregistrée' : 'Clé supprimée');
}

async function testConnection() {
  els.testResult.textContent = 'test…';
  els.testResult.className = 'test-result';
  const headers = { 'Content-Type': 'application/json' };
  if (state.apiKey) headers['x-sakana-key'] = state.apiKey;
  try {
    const res = await fetch('/api/test-key', { method: 'POST', headers, body: '{}' });
    const j = await res.json();
    if (j.ok) {
      els.testResult.textContent = `OK · ${(j.models || []).join(', ') || 'connecté'}`;
      els.testResult.className = 'test-result ok';
    } else {
      els.testResult.textContent = j.error || 'échec';
      els.testResult.className = 'test-result err';
    }
  } catch (e) {
    els.testResult.textContent = 'serveur injoignable';
    els.testResult.className = 'test-result err';
  }
}

function newChat() {
  if (state.generating) stopGeneration();
  persistCurrentChat();
  state.currentChatId = null;
  state.conversation = [];
  state.pending = [];
  state.totalTokens = 0;
  renderAttachments();
  renderConversation();
  updateUsageDisplay();
  saveState();
  els.input.focus();
}

function wipeAll() {
  try {
    localStorage.removeItem('fugu.chats');
    localStorage.removeItem('fugu.activeChat');
    localStorage.removeItem('fugu.conv');
    localStorage.removeItem('fugu.total');
  } catch (_) {}
  state.chats = [];
  state.currentChatId = null;
  state.conversation = [];
  state.pending = [];
  state.totalTokens = 0;
  renderAttachments();
  renderConversation();
  updateUsageDisplay();
  saveState();
  renderHistory();
  closeSettings();
  closeHistory();
  toast('Historique effacé');
}

/* ───────────────────────── misc ───────────────────────── */
function updateUsageDisplay() {
  els.usage.textContent = state.totalTokens ? `Σ ${fmtTokens(state.totalTokens)}` : '—';
  els.usage.title = `${state.totalTokens.toLocaleString('fr-FR')} tokens cumulés cette session`;
}
function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
  return String(n);
}
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' Ko';
  return (bytes / 1024 / 1024).toFixed(1) + ' Mo';
}
function formatChatDate(ts) {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts));
  } catch (_) {
    return '';
  }
}
function autoresize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
}
function scrollToBottom() {
  els.stream.scrollTop = els.stream.scrollHeight;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => (els.toast.hidden = true), 250);
  }, 2600);
}

init();
