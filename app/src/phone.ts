// Phone-side companion screen (the WebView the Even Realities App shows on the phone).
// Settings, a typed command box (same pipeline as voice - handy in the simulator), and a live mirror.
import type { Prefs, Snapshot, Proposal, Card } from './api'

export interface PhoneHooks {
  savePrefs(p: Partial<Prefs>): Promise<void>
  command(text: string): Promise<void>
  tap(): void
  back(): void
  next(): void
  prev(): void
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export function mountPhone(h: PhoneHooks, getPrefs: () => Prefs) {
  const form = $<HTMLFormElement>('prefs')
  form.addEventListener('submit', e => {
    e.preventDefault()
    const fd = new FormData(form)
    void h.savePrefs({
      watch: String(fd.get('watch') ?? '').toUpperCase().replace(/\s+/g, ''),
      coin: String(fd.get('watch') ?? 'BTC').split(',')[0].trim().toUpperCase() || 'BTC',
      hl: String(fd.get('hl') ?? '').trim(),
      wallet: String(fd.get('wallet') ?? '').trim(),
    })
  })
  const cmd = $<HTMLFormElement>('cmd')
  cmd.addEventListener('submit', e => {
    e.preventDefault()
    const input = cmd.querySelector('input')!
    if (input.value.trim()) void h.command(input.value.trim())
    input.value = ''
  })
  document.querySelectorAll<HTMLButtonElement>('[data-gesture]').forEach(b =>
    b.addEventListener('click', () => (h as unknown as Record<string, () => void>)[b.dataset.gesture!]()),
  )

  return {
    loadPrefs(p: Prefs) {
      ;(form.elements.namedItem('watch') as HTMLInputElement).value = p.watch
      ;(form.elements.namedItem('hl') as HTMLInputElement).value = p.hl
      ;(form.elements.namedItem('wallet') as HTMLInputElement).value = p.wallet
    },
    update(s: { snap: Snapshot | null; mode: string; card: Card; pending: Proposal | null; toast?: string }) {
      const snap = s.snap
      $('mirror').textContent = snap ? `${snap.headers[s.card]}\n\n${s.pending && s.mode === 'confirm' ? s.pending.prompt : snap.cards[s.card].body}` : 'connecting…'
      if (snap) {
        const c = snap.config
        $('chips').innerHTML = [
          `<span class="chip ${c.executor === 'paper' ? 'ok' : 'warn'}">${c.executor === 'paper' ? 'PAPER mode' : 'HL TESTNET'}</span>`,
          `<span class="chip ${c.telegram ? 'ok' : ''}">Telegram ${c.telegram ? (c.telegramDemo ? 'demo' : `live · ${c.linkedChats} linked`) : 'off'}</span>`,
          `<span class="chip ${c.stt ? 'ok' : ''}">Voice ${c.stt ? 'on' : 'off'}</span>`,
        ].join('')
        $('pair').textContent = c.pairCode
        $('log').innerHTML = snap.log.map(l => `<li>${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${escapeHtml(l.text)}</li>`).join('')
      }
      $('mode').textContent = `${s.mode} · ${s.card} · ${getPrefs().coin}${s.toast ? ` · ${s.toast}` : ''}`
    },
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
