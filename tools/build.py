"""Create the Foundry installer ZIP using an explicit runtime file allow-list."""
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / "module.json").read_text(encoding="utf-8"))
assert manifest["id"] == "cpr-deadline"
assert manifest["download"].endswith(f'/v{manifest["version"]}/cpr-deadline.zip')
files = [ROOT / name for name in ("module.json", "LICENSE", "README.md")]
for folder in ("scripts", "styles", "templates"):
    files.extend(sorted((ROOT / folder).rglob("*.*")))
for name in manifest["esmodules"] + manifest["styles"]:
    assert (ROOT / name).is_file(), f"Missing declared entry: {name}"
assert all(path.is_file() for path in files)
assert not any(path.suffix in (".log", ".map") for path in files)
dist = ROOT / "dist"
dist.mkdir(exist_ok=True)
archive = dist / "cpr-deadline.zip"
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for path in files:
        info = zipfile.ZipInfo(path.relative_to(ROOT).as_posix(), (2026, 10, 16, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        output.writestr(info, path.read_bytes())
with zipfile.ZipFile(archive) as check:
    assert check.testzip() is None
    assert "module.json" in check.namelist()
    assert json.loads(check.read("module.json")) == manifest
shutil.copyfile(ROOT / "module.json", dist / "module.json")
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(dist / "SHA256SUMS.txt").write_text(f"{digest}  cpr-deadline.zip\n", encoding="utf-8")
print(f"Built {archive.name}: {archive.stat().st_size:,} bytes, {len(files)} files, sha256 {digest}")
