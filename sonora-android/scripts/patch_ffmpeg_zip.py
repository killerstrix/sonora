"""Copia libffmpeg.zip.so sustituyendo algunas librerías y conservando enlaces simbólicos y permisos.

Uso: patch_ffmpeg_zip.py <zip original> <carpeta con las librerías nuevas> <zip de salida>
Solo se sustituyen las entradas usr/lib/<nombre> cuyo <nombre> existe en la carpeta.
"""

import sys
import zipfile
from pathlib import Path

src, libs, dst = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
replace = {p.name: p for p in libs.iterdir() if p.is_file()}
done = set()

with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst.with_suffix(".tmp"), "w") as zout:
    for info in zin.infolist():
        name = info.filename.removeprefix("usr/lib/")
        is_link = (info.external_attr >> 16) & 0o170000 == 0o120000
        if name in replace and not is_link:
            data = replace[name].read_bytes()
            done.add(name)
        else:
            data = zin.read(info)
        zout.writestr(info, data, compress_type=info.compress_type)

missing = set(replace) - done
if missing:
    dst.with_suffix(".tmp").unlink()
    sys.exit(f"No están en el zip: {', '.join(sorted(missing))}")
dst.with_suffix(".tmp").replace(dst)
print(f"Sustituidas {len(done)} librerías en {dst.name}")
