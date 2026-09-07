const normalize = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function resolvePokemon(title, pokemon) {
  let text = String(title);
  if (/\btrainer\b/i.test(text)) return [];
  const graded = /\b(?:PSA|CGC|BGS|SGC|ACE)\b/i.test(text);
  if (!graded && /\b(?:sealed|booster|special box|collection box|deck)\b/i.test(text)) return [];
  text = text.split(/\b(?:PSA|CGC|BGS|SGC|ACE)\b/i)[0];
  text = text.replace(/^.*\bdeck\b/i, '').split('(')[0];
  const normalized = ` ${normalize(text)} `;
  const matches = pokemon.flatMap(entry => {
    const aliases = [...new Set([entry.name, ...(entry.aliases || [])].map(normalize))].filter(Boolean);
    const found = aliases.map(alias => ({index: normalized.indexOf(` ${alias} `),length:alias.length})).filter(match=>match.index>=0).sort((a,b)=>b.length-a.length)[0];
    return found ? [{entry,...found,canonical:normalized.includes(` ${normalize(entry.name)} `)}] : [];
  }).sort((a,b)=>a.index-b.index || b.length-a.length);
  const preferred = matches.some(match=>match.canonical) ? matches.filter(match=>match.canonical) : matches;
  const longest = preferred.filter(match => !matches.some(other => other !== match && other.index <= match.index && other.index + other.length >= match.index + match.length && other.length > match.length));
  if (/\b(?:poncho|pretend|costume|luigi|mario)\b/i.test(text)) {
    const pikachu = longest.find(match=>normalize(match.entry.name)==='pikachu');
    if (pikachu) return [pikachu.entry];
  }
  return longest.map(match=>match.entry);
}

export function createCryPlayer({audio, onState = () => {}}) {
  let version = 0;
  let current = null;
  audio.preload = 'none';
  const report = status => onState({status,pokemon:current});
  audio.addEventListener('ended', () => report('idle'));
  audio.addEventListener('error', () => { if (current && audio.error) report('error'); });
  return {
    async play(pokemon) {
      const attempt = ++version;
      audio.pause();
      current = pokemon;
      audio.src = pokemon.src;
      audio.currentTime = 0;
      report('loading');
      try {
        await audio.play();
        if (attempt === version) report('playing');
      } catch {
        if (attempt === version) report('error');
      }
    },
    stop() { version++; audio.pause(); report('idle'); current = null; },
  };
}

export async function installPokemonCries({document: doc = document, catalogUrl = '/audio/pokemon/catalog.json'} = {}) {
  const response = await fetch(catalogUrl);
  if (!response.ok) return;
  const {pokemon} = await response.json();
  if (!Array.isArray(pokemon)) return;
  const status = doc.createElement('span');
  status.className = 'cry-status'; status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
  doc.body.append(status);
  let activeCard;
  const player = createCryPlayer({audio: new Audio(),onState({status: state,pokemon: entry}) {
    doc.querySelectorAll('.cry-playing').forEach(card=>card.classList.remove('cry-playing'));
    if (state === 'playing' || state === 'loading') activeCard?.classList.add('cry-playing');
    status.classList.toggle('cry-status-error',state === 'error');
    status.textContent = state === 'error' ? `Couldn't play ${entry.name}. Tap to try again.` : state === 'playing' ? `Playing ${entry.name}'s cry.` : '';
  }});
  const stopWhenHidden = () => { if (doc.hidden) player.stop(); };
  const stop = () => player.stop();
  doc.addEventListener('visibilitychange',stopWhenHidden);
  doc.defaultView?.addEventListener('pagehide',stop);
  const processed = new WeakSet();
  function decorate() {
    doc.querySelectorAll('.collectible-card,.inventory-card,.history-card').forEach(card => {
      if (processed.has(card)) return;
      const title = card.querySelector('h3,.card-copy strong');
      const image = card.querySelector('.card-image,.inventory-image img,img');
      if (!title || !image) return;
      const entries = resolvePokemon(title.textContent,pokemon);
      processed.add(card);
      if (!entries.length) return;
      card.classList.add('cry-card');
      const controls = doc.createElement('div'); controls.className = 'cry-controls';
      const play = entry => { activeCard=card; void player.play(entry); };
      entries.forEach(entry => {
        const button=doc.createElement('button'); button.type='button'; button.className='cry-button';
        button.textContent=`♪ ${entry.name}`; button.setAttribute('aria-label',`Hear ${entry.name}'s cry`);
        button.addEventListener('click',event=>{event.stopPropagation();play(entry)}); controls.append(button);
      });
      const host = card.querySelector('.card-display,.inventory-image') || card;
      host.classList.add('cry-surface'); host.append(controls);
      image.classList.add('cry-image'); image.setAttribute('role','button'); image.tabIndex=0;
      image.setAttribute('aria-label',`Hear ${entries[0].name}'s cry`);
      image.addEventListener('click',()=>play(entries[0]));
      image.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();play(entries[0])}});
    });
  }
  decorate();
  const observer = new MutationObserver(decorate);
  observer.observe(doc.body,{childList:true,subtree:true});
  return () => {observer.disconnect();player.stop();doc.removeEventListener('visibilitychange',stopWhenHidden);doc.defaultView?.removeEventListener('pagehide',stop);};
}

if (typeof document !== 'undefined') {
  const start = () => { void installPokemonCries().catch(()=>{}); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
}
