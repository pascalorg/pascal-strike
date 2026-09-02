/** Tiny DOM helpers. No framework — the UI is small enough to build by hand. */

type Attrs = Record<string, string | number | boolean | null | undefined>
export type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  applyAttrs(node, attrs)
  append(node, children)
  return node
}

export function svg(tag: string, attrs: Attrs = {}, children: Child[] = []): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  applyAttrs(node, attrs)
  append(node, children)
  return node
}

function applyAttrs(node: Element, attrs: Attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'text') node.textContent = String(value)
    else if (key === 'html') node.innerHTML = String(value)
    else node.setAttribute(key, String(value))
  }
}

function append(node: Element, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

/** Mount point for every UI module. */
export function appRoot(): HTMLElement {
  const app = document.getElementById('app')
  if (app) return app
  const created = document.createElement('div')
  created.id = 'app'
  document.body.appendChild(created)
  return created
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/** mm:ss */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
