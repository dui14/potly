import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Copy, Check, QrCode } from 'lucide-react'
import { buildShareLink } from '@/lib/share'
import { TARGET_CHAIN_ID } from '@/config/wagmi'

export function ShareStrip({ potId }: { potId: bigint }) {
  const [url, setUrl]         = useState<string>('')
  const [copied, setCopied]   = useState(false)
  const [showQr, setShowQr]   = useState(false)

  useEffect(() => {
    buildShareLink(`/p/${TARGET_CHAIN_ID}/${potId}`).then(setUrl)
  }, [potId])

  async function copy() {
    if (!url) return
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          readOnly value={url}
          className="flex-1 bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs font-mono text-[var(--muted)] truncate"
        />
        <button
          onClick={copy}
          className="flex-shrink-0 p-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--border-strong)] transition"
          title="Copy share link"
        >
          {copied ? <Check size={15} className="text-[var(--success)]" /> : <Copy size={15} className="text-[var(--muted)]" />}
        </button>
        <button
          onClick={() => setShowQr(v => !v)}
          className="flex-shrink-0 p-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--border-strong)] transition"
          title="Show QR code"
        >
          <QrCode size={15} className="text-[var(--muted)]" />
        </button>
      </div>

      {showQr && url && (
        <div className="flex justify-center p-4 bg-white rounded-xl">
          <QRCodeSVG value={url} size={180} />
        </div>
      )}
    </div>
  )
}
