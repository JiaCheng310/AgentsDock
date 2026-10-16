import { render, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { BackendMark } from './BackendMark'

afterEach(cleanup)
it('renders a Gemini sparkle with unique gradients instead of the generic bot', () => {
  const { container } = render(<><BackendMark backend="gemini" /><BackendMark backend="gemini" /></>)
  const gradients = [...container.querySelectorAll('linearGradient')]
  expect(gradients).toHaveLength(2)
  expect(gradients[0].id).not.toBe(gradients[1].id)
  expect(container.querySelector('.lucide-bot')).toBeNull()
  expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2)
})
