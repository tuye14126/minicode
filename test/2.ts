import { parseHTML } from "linkedom";
export { }
async function aaa(url: string) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'MiniCode/0.1' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    return `HTTP ${response.status} ${response.statusText}`
  }
  const rawText = await response.text()
  const { document } = parseHTML(rawText);

  // 删除无用节点
  document.querySelectorAll("script, style, noscript, iframe").forEach((el) => el.remove());
  // 提取纯文本
  const text = document.body.textContent ?? "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned
}
const str = await aaa("http://wltlovehy-1314.xyz")
console.log(str);

