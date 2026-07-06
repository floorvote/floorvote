import '@testing-library/jest-dom'

// IntersectionObserver: used by Overview's infinite-scroll. jsdom doesn't ship one.
if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  ;(globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
    root = null
    rootMargin = ''
    thresholds = []
  }
}

// Chart.js requires a canvas implementation. jsdom doesn't ship one,
// so we stub getContext to return a minimal 2D context mock.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = () => ({
    canvas: {},
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    arc: () => {},
    arcTo: () => {},
    ellipse: () => {},
    rect: () => {},
    fill: () => {},
    stroke: () => {},
    clip: () => {},
    scale: () => {},
    rotate: () => {},
    translate: () => {},
    transform: () => {},
    setTransform: () => {},
    resetTransform: () => {},
    save: () => {},
    restore: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => ({}),
    measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
    drawImage: () => {},
    putImageData: () => {},
    getImageData: () => ({ data: [] }),
    createImageData: () => ({ data: [] }),
    setLineDash: () => {},
    getLineDash: () => [],
    fillText: () => {},
    strokeText: () => {},
    isPointInPath: () => false,
    isPointInStroke: () => false,
  } as any)
}
