import React from 'react'
import { useVerticalResize, ResizeHandle } from './ResizeHandle'
import { color, radius, fontSize } from '../styles/tokens'

interface ResizableTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  initialHeight?: number
  minHeight?: number
}

export function ResizableTextarea({ initialHeight = 80, minHeight = 40, style, ...rest }: ResizableTextareaProps) {
  const { height, handlePointerDown } = useVerticalResize(initialHeight, minHeight)

  return (
    <div style={{ border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, overflow: 'hidden' }}>
      <textarea
        {...rest}
        style={{
          display: 'block', width: '100%', height,
          border: 'none', outline: 'none',
          padding: 10, resize: 'none',
          overflow: 'auto', boxSizing: 'border-box',
          fontFamily: 'inherit', fontSize: fontSize.sm, background: color.white,
          ...style,
        }}
      />
      <ResizeHandle onPointerDown={handlePointerDown} />
    </div>
  )
}
