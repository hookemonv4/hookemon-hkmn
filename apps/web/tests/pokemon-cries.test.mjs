import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePokemon, createCryPlayer } from '../public/comic-production/pokemon-cries.mjs';
const names = ['Lugia','Rayquaza','Pikachu','Mew','Mewtwo','Venusaur','Bulbasaur','Umbreon','Darkrai','Gengar','Magikarp','Gyarados'];
const catalog = names.map((name,id) => ({id:id+1,name,aliases:[name],src:`/audio/pokemon/${id+1}.mp3`}));
const resolve = title => resolvePokemon(title,catalog).map(p => p.name);
test('resolves whole species names, not substrings or set labels', () => {
 assert.deepEqual(resolve('Shining Mewtwo'), ['Mewtwo']);
 assert.deepEqual(resolve('2023 #198 Venusaur EX PSA 10 Mew EN-151'), ['Venusaur']);
 assert.deepEqual(resolve('Mewtwofan'), []);
});
test('resolves both tag-team species in their printed order', () => {
 assert.deepEqual(resolve('2020 #SM241 Umbreon & Darkrai GX PSA 9 SM Black Star Promo'), ['Umbreon','Darkrai']);
});
test('costumes and deck names do not replace the pictured species', () => {
 assert.deepEqual(resolve('Poncho-Wearing Pikachu Rayquaza'), ['Pikachu']);
 assert.deepEqual(resolve('2013 #150XYP Pretend Magikarp Pikachu/(Pretend Magikarp & Pretend Gyarados Pikachu Special Box June 26, 2015) BGS 10 XY Japanese Promos'), ['Pikachu']);
 assert.deepEqual(resolve('2023 Pokemon Japanese TCG Classic Venusaur & Lugia ex Deck Holo Bulbasaur #1 CGC 10 GEM MINT'), ['Bulbasaur']);
});
test('sealed products and trainers are silent but graded prize-pack cards resolve', () => {
 assert.deepEqual(resolve('2016 Luigi Pikachu Poncho Special Box'), []);
 assert.deepEqual(resolve('Pikachu Illustrator Trainer PSA 9'), []);
 assert.deepEqual(resolve('2022 Play! Prize Pack Series 2 Full Art Gengar VMAX #157 PSA 8 NM-MT'), ['Gengar']);
});
test('normalizes diacritics and aliases', () => {
 assert.deepEqual(resolvePokemon('Évoli VMAX', [{name:'Eevee',aliases:['Évoli'],src:'a'}]).map(p=>p.name), ['Eevee']);
});
function fixture() {
 const pending=[]; const states=[];
 const audio={preload:'',src:'',currentTime:99, pauseCount:0,playCount:0,pause(){this.pauseCount++},play(){this.playCount++;return new Promise((resolve,reject)=>pending.push({resolve,reject}))},addEventListener(){}};
 const player=createCryPlayer({audio,onState:state=>states.push(state)});
 return {audio,pending,states,player};
}
test('does not autoplay and starts playback synchronously on interaction', async () => {
 const {audio,pending,player}=fixture(); assert.equal(audio.playCount,0); assert.equal(audio.preload,'none');
 const result=player.play(catalog[0]); assert.equal(audio.playCount,1); assert.equal(audio.currentTime,0); assert.equal(audio.src,catalog[0].src);
 pending[0].resolve(); await result;
});
test('replaces the previous cry and ignores its delayed rejection', async () => {
 const {audio,pending,states,player}=fixture(); const first=player.play(catalog[0]); const second=player.play(catalog[1]);
 pending[1].resolve(); await second; pending[0].reject(new Error('interrupted')); await first;
 assert.equal(audio.src,catalog[1].src); assert.equal(states.at(-1).status,'playing'); assert.equal(states.at(-1).pokemon.name,'Rayquaza');
});
test('reports playback failure and can retry after rejection', async () => {
 const {pending,states,player}=fixture(); const first=player.play(catalog[0]); pending[0].reject(new Error('denied')); await first;
 assert.equal(states.at(-1).status,'error'); const second=player.play(catalog[0]); pending[1].resolve(); await second; assert.equal(states.at(-1).status,'playing');
});

test('keeps slash-separated card numbers and full-art labels', () => {
 assert.deepEqual(resolve('2023 #154/SV-P Pikachu in a Bati'), ['Pikachu']);
 assert.deepEqual(resolve('2023 #GG10 Full Art/Mew PSA 9 Crown Zenith'), ['Mew']);
});
test('prefers explicit English species over ambiguous translated set words', () => {
 const entries=[{name:'Moltres',aliases:['Fire']},{name:'Articuno',aliases:[]}];
 assert.deepEqual(resolvePokemon('2004 EX Fire Red & Leaf Green Holo Articuno #114 BGS 9',entries).map(p=>p.name),['Articuno']);
});
test('stop cancels pending playback state', async () => {
 const {audio,pending,states,player}=fixture(); const first=player.play(catalog[0]); player.stop(); pending[0].resolve(); await first;
 assert.equal(states.at(-1).status,'idle'); assert.equal(audio.pauseCount,2);
});
