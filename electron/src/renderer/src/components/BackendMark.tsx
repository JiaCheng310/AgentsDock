import { Bot, Code2, MousePointer2, TerminalSquare } from 'lucide-react'
import { useId } from 'react'
import type { Backend } from '@shared/types'

const BACKEND_MARK_SRC: Record<Backend, string> = {
  claude: './backend-claude.png',
  codex: './backend-codex.png',
  cursor: './backend-cursor.png',
  opencode: '',
  gemini: ''
}

export function BackendMark({ backend, size = 18 }: { backend: Backend; size?: number }) {
  const gradientId = useId()
  return (
    <span className={`backend-mark backend-${backend}`} style={{ width: size, height: size }} aria-hidden="true">
      {BACKEND_MARK_SRC[backend] && <img
        src={window.agentsDock?.sharedChat ? `/interactive-chat/assets/backend-${backend}.png` : BACKEND_MARK_SRC[backend]}
        alt=""
        draggable={false}
        onError={event => { event.currentTarget.style.display = 'none' }}
      />}
      <span className="backend-fallback">
        {backend === 'gemini' ? <svg viewBox="0 0 24 24" width={size} height={size} focusable="false" aria-hidden="true">
          <defs><linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#4285f4" /><stop offset=".5" stopColor="#9168d8" /><stop offset="1" stopColor="#d96570" />
          </linearGradient></defs>
          <path fill={`url(#${gradientId})`} d="M12 0C10.8 6.5 6.5 10.8 0 12c6.5 1.2 10.8 5.5 12 12 1.2-6.5 5.5-10.8 12-12C17.5 10.8 13.2 6.5 12 0Z" />
        </svg> : backend === 'opencode' ? <Code2 size={size - 3} /> : backend === 'codex' ? <TerminalSquare size={size - 3} /> : backend === 'cursor' ? <MousePointer2 size={size - 3} /> : <Bot size={size - 3} />}
      </span>
    </span>
  )
}
