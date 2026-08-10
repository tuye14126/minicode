import { getErrorCode } from "./errors.js"

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MiniCode/0.1'
const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_MAX_RETRIES = 2


function formatWebErrorMessage(args: {
  url: string
  error: unknown
  timeoutMs: number
}): string {
  const code = getErrorCode(args.error)
  if (code) {
    return `request failed (${code}) for ${args.url}`
  }

  if (args.error instanceof Error && args.error.name === 'AbortError') {
    return `request timed out after ${args.timeoutMs}ms for ${args.url}`
  }

  if (args.error instanceof Error && args.error.message) {
    return `${args.error.message} (${args.url})`
  }

  return `request failed for ${args.url}`
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(ms)))
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (!code) {
    return error instanceof Error && error.name === 'AbortError'
  }

  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  )
}

async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options?: {
    timeoutMs?: number,
    maxRetries?: number
  }
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
  const target = typeof url === 'string' ? url : url.toString()
  let lastError: unknown = null
  let lastResponse: Response | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      })
      clearTimeout(timeout)
      lastResponse = response
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await sleep(300 * Math.pow(2, attempt))
        continue
      }
      return response
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
      if (attempt < maxRetries && isRetryableNetworkError(error)) {
        await sleep(300 * Math.pow(2, attempt))
        continue
      }
      throw new Error(
        formatWebErrorMessage({
          url: target,
          error,
          timeoutMs
        }),
        { cause: error }
      )

    }
  }

  if (lastResponse) {
    return lastResponse
  }
  throw new Error(
    formatWebErrorMessage({
      url: target,
      error: lastError,
      timeoutMs,
    }),
  )
}



export async function fetchWebPage(options: {
  url: string,
  maxChars: number
}) {
  const requestInit: RequestInit = {
    headers: {
      'user-agent': USER_AGENT,
      'accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  }
  let response = await fetchWithRetry(options.url, requestInit)
  let text = await response.text()
  let contentType = response.headers.get('content-type') ?? ''
  let finalUrl = response.url || options.url
  if (contentType.includes('html')) {
    const htmlRedirectUrl = extractHtmlRedirectUrl(text, finalUrl)
    if (htmlRedirectUrl && htmlRedirectUrl !== finalUrl) {
      response = await fetchWithRetry(htmlRedirectUrl, requestInit)
      text = await response.text()
      contentType = response.headers.get('content-type') ?? ''
      finalUrl = response.url || htmlRedirectUrl
    }
  }
  const maxChars = options.maxChars ?? 12000
  if (contentType.includes('html')) {
    return {
      url: options.url,
      finalUrl,
      status: response.status,
      statusText: response.statusText,
      contentType,
      title: extractTitle(text),
      content: extractReadableText(text).slice(0, maxChars),
    }
  }
  return {
    url: options.url,
    finalUrl,
    status: response.status,
    statusText: response.statusText,
    contentType,
    title: null,
    content: text.slice(0, maxChars),
  }
}








function firstMatch(pattern: RegExp, text: string, group: number = 1): string | null {
  return text.match(pattern)?.[group] ?? null
}

function extractHtmlRedirectUrl(html: string, baseUrl: string): string | null {
  const scriptRedirect =
    firstMatch(
      /window\.location(?:\.href)?(?:\.replace)?\((['"])(.*?)\1\)/iu,
      html,
      2,
    ) ??
    firstMatch(
      /window\.location(?:\.href)?\s*=\s*(['"])(.*?)\1/iu,
      html,
      2,
    )
  const metaRefresh =
    firstMatch(
      /<meta[^>]*http-equiv=(['"])refresh\1[^>]*content=(['"])[\s\S]*?url\s*=\s*('?)([^"'>;]+)\3[\s\S]*?\2[^>]*>/iu,
      html,
      4,
    ) ??
    firstMatch(
      /<meta[^>]*content=(['"])[\s\S]*?url\s*=\s*('?)([^"'>;]+)\2[\s\S]*?\1[^>]*http-equiv=(['"])refresh\4[^>]*>/iu,
      html,
      3,
    )

  const raw = decodeHtml((scriptRedirect ?? metaRefresh ?? '').trim())
  if (!raw) return null

  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return null
  }
}
function stripTags(value: string): string {
  return value.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
}
function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
  return match ? decodeHtml(stripTags(match[1] ?? '')).trim() : null
}

function extractReadableText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style[\s\S]*?<\/style>/giu, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&#x2F;/gu, '/')
    .replace(/&#47;/gu, '/')
    .replace(/&nbsp;/gu, ' ')
}