import globals from "globals"
// const nodeGlobals = Object.fromEntries(
//   Object.keys(globals.node).map(Key => [Key, "readonly"])
// )
// console.log(nodeGlobals)
const arr = [1, 2, 3, 4, 5]
console.log(arr.map(v => {
  return `我去${v}`
}));

// console.log(process.platform);

