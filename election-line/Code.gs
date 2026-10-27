/**
 * קו עדכוני בחירות 2026 — Google Apps Script.
 * פרויקט חדש ונפרד מקו החדשות. אין טוקן ימות, אתר ניהול או התקנת שלוחות מהשרת.
 * נתונים חיים בלבד מכתובות הטקסט המתועדות במאגר; לא משתמשים בתוצאות 2022.
 */
var ELECTION = Object.freeze({
  version: '1.0.0',
  source: 'https://bechirot.onrender.com/api/phone/',
  topics: ['summary', 'turnout', 'exitpolls', 'results', 'parties'],
  credit: 'הנתונים באדיבות אתר בחירות 2026, חדר המצב',
  freshMs: 30000,
  staleMs: 300000,
  maxSourceChars: 30000,
  chunkChars: 700,
  chunkWords: 85
});

function doGet(e) { return electionRequest_(e); }
function doPost(e) { return electionRequest_(e); }

function electionRequest_(e) {
  var p = e && e.parameter || {};
  var root = electionRoot_(p.root);
  try {
    var topic = String(p.topic || 'menu');
    if (topic === 'health') return electionOutput_(JSON.stringify(electionHealth_()), true);
    if (topic === 'menu') return electionOutput_(electionMenu_(root, String(p.election_choice || '')));
    if (ELECTION.topics.indexOf(topic) < 0) return electionOutput_(electionMessage_('הבחירה אינה קיימת, אנא בחרו שוב', root));
    return electionOutput_(electionTopic_(topic, root));
  } catch (_) {
    // אין להחזיר למאזין HTML, פרטי שגיאה או טקסט טכני.
    return electionOutput_(electionMessage_('לא ניתן לקבל כעת את עדכוני הבחירות, אנא נסו שוב בעוד זמן קצר', root));
  }
}

function electionOutput_(text, json) {
  return ContentService.createTextOutput(text).setMimeType(json ? ContentService.MimeType.JSON : ContentService.MimeType.TEXT);
}

function electionRoot_(value) {
  var root = String(value || '/9');
  return /^\/[0-9]+(?:\/[0-9]+)*$/.test(root) && root.length <= 60 ? root : '/9';
}

function electionParent_(root) { return root.slice(0, root.lastIndexOf('/')) || '/'; }

function electionMenu_(root, choice) {
  if (/^[1-5]$/.test(choice)) return 'go_to_folder=' + root + '/' + choice;
  if (/^[09]$/.test(choice)) return 'go_to_folder=' + electionParent_(root);
  var text = 'ברוכים הבאים לקו עדכוני בחירות 2026, לתקציר העדכני הקישו אחת, ' +
    'לאחוזי הצבעה הקישו שתיים, למדגמים הקישו שלוש, לתוצאות אמת הקישו ארבע, ' +
    'לרשימות ולאותיות הפתק הקישו חמש, לחזרה לתפריט הקודם הקישו אפס';
  // no = קבלת הבחירה מחדש בכניסה; 1 ספרה; שבע שניות; 0 מותר; מותרות רק הבחירות המוצעות.
  return 'read=t-' + electionSafeText_(text) + '=election_choice,no,1,1,7,No,yes,no,,0123459';
}

function electionSafeText_(value) {
  return String(value)
    .replace(/^\uFEFF/, '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(\d)\.(?=\d)/g, '$1 נקודה ')
    .replace(/%/g, ' אחוזים ')
    .replace(/&/g, ' ו ')
    .replace(/[.]/g, ', ')
    .replace(/[=\-\u05BE\u2010-\u2015<>|]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function electionChunks_(text) {
  var safe = electionSafeText_(text);
  var words = safe.split(/\s+/), chunks = [], current = [];
  words.forEach(function(word) {
    if (word.length > 200) throw new Error('SOURCE_WORD_TOO_LONG');
    if (current.length && (current.length >= ELECTION.chunkWords || current.join(' ').length + word.length + 1 > ELECTION.chunkChars)) {
      chunks.push(current.join(' ')); current = [];
    }
    current.push(word);
  });
  if (current.length) chunks.push(current.join(' '));
  return chunks.filter(function(x) { return x.length > 0; });
}

function electionMessage_(text, root) {
  var chunks = electionChunks_(text);
  if (!chunks.length) throw new Error('EMPTY_MESSAGE');
  return 'id_list_message=' + chunks.map(function(x) { return 't-' + x; }).join('.') + '&go_to_folder=' + root;
}

function electionSourceText_(response) {
  if (response.getResponseCode() !== 200) throw new Error('SOURCE_HTTP');
  var headers = response.getAllHeaders(), type = '';
  Object.keys(headers).forEach(function(k) { if (k.toLowerCase() === 'content-type') type = String(headers[k]); });
  if (!/^text\/plain(?:;|$)/i.test(type)) throw new Error('SOURCE_TYPE');
  var text = response.getContentText('UTF-8').replace(/^\uFEFF/, '').trim();
  if (!text || text.length > ELECTION.maxSourceChars || !/[\u05d0-\u05ea]/.test(text)) throw new Error('SOURCE_TEXT');
  if (/<\/?[a-z!][^>]*>/i.test(text) || /^[\[{]/.test(text)) throw new Error('SOURCE_DOCUMENT');
  if (/\b(?:id_list_message|go_to_folder|routing_yemot|read)\s*=/i.test(text)) throw new Error('SOURCE_PROTOCOL');
  // ניקוי ובדיקת אורכי מקטעים לפני שמירת תשובה כתקינה.
  electionChunks_(text);
  return text;
}

function electionKey_(topic) { return 'election:v1:' + topic; }
function electionCache_() { try { return CacheService.getScriptCache(); } catch (_) { return null; } }
function electionGet_(cache, key) { try { return cache && cache.get(key); } catch (_) { return null; } }
function electionPut_(cache, key, value, seconds) { try { if (cache) cache.put(key, value, seconds); } catch (_) {} }

function electionRecord_(cache, topic, now) {
  try {
    var r = JSON.parse(electionGet_(cache, electionKey_(topic)) || 'null');
    if (!r || typeof r.text !== 'string' || !Number.isFinite(r.fetchedAt) || r.fetchedAt > now || now - r.fetchedAt > ELECTION.staleMs) return null;
    if (!r.text || r.text.length > ELECTION.maxSourceChars) return null;
    return r;
  } catch (_) { return null; }
}

function electionClaim_(cache, topic) {
  if (!cache) return 'uncached';
  var lock;
  try {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(150)) return '';
    var key = electionKey_(topic) + ':lease', now = Date.now();
    var lease = JSON.parse(electionGet_(cache, key) || 'null');
    if (lease && lease.until > now) return '';
    var id = Utilities.getUuid();
    electionPut_(cache, key, JSON.stringify({id: id, until: now + 120000}), 120);
    return id;
  } catch (_) { return 'uncached'; }
  finally { try { if (lock) lock.releaseLock(); } catch (_) {} }
}

function electionRelease_(cache, topic, id) {
  if (!cache || !id || id === 'uncached') return;
  try {
    var key = electionKey_(topic) + ':lease';
    var lease = JSON.parse(electionGet_(cache, key) || 'null');
    if (lease && lease.id === id) cache.remove(key);
  } catch (_) {}
}

function electionSpeech_(record, stale) {
  var text = record.text;
  if (stale) {
    var age = Math.max(1, Math.ceil((Date.now() - record.fetchedAt) / 60000));
    text = 'לתשומת לבכם, העדכון החי אינו זמין כרגע, מושמע עותק שהתקבל מהמקור לפני ' + age + ' דקות, ' + text;
  }
  if (text.indexOf('הנתונים באדיבות אתר בחירות 2026') < 0) text += ' ' + ELECTION.credit;
  return text;
}

function electionTopic_(topic, root) {
  var cache = electionCache_(), now = Date.now(), key = electionKey_(topic);
  var record = electionRecord_(cache, topic, now);
  if (record && now - record.fetchedAt < ELECTION.freshMs) return electionMessage_(electionSpeech_(record, false), root);
  var retryAt = Number(electionGet_(cache, key + ':retry') || 0);
  var claim = retryAt > now ? '' : electionClaim_(cache, topic);
  if (!claim) {
    record = electionRecord_(cache, topic, Date.now());
    return electionMessage_(record ? electionSpeech_(record, Date.now() - record.fetchedAt >= ELECTION.freshMs) : 'עדכוני הבחירות אינם זמינים כעת, אנא נסו שוב בעוד מספר שניות', root);
  }
  try {
    // ייתכן שסבב מקביל הספיק להשלים בין בדיקת המטמון לתפיסת התור.
    record = electionRecord_(cache, topic, Date.now());
    if (record && Date.now() - record.fetchedAt < ELECTION.freshMs) return electionMessage_(electionSpeech_(record, false), root);
    var response = UrlFetchApp.fetch(ELECTION.source + topic + '.txt', {
      method: 'get', followRedirects: true, muteHttpExceptions: true,
      headers: {'Accept': 'text/plain', 'Cache-Control': 'no-cache'}
    });
    record = {text: electionSourceText_(response), fetchedAt: Date.now()};
    electionPut_(cache, key, JSON.stringify(record), 300);
    return electionMessage_(electionSpeech_(record, false), root);
  } catch (_) {
    electionPut_(cache, key + ':retry', String(Date.now() + 10000), 10);
    // קוראים מחדש: עותק יכול להתיישן במהלך בקשת רשת ממושכת.
    record = electionRecord_(cache, topic, Date.now());
    return electionMessage_(record ? electionSpeech_(record, true) : 'לא ניתן לקבל כעת את עדכוני הבחירות, אנא נסו שוב בעוד זמן קצר', root);
  } finally { electionRelease_(cache, topic, claim); }
}

function electionHealth_() {
  var cache = electionCache_(), now = Date.now(), topics = {};
  ELECTION.topics.forEach(function(topic) {
    var r = electionRecord_(cache, topic, now);
    topics[topic] = {cached: !!r, ageSeconds: r ? Math.floor((now - r.fetchedAt) / 1000) : null};
  });
  // ok מתייחס לחיבור לשרת, לא לאימות שהמקור עצמו עדכני.
  return {ok: true, version: ELECTION.version, checkedAt: new Date(now).toISOString(), topics: topics};
}

/** הפעלה מתוך העורך: בדיקה חיה של כל חמשת המקורות וחימום המטמון. אין שינוי בקו. */
function testLiveSources() {
  var requests = ELECTION.topics.map(function(topic) {
    return {url: ELECTION.source + topic + '.txt', method: 'get', muteHttpExceptions: true,
      followRedirects: true, headers: {'Accept': 'text/plain', 'Cache-Control': 'no-cache'}};
  });
  var responses = UrlFetchApp.fetchAll(requests), cache = electionCache_();
  var checks = responses.map(function(response, i) {
    var topic = ELECTION.topics[i];
    try {
      var text = electionSourceText_(response), at = Date.now();
      electionPut_(cache, electionKey_(topic), JSON.stringify({text: text, fetchedAt: at}), 300);
      return {topic: topic, ok: true, http: response.getResponseCode(), characters: text.length, chunks: electionChunks_(text).length};
    } catch (_) { return {topic: topic, ok: false, http: response.getResponseCode()}; }
  });
  var result = {ok: checks.every(function(x) { return x.ok; }), checkedAt: new Date().toISOString(), checks: checks};
  console.log(JSON.stringify(result));
  return result;
}

/** הפעלה מתוך העורך: בדיקת הפרוטוקול בלי רשת. */
function runSelfTests() {
  var checks = [];
  function check(name, ok) { checks.push({name: name, ok: !!ok}); if (!ok) throw new Error('SELF_TEST: ' + name); }
  check('decimal', electionSafeText_('44.9%').indexOf('44 נקודה 9 אחוזים') >= 0);
  check('delimiters', !/[.\-=&\r\n]/.test(electionSafeText_('שלום. עולם-חדש &=\n')));
  check('menu', electionMenu_('/9', '').indexOf('read=t-') === 0);
  check('choice', electionMenu_('/9', '4') === 'go_to_folder=/9/4');
  check('back', electionMenu_('/8/9', '0') === 'go_to_folder=/8');
  check('root', electionRoot_('/9&x=y') === '/9');
  check('chunks', electionChunks_(Array(250).fill('בחירות').join(' ')).length >= 3);
  check('message', electionMessage_('שלום עולם', '/9') === 'id_list_message=t-שלום עולם&go_to_folder=/9');
  var result = {ok: true, checks: checks}; console.log(JSON.stringify(result)); return result;
}
