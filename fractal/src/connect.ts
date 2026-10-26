// `fractal connect`: the device-code sign-in, as streams' `/streams connect`. The service gives a code and a page;
// the person signs in there (GitHub or an email link) and confirms the code; the client's next poll gets its token.
import { ApiError, retryable, retryDelay, type Api } from './protocol'

export async function connect(api: Api, o: { label: string; open?: (url: string) => void; onLine?: (s: string) => void; sleep?: (ms: number) => Promise<void> }) {
  const c = await api.connect(o.label)
  const say = o.onLine ?? (() => {})
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  say(`Open ${c.url}, check it shows ${c.code}, then sign in with GitHub or email.`)
  o.open?.(c.url)
  const until = Date.now() + c.expiresIn * 1000
  let blips = 0
  while (Date.now() < until) {
    await sleep(c.interval * 1000)
    let got
    try {
      got = await api.connectToken(c.device)
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) break
      if (!retryable(e)) throw e
      await sleep(retryDelay(e, blips++))   // a blip or a rate limit: waited out while the code lasts
      continue
    }
    if (got) return got
  }
  throw new Error('the sign-in code expired: run `fractal connect` again')
}
