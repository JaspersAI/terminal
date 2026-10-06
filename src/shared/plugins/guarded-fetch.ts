// A fetch that reaches only the hosts a source declared. An empty list reaches nothing, which is what
// a plugin's start and a source without hosts get. Redirects are followed by hand, one hop at a time,
// so a declared host cannot send the request on to one that was not. Main runs built-in sources with
// it and a plugin's host runs the plugin's; nothing here needs more than the global fetch.

const MAX_REDIRECTS = 5

export function guardedFetch(hosts: string[], impl?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const send = impl ?? fetch
    const first = hrefOf(input)
    let url = new URL(first)
    let options: RequestInit | undefined = init
    for (let hop = 0; ; hop++) {
      if (!hosts.includes(url.hostname))
        throw new Error(`host not allowed: ${url.hostname}. Add it to the source's hosts.`)
      const response = await send(hop === 0 ? input : url.href, { ...options, redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location) return response
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${first}.`)
      url = new URL(location, url)
      // As browsers do: after a 303, or a 301 or 302 answering anything but GET, the next hop is a GET.
      const method = options?.method?.toUpperCase() ?? 'GET'
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET')) {
        options = { ...options, method: 'GET', body: undefined }
      }
    }
  }
}

function hrefOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}
