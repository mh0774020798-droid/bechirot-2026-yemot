/** Parse public t.me/s pages as data. No scripts, media or links are executed. */
export function decodeEntities(value) {
  const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…'};
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? ' ';
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2),16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
  });
}
function attributes(tag) {
  const result = {};
  for (const m of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    result[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4]);
  }
  return result;
}
export function parseTelegram(html, channel) {
  if (!/^[a-z0-9_]{3,40}$/i.test(channel) || typeof html !== 'string' || html.length > 1500000) throw new Error('upstream_shape');
  channel = channel.toLowerCase();
  const items = [];
  let depth = 0, current = null, count = 0, ignored = null;
  // Telegram's message body is a div and may itself contain nested divs.
  // Track their depth so a quote or custom emoji cannot leak the next post's footer.
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/g)) {
    const tag = token[0];
    if (tag.startsWith('<!--')) continue;
    const match = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(tag);
    if (!match) continue;
    const closing = !!match[1], name = match[2].toLowerCase();
    if (ignored) {if (closing && name === ignored) ignored = null;continue;}
    if (!closing && ['script','style'].includes(name)) {ignored = name;continue;}
    if (closing) {
      if (name !== 'div') continue;
      if (current?.textDepth === depth) {
        current.text = html.slice(current.textStart, token.index);
        current.textDepth = null;
      }
      if (current?.depth === depth) {
        if (current.date && current.text) items.push({source:channel,date:current.date,title:'',summary:current.text,url:'https://t.me/'+current.post});
        current = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (name === 'div') depth++;
    const a = attributes(tag), classes = (a.class || '').split(/\s+/);
    if (name === 'div' && classes.includes('tgme_widget_message')) {
      const post = a['data-post'] || '';
      if (post.toLowerCase().startsWith(channel+'/') && /^\d+$/.test(post.split('/')[1]) && post.split('/').length === 2) {
        if (++count > 100) throw new Error('upstream_shape');
        current = {depth,post,date:null,text:null,textDepth:null};
      } else { current = null; }
    }
    if (!current) continue;
    if (name === 'div' && classes.includes('tgme_widget_message_text') && current.textDepth === null && !current.text) {
      current.textStart = token.index + tag.length;
      current.textDepth = depth;
    }
    if (name === 'time' && a.datetime && !current.date) current.date = a.datetime;
  }
  if (!count) throw new Error('upstream_shape');
  return {items,posts:count};
}
