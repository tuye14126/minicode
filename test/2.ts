import path from "node:path";


let cursor = path.resolve(process.cwd())
while (true) {
  console.log(cursor);
  const parent = path.dirname(cursor)
  if (parent === cursor) break
  cursor = parent
}