import globals from "globals"

const nodeGlobals = Object.fromEntries(
  Object.keys(globals.node).map(Key => [Key, "readonly"])
)
console.log(nodeGlobals)
const a
