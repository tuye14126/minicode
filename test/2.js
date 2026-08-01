import { readdirSync } from "node:fs"


const arr = readdirSync(process.cwd())
console.log(arr)