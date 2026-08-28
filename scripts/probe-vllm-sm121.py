from __future__ import annotations

import hashlib
import importlib
import json
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path


ARCH_PATTERN = re.compile(r"(?<![0-9A-Za-z_])(sm|compute)_([0-9]+)([a-z]?)(?![0-9A-Za-z_])")


def package_version(name: str) -> str:
    try:
        module = importlib.import_module(name)
    except Exception as error:
        return f"IMPORT_FAILED:{type(error).__name__}:{error}"
    return str(getattr(module, "__version__", "UNKNOWN"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_cuobjdump() -> str | None:
    direct = shutil.which("cuobjdump")
    if direct:
        return direct
    candidates = sorted(Path("/usr/local").rglob("cuobjdump"))
    return str(candidates[0]) if candidates else None


def command(command_line: list[str]) -> dict[str, object]:
    result = subprocess.run(command_line, capture_output=True, text=True, check=False)
    return {
        "command": command_line,
        "exitCode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def targets(text: str) -> list[str]:
    return sorted({f"{kind}_{number}{suffix}" for kind, number, suffix in ARCH_PATTERN.findall(text)})


def main() -> None:
    import torch

    cuda_available = torch.cuda.is_available()
    result: dict[str, object] = {
        "schemaVersion": "1.0",
        "machine": platform.machine(),
        "python": platform.python_version(),
        "torch": torch.__version__,
        "torchCudaRuntime": torch.version.cuda,
        "torchCudaAvailable": cuda_available,
        "torchArchList": torch.cuda.get_arch_list(),
        "vllm": package_version("vllm"),
        "transformers": package_version("transformers"),
        "nvidiaVisibleDevices": os.environ.get("NVIDIA_VISIBLE_DEVICES"),
    }
    if cuda_available:
        result["device"] = {
            "name": torch.cuda.get_device_name(0),
            "capability": list(torch.cuda.get_device_capability(0)),
            "tensorLaunch": torch.ones(1, device="cuda").cpu().tolist(),
        }

    vllm = importlib.import_module("vllm")
    vllm_root = Path(vllm.__file__).resolve().parent
    shared_objects = sorted(vllm_root.rglob("*.so"))
    cuobjdump = find_cuobjdump()
    scans: list[dict[str, object]] = []
    all_elf_targets: set[str] = set()
    all_ptx_targets: set[str] = set()
    for shared_object in shared_objects:
        scan: dict[str, object] = {
            "path": str(shared_object),
            "size": shared_object.stat().st_size,
            "sha256": sha256(shared_object),
        }
        for mode, field, aggregate in (
            ("--list-elf", "elf", all_elf_targets),
            ("--list-ptx", "ptx", all_ptx_targets),
        ):
            if cuobjdump is None:
                scan[field] = {"exitCode": None, "targets": [], "error": "cuobjdump unavailable"}
                continue
            evidence = command([cuobjdump, mode, str(shared_object)])
            combined = f"{evidence['stdout']}\n{evidence['stderr']}"
            detected = targets(combined)
            aggregate.update(detected)
            scan[field] = {
                "exitCode": evidence["exitCode"],
                "targets": detected,
                "stderr": str(evidence["stderr"]).strip(),
            }
        scans.append(scan)

    cuobjdump_version = command([cuobjdump, "--version"]) if cuobjdump else None
    result.update(
        {
            "vllmRoot": str(vllm_root),
            "cuobjdump": cuobjdump,
            "cuobjdumpVersion": cuobjdump_version,
            "sharedObjects": scans,
            "allElfTargets": sorted(all_elf_targets),
            "allPtxTargets": sorted(all_ptx_targets),
            "hasNativeSm121": any(value.startswith("sm_121") for value in all_elf_targets),
            "hasCompute121Ptx": any(
                value.startswith(("sm_121", "compute_121")) for value in all_ptx_targets
            ),
        }
    )
    print("VLLM_SM121_PROBE", json.dumps(result, ensure_ascii=False, sort_keys=True))
    if not cuda_available or result["device"]["capability"] != [12, 1] or not result["hasNativeSm121"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
