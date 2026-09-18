#!/usr/bin/env python3
"""
Готовит фотографии для сайта: из одного исходника делает три размера.

    python3 tools/prep-images.py ~/Photos/новые  имя-фото

Если второй аргумент не задан — обрабатывает все файлы в папке,
имя берётся из имени файла (латиницей, без пробелов).

Требуется Pillow:  pip3 install Pillow
"""
import os, sys, re
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "img")
SIZES = [("lg", 1800, 84), ("md", 900, 82), ("sm", 480, 78)]


def slugify(name):
    s = os.path.splitext(os.path.basename(name))[0].lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "photo"


def process(path, slug):
    im = Image.open(path).convert("RGB")
    for suf, mw, q in SIZES:
        c = im.copy()
        if c.width > mw:
            c.thumbnail((mw, int(mw * c.height / c.width)), Image.LANCZOS)
        c.save(os.path.join(OUT, f"{slug}-{suf}.jpg"), "JPEG",
               quality=q, optimize=True, progressive=True)
    print(f"  {slug}: {im.width}×{im.height} → lg/md/sm")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    src = os.path.expanduser(sys.argv[1])
    os.makedirs(OUT, exist_ok=True)
    if os.path.isfile(src):
        process(src, sys.argv[2] if len(sys.argv) > 2 else slugify(src))
    else:
        for f in sorted(os.listdir(src)):
            if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")) and not f.startswith("."):
                process(os.path.join(src, f), slugify(f))
    print("Готово. Имена без суффикса размера указывайте в Google-таблице.")


if __name__ == "__main__":
    main()
