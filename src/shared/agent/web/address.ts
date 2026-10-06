// Whether an IP address is one on the public internet. Main fetches pages a model chose with the
// user's own network, so an address that is loopback, private, link local, or otherwise not routed
// is refused before the request is made: the model never reaches what the user's machine can.

export function isPublicAddress(ip: string): boolean {
  const v4 = parseV4(ip)
  if (v4) return publicV4(v4)
  const v6 = parseV6(ip)
  if (!v6) return false
  // ::ffff:a.b.c.d is an IPv4 address in IPv6 clothing: judged as the IPv4.
  if (v6.slice(0, 5).every((part) => part === 0) && v6[5] === 0xffff) {
    return publicV4([v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff])
  }
  if (v6.every((part) => part === 0)) return false // ::
  if (v6.slice(0, 7).every((part) => part === 0) && v6[7] === 1) return false // ::1
  const first = v6[0]!
  if ((first & 0xfe00) === 0xfc00) return false // fc00::/7, unique local
  if ((first & 0xffc0) === 0xfe80) return false // fe80::/10, link local
  return true
}

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b! >= 64 && b! <= 127) return false // carrier NAT
  if (a === 169 && b === 254) return false
  if (a === 172 && b! >= 16 && b! <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a! >= 224) return false // multicast and reserved
  return true
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? numbers : null
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function parseV6(ip: string): number[] | null {
  if (!ip.includes(':') || !/^[0-9a-f:.]+$/i.test(ip)) return null
  // A dotted IPv4 tail becomes its two groups.
  const tail = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  let text = ip
  if (tail) {
    const v4 = parseV4(tail[2]!)
    if (!v4) return null
    text = `${tail[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): number[] | null => {
    if (part === '') return []
    const list = part.split(':').map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN))
    return list.every((n) => !Number.isNaN(n)) ? list : null
  }
  const head = groups(halves[0]!)
  const rest = halves.length === 2 ? groups(halves[1]!) : []
  if (!head || !rest) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const missing = 8 - head.length - rest.length
  if (missing < 1) return null
  return [...head, ...new Array<number>(missing).fill(0), ...rest]
}
