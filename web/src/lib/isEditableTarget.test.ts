import { describe, it, expect } from 'vitest'
import { isEditableTarget } from './isEditableTarget'

describe('isEditableTarget', () => {
  it('returns true for input and textarea', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true)
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
  })

  it('returns true for a contenteditable element', () => {
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    expect(isEditableTarget(div)).toBe(true)
  })

  it('returns true for a child inside a contenteditable element', () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    editor.appendChild(child)
    document.body.appendChild(editor)
    expect(isEditableTarget(child)).toBe(true)
    document.body.removeChild(editor)
  })

  it('returns false for a plain div and for null', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
