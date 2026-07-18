import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const standalone = resolve(root, ".next/standalone")

if (!existsSync(resolve(standalone, "server.js"))) {
  throw new Error("Standalone build is missing; run next build before preparing it")
}

function replaceDirectory(source, target) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
}

replaceDirectory(resolve(root, ".next/static"), resolve(standalone, ".next/static"))

const publicDirectory = resolve(root, "public")
if (existsSync(publicDirectory)) {
  replaceDirectory(publicDirectory, resolve(standalone, "public"))
}

console.log("Standalone runtime prepared with static and public assets")
