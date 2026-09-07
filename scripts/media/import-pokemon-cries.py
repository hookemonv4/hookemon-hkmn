#!/usr/bin/env python3
"""Import pinned PokeAPI cries and names. Requires git and ffmpeg (libmp3lame)."""
import argparse
import concurrent.futures
import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

CRIES_COMMIT = 'ef687b18f0ce17169b4b4c09175819f7ade92f0f'
DATA_COMMIT = 'd4f9a4af58ade123fbc0558f68b1c69daa97d9e4'
ROOT = Path(__file__).resolve().parents[2]

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def checkout(url, revision, directory):
    run('git', 'clone', '--quiet', url, str(directory))
    run('git', '-C', str(directory), 'checkout', '--quiet', revision)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cries-dir', type=Path)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    args = parser.parse_args()
    output = ROOT / 'apps/web/public/audio/pokemon'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pokemon-cries-') as temporary:
        cries = args.cries_dir or Path(temporary) / 'cries'
        data = args.data_dir or Path(temporary) / 'pokeapi'
        if not args.cries_dir:
            checkout('https://github.com/PokeAPI/cries.git', CRIES_COMMIT, cries)
        if not args.data_dir:
            checkout('https://github.com/PokeAPI/pokeapi.git', DATA_COMMIT, data)
        for directory, revision in [(cries, CRIES_COMMIT), (data, DATA_COMMIT)]:
            if run('git', '-C', str(directory), 'rev-parse', 'HEAD') != revision:
                raise SystemExit(f'{directory} must be at {revision}')
            if run('git', '-C', str(directory), 'status', '--porcelain'):
                raise SystemExit(f'{directory} must have a clean working tree')
        csv_root = data / 'data/v2/csv'
        with (csv_root / 'pokemon_species.csv').open() as stream:
            species = {int(row['id']): row['identifier'] for row in csv.DictReader(stream)}
        names = {}
        with (csv_root / 'pokemon_species_names.csv').open() as stream:
            for row in csv.DictReader(stream):
                names.setdefault(int(row['pokemon_species_id']), {})[int(row['local_language_id'])] = row['name']
        def convert(identifier):
            variant = 'legacy' if (cries / f'cries/pokemon/legacy/{identifier}.ogg').exists() else 'latest'
            source = cries / f'cries/pokemon/{variant}/{identifier}.ogg'
            target = output / f'{identifier}.mp3'
            run(args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
                '-map_metadata', '-1', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k',
                '-id3v2_version', '0', '-write_xing', '0', str(target))
            return {'id': identifier, 'name': names[identifier][9],
                    'aliases': list(dict.fromkeys([species[identifier], *names[identifier].values()])),
                    'src': f'/audio/pokemon/{identifier}.mp3', 'variant': variant,
                    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                    'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            pokemon = list(executor.map(convert, range(1, 1026)))
        catalog = {'source': {'criesRepository': 'https://github.com/PokeAPI/cries', 'criesCommit': CRIES_COMMIT,
            'pokemonDataRepository': 'https://github.com/PokeAPI/pokeapi', 'pokemonDataCommit': DATA_COMMIT,
            'selection': 'legacy when available; latest otherwise; no exact game-version claim',
            'encoding': 'MP3, mono, 44100 Hz, 64 kbit/s', 'ffmpeg': run(args.ffmpeg, '-version').splitlines()[0]},
            'pokemon': pokemon}
        (output / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n')
        shutil.copyfile(cries / 'LICENSE', output / 'SOURCE-LICENSE.txt')
        print(json.dumps({'count': len(pokemon), 'bytes': sum(row['bytes'] for row in pokemon),
            'legacy': sum(row['variant'] == 'legacy' for row in pokemon),
            'latest': sum(row['variant'] == 'latest' for row in pokemon)}))

if __name__ == '__main__':
    main()
