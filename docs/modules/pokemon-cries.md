# Pokémon cries

The website plays a locally hosted species cry when a visitor activates a card image or its labeled sound button. Gallery cards, asynchronously loaded pack inventory, and dashboard history cards share one player. Tag-team cards have a separate button for each identified species; their image plays the first species.

`pokemon-cries.mjs` exports `resolvePokemon(title, pokemon)`, `createCryPlayer({audio, onState})`, and `installPokemonCries({document, catalogUrl})`. Browser entrypoints load the module and its stylesheet. The catalog at `/audio/pokemon/catalog.json` supplies names, multilingual aliases, audio paths, and source variants. Resolution removes grading metadata and deck prefixes, preserves slash-separated card numbers, favors explicit canonical names over ambiguous translated words, and treats Pikachu costumes as Pikachu. Unidentified cards, trainers, and sealed products have no sound controls.

Audio starts only during explicit activation. There is no autoplay or audio preloading. A new activation interrupts the previous cry; stale playback promises cannot overwrite current state. Failed playback exposes a retry message. Playback stops when the document is hidden or the page is left. Images support keyboard activation and sound buttons remain native buttons. A mutation observer decorates newly inserted cards once.

Legacy means the source repository's legacy variant, not a verified specific game edition. Regional forms currently use the base-species cry. Catalog failures leave the underlying cards usable. To recover unavailable sounds, restore the pinned catalog and its referenced local MP3 files; no runtime third-party audio service is required.

Run `node --test apps/web/tests/pokemon-cries.test.mjs` to verify title resolution, explicit playback, interruption, rejection, retry, and stopping. Browser verification covers the DOM integration and user-gesture playback.
