"""Download the orchestra samples the sampler uses: VSCO 2 Community Edition (CC0, ~1.7 GB of the full set).

    python3 fetch_samples.py [target]        # default: $VSCO or ~/vsco

A sparse, blob-less git clone that only pulls the instruments the battle band plays. Needs git.
"""
import os
import subprocess
import sys

PATHS = [
    'Brass/Trumpet/sus/', 'Brass/Trumpet/stac/', 'Brass/F Horn/sus/', 'Brass/F Horn/stac/',
    'Brass/Tenor Trombone/sus/', 'Brass/Tenor Trombone/stac/', 'Brass/Tuba/sus/', 'Brass/Tuba/stac/',
    'Strings/Violin Section/Spic/', 'Strings/Violin Section/susVib/', 'Strings/Violin Section/Trem/',
    'Strings/Viola Section/spic/', 'Strings/Viola Section/susvib/', 'Strings/Cello Section/spic/', 'Strings/Cello Section/susvib/',
    'Strings/Solo Contrabass/Spic/', 'Strings/Solo Contrabass/SusVib/', 'Percussion/Timpani/',
    'VSCO 1 Percussion/drums/snare/', 'VSCO 1 Percussion/drums/bass/', 'VSCO 1 Percussion/varMetal/Cymbals/', 'VSCO 1 Percussion/varMetal/Gong/',
]


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('VSCO', os.path.expanduser('~/vsco'))
    if os.path.isdir(os.path.join(target, 'Brass')):
        print(f'samples already at {target}')
        return
    run = lambda *a, **k: subprocess.run(list(a), check=True, **k)
    run('git', 'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', 'https://github.com/sgossner/VSCO-2-CE.git', target)
    run('git', 'sparse-checkout', 'init', '--no-cone', cwd=target)
    run('git', 'sparse-checkout', 'set', '--no-cone', *[f'/{p}' for p in PATHS], cwd=target)
    run('git', 'checkout', cwd=target)
    print(f'samples at {target}; set VSCO={target} if that is not ~/vsco')


if __name__ == '__main__':
    main()
