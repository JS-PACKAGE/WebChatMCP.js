"""Edit only WebChatMCP's named endpoint using Hermes's existing round-trip YAML parser."""
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

from ruamel.yaml import YAML
from ruamel.yaml.resolver import VersionedResolver
from ruamel.yaml.scalarstring import DoubleQuotedScalarString


class Yaml11Resolver(VersionedResolver):
    @property
    def processing_version(self):
        return (1, 1)

MARK = ".webchatmcp-hermes-installed"


def atomic_write(file, text):
    target = file.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix=".webchatmcp-", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def configure(options):
    file = Path(options["home"]) / "config.yaml"
    marker = Path(options["home"]) / MARK
    stamp = marker.read_text(encoding="utf-8") if marker.exists() else ""
    try:
        installation = json.loads(stamp) if stamp else {}
    except ValueError:
        installation = {}
    if not file.exists() and options["action"] == "uninstall":
        return {"configFile": str(file), "removed": False}
    yaml = YAML(typ="rt")
    yaml.Resolver = Yaml11Resolver
    yaml.preserve_quotes = True
    yaml.width = 2**31 - 1
    yaml.indent(mapping=2, sequence=4, offset=2)
    try:
        config = yaml.load(file.read_text(encoding="utf-8")) if file.exists() else {}
    except Exception:
        # YAML parser errors may quote credential-bearing source lines.
        raise ValueError("Hermes config.yaml 無法解析；沒有修改設定") from None
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("Hermes config.yaml 必須是 mapping；沒有修改設定")
    providers = config.get("providers")
    if providers is None:
        providers = {}
    if not isinstance(providers, dict):
        raise ValueError("Hermes providers 必須是 mapping；沒有修改設定")
    previous = providers.get("webchat")
    owned = (isinstance(previous, dict) and installation.get("owner") == options["owner"]
             and installation.get("url") == previous.get("base_url"))
    if options["action"] == "uninstall":
        if not owned:
            return {"configFile": str(file), "removed": False}
        del providers["webchat"]
    else:
        if "webchat" in providers and not owned and not options.get("force"):
            raise ValueError("providers.webchat 已存在而且不是本腳本安裝的；確認後加 --force 取代")
        models = options["models"]
        # The SDK supplies its own no-key-required placeholder; do not declare credential fields.
        entry = {
            "name": "WebChat (WebChatMCP)",
            "base_url": DoubleQuotedScalarString(options["url"]),
            "api_mode": "chat_completions",
            "default_model": models[0],
            "models": models,
            "models_discovered": True,
        }
        if owned and previous.get("default_model") in models:
            entry["default_model"] = previous["default_model"]
        providers["webchat"] = entry
    config["providers"] = providers
    output = io.StringIO()
    yaml.dump(config, output)
    if options["action"] == "install":
        if stamp and installation.get("owner") != options["owner"] and not options.get("force"):
            raise ValueError("Hermes 安裝標記不是本腳本建立的；確認後加 --force 取代")
        atomic_write(marker, json.dumps({"owner": options["owner"], "url": options["url"]}))
        try:
            atomic_write(file, output.getvalue())
        except Exception:
            if stamp:
                atomic_write(marker, stamp)
            else:
                marker.unlink()
            raise
    else:
        atomic_write(file, output.getvalue())
        marker.unlink()
    return {"configFile": str(file), "removed": options["action"] == "uninstall"}


if __name__ == "__main__":
    try:
        print(json.dumps(configure(json.load(sys.stdin))))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Hermes 設定更新失敗；請確認 config.yaml 的存取權限", file=sys.stderr)
        sys.exit(1)
