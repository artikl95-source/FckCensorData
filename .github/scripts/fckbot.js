// fckbot for GitHub Actions — polls Telegram, adds tracks to the FckCensorData fork.
// Env: TG_TOKEN (secret), GH_TOKEN (github.token), GH_REPOSITORY (github.repository).
// State: repo Actions variables FCKBOT_OFFSET, FCKBOT_PENDING (audio file_id awaiting its link).

const TG = 'https://api.telegram.org/bot' + process.env.TG_TOKEN;
const GH = 'https://api.github.com';
const REPO = process.env.GH_REPOSITORY;
const TOKEN = process.env.GH_TOKEN;
const BRANCH = 'main';
const TEMPLATE = 'raw.githubusercontent.com/' + REPO + '/refs/heads/main/tracks/%%';

const OWNER_CHAT_FILE = 'custom/bot_owner.txt';

function ghHeaders(extra) {
  return Object.assign({
    Authorization: 'token ' + TOKEN,
    'User-Agent': 'fckbot',
    Accept: 'application/vnd.github+json'
  }, extra || {});
}

async function gh(path, opts) {
  const r = await fetch(GH + path, Object.assign({ headers: ghHeaders() }, opts));
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t); } catch (e) { }
  if (!r.ok) throw new Error('GH ' + r.status + ' ' + path + ': ' + (j.message || t.slice(0, 200)));
  return j;
}

async function getVar(name) {
  try {
    const j = await gh('/repos/' + REPO + '/actions/variables/' + name);
    return j.value;
  } catch (e) {
    return null;
  }
}

async function setVar(name, value) {
  value = String(value == null ? '' : value);
  try {
    const cur = await gh('/repos/' + REPO + '/actions/variables/' + name);
    if (cur.value === value) return; // no change
    await gh('/repos/' + REPO + '/actions/variables/' + name, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value })
    });
    return;
  } catch (e) { /* variable doesn't exist yet */ }
  await gh('/repos/' + REPO + '/actions/variables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, value })
  });
}

async function tg(method, body) {
  const r = await fetch(TG + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const j = await r.json();
  if (!j.ok) throw new Error(method + ': ' + JSON.stringify(j).slice(0, 300));
  return j.result;
}

function parseTrackId(text) {
  if (!text) return null;
  let m = text.match(/music\.ya(?:ndex)?\.(?:ru|com)\/(?:album\/\d+\/)?track\/(\d+)/i);
  if (m) return m[1];
  if (/^\s*\d{6,11}\s*$/.test(text)) return text.trim();
  return null;
}

async function tgFileBytes(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const r = await fetch('https://api.telegram.org/file/bot' + process.env.TG_TOKEN + '/' + f.file_path);
  if (!r.ok) throw new Error('file download: HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function putFile(repoPath, contentBuf, message) {
  const existing = await gh('/repos/' + REPO + '/contents/' + encodeURI(repoPath) + '?ref=' + BRANCH).catch(() => null);
  const body = { message, content: contentBuf.toString('base64'), branch: BRANCH };
  if (existing && existing.sha) body.sha = existing.sha;
  await gh('/repos/' + REPO + '/contents/' + encodeURI(repoPath), {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
}

async function getCustom() {
  const j = await gh('/repos/' + REPO + '/contents/custom/custom_v2.json?ref=' + BRANCH);
  return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
}

async function getOwner() {
  try {
    const j = await gh('/repos/' + REPO + '/contents/' + OWNER_CHAT_FILE + '?ref=' + BRANCH);
    return Buffer.from(j.content, 'base64').toString('utf8').trim();
  } catch (e) {
    return null;
  }
}

async function setOwner(chatId) {
  await putFile(OWNER_CHAT_FILE, Buffer.from(String(chatId), 'utf8'), 'pair bot owner');
}

async function dispatchRegen() {
  await fetch(GH + '/repos/' + REPO + '/actions/workflows/sync-upstream.yml/dispatches', {
    method: 'POST',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ref: BRANCH })
  });
}

async function processTrack(chatId, audio, trackId) {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  console.log('track ' + trackId + ': uploading audio (' + audio.bytes.length + ' bytes)');
  await putFile('tracks/' + trackId, audio.bytes, 'add track ' + trackId + ' audio');

  const json = await getCustom();
  let src = (json.sources || []).find(s => s.tracksStorages && s.tracksStorages[0]
    && (s.tracksStorages[0].urlTemplate || '').indexOf(REPO.split('/')[0]) >= 0);
  if (!src) {
    src = { supportedVersions: '>0.0.0', tracks: {}, tracksStorages: [{ trackIds: [], urlTemplate: TEMPLATE }] };
    (json.sources = json.sources || []).push(src);
  }
  src.tracks[trackId] = { title: audio.title || ('Track ' + trackId) };
  if (audio.performer) src.tracks[trackId].artists = [{ id: 0, name: audio.performer }];
  const st = src.tracksStorages[0];
  if (!st.trackIds.some(t => String(t.id) === String(trackId))) st.trackIds.push({ id: Number(trackId) });

  console.log('track ' + trackId + ': updating custom_v2.json');
  await putFile('custom/custom_v2.json',
    Buffer.from(JSON.stringify(json, null, 2), 'utf8'),
    'add track ' + trackId + ' to custom list');

  await dispatchRegen();
  console.log('track ' + trackId + ': workflow dispatched');
}

function describeAudio(m) {
  const a = m.audio || m.document;
  return {
    fileId: a.file_id,
    title: ((a.title || a.file_name || '').replace(/\.[a-z0-9]+$/i, '')) || null,
    performer: a.performer || null
  };
}

async function handleUpdate(u, owner) {
  const m = u.message || u.edited_message;
  if (!m || !m.chat) return;
  const chatId = String(m.chat.id);

  if (!owner) {
    owner = chatId;
    await setOwner(chatId);
    console.log('owner paired: ' + chatId);
    await tg('sendMessage', { chat_id: chatId, text: 'Бот привязан к этому чату. Кирай мне аудиофайл (без цензуры), а в подписи — ссылку на трек Яндекс.Музыки (или ссылку отдельным сообщением).' });
    return { owner };
  }
  if (chatId !== owner) {
    await tg('sendMessage', { chat_id: chatId, text: 'Нет доступа.' });
    return { owner };
  }

  const pending = await getVar('FCKBOT_PENDING');

  if (m.audio || (m.document && /audio|mpeg|mp4|flac|ogg/i.test(m.document.mime_type || ''))) {
    const audio = describeAudio(m);
    const capId = parseTrackId(m.caption);
    if (capId) {
      const bytes = await tgFileBytes(audio.fileId);
      audio.bytes = bytes;
      try {
        await processTrack(chatId, audio, capId);
        await setVar('FCKBOT_PENDING', '');
        await tg('sendMessage', { chat_id: chatId, text: '✅ Трек ' + capId + ' добавлен в базу (' + (audio.title || 'без названия') + '). Список пересобирается — приложение подхватит при следующем запуске.' });
      } catch (e) {
        await tg('sendMessage', { chat_id: chatId, text: '❌ Ошибка: ' + e.message });
      }
      return { owner };
    }
    await setVar('FCKBOT_PENDING', JSON.stringify({ chatId, ...audio, ts: Date.now() }));
    await tg('sendMessage', { chat_id: chatId, text: 'Аудио получено' + (audio.title ? ' («' + audio.title + '»)' : '') + '. Теперь пришли ссылку на трек Яндекс.Музыки (music.yandex.ru/album/.../track/...).' });
    return { owner };
  }

  if (m.text) {
    if (m.text.trim() === '/start' || m.text.trim() === '/help') {
      await tg('sendMessage', { chat_id: chatId, text: 'Кирай: 1) аудиофайл без цензуры, 2) ссылку на трек (music.yandex.ru/album/.../track/...). Можно одним сообщением — аудио с ссылкой в подписи. Я залью файл в tracks/<id>, добавлю запись в кастом-список и пересоберу базу.' });
      return { owner };
    }
    const trackId = parseTrackId(m.text);
    if (!trackId) {
      await tg('sendMessage', { chat_id: chatId, text: 'Не вижу id трека. Пришли ссылку вида music.yandex.ru/album/<альбом>/track/<id> или просто число-id.' });
      return { owner };
    }
    if (!pending) {
      await tg('sendMessage', { chat_id: chatId, text: 'Сначала пришли аудиофайл (без цензуры), потом ссылку.' });
      return { owner };
    }
    const audio = JSON.parse(pending);
    const bytes = await tgFileBytes(audio.fileId);
    audio.bytes = bytes;
    try {
      await processTrack(chatId, audio, trackId);
      await setVar('FCKBOT_PENDING', '');
      await tg('sendMessage', { chat_id: chatId, text: '✅ Трек ' + trackId + ' добавлен в базу (' + (audio.title || 'без названия') + '). Список пересобирается — приложение подхватит при следующем запуске.' });
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ Ошибка: ' + e.message });
    }
    return { owner };
  }
  return { owner };
}

(async () => {
  const tokenOk = process.env.TG_TOKEN && process.env.TG_TOKEN.length > 10;
  if (!tokenOk) { console.log('FCKBOT_TG_TOKEN secret is not set — skipping poll'); return; }
  console.log('env lens: GH_TOKEN=' + (process.env.GH_TOKEN || '').length + ' GITHUB_TOKEN=' + (process.env.GITHUB_TOKEN || '').length + ' TG_TOKEN=' + (process.env.TG_TOKEN || '').length);

  let owner = await getOwner();
  let offset = parseInt((await getVar('FCKBOT_OFFSET')) || '0', 10) || 0;
  console.log('polling, offset=' + offset + ', owner=' + (owner || 'not paired'));

  const updates = await tg('getUpdates', { timeout: 5, offset });
  let lastOffset = offset;
  let curOwner = owner;
  for (const u of updates) {
    lastOffset = u.update_id + 1;
    try {
      const r = await handleUpdate(u, curOwner);
      if (r && r.owner) curOwner = r.owner;
    } catch (e) {
      console.log('handle error: ' + e.message);
    }
  }
  await setVar('FCKBOT_OFFSET', String(lastOffset));
  console.log('done, offset now ' + lastOffset);
})().catch(e => { console.log('fatal: ' + e.message); process.exit(1); });
