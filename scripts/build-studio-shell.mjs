import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const backend = path.join(root, "dist", "MinecraftMultiAgentStudio.exe");
const shell = path.join(root, "apps", "studio-shell");
const resource = path.join(shell, "MinecraftMultiAgentStudioBackend.exe");

try { await access(backend); } catch {
  throw new Error("Backend EXE is missing. Run `pnpm build:exe:skip-build` first.");
}
await mkdir(shell, { recursive: true });
await copyFile(backend, resource);
await run(process.platform === "win32" ? "cargo.exe" : "cargo", ["tauri", "build", "--manifest-path", path.join(shell, "Cargo.toml")], root);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
  });
}
