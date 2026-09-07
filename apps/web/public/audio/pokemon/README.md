# Pokémon cries

Self-hosted MP3 cries for base Pokémon species 1–1025. `catalog.json` records English display names, source identifiers and localized name aliases, source selection, byte counts, and SHA-256 hashes of both original and encoded audio.

Audio comes from [PokeAPI/cries](https://github.com/PokeAPI/cries/tree/ef687b18f0ce17169b4b4c09175819f7ade92f0f), pinned to `ef687b18f0ce17169b4b4c09175819f7ade92f0f`. Names come from the official [PokeAPI data](https://github.com/PokeAPI/pokeapi/tree/d4f9a4af58ade123fbc0558f68b1c69daa97d9e4/data/v2/csv), pinned to `d4f9a4af58ade123fbc0558f68b1c69daa97d9e4`. Upstream credits Pokémon Showdown and Veekun for its audio sources.

The importer selects `legacy` when available and falls back to `latest`. These labels do not establish the exact game or release from which a recording originated. Alternate forms use their base species' cry.

The upstream notice states that all audio content is copyright The Pokémon Company and that the repository is distributed under CC0 1.0 Universal. The full notice is preserved in `SOURCE-LICENSE.txt`; repository licensing is not a claim that the underlying Pokémon audio is public domain. The project owner has stated that permission to use the cries was obtained; this importer does not verify a license document.

## Rebuild

From the repository root, with Python 3, Git and FFmpeg with libmp3lame installed:

```sh
python3 scripts/media/import-pokemon-cries.py
```

The script clones and checks out the pinned revisions, then encodes mono MP3 at 44.1 kHz and 64 kbit/s. `--ffmpeg`, `--cries-dir`, and `--data-dir` can select a binary or existing clean checkouts. Encoder version is recorded in the catalog; use that version to reproduce encoded hashes. Original-source hashes remain independent of the encoder.
